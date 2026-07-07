// E2E coverage for the staged Claw lifecycle CLI flow.
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

async function runOpenClaw(args: string[], options?: { expectFailure?: boolean }) {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-claws-lifecycle-e2e-"));
  const env = {
    ...process.env,
    HOME: stateDir,
    USERPROFILE: stateDir,
    OPENCLAW_CONFIG_PATH: join(stateDir, "openclaw.json"),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_HOME: stateDir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_TEST_FAST: "1",
    OPENCLAW_TEST_RUNTIME_LOG: "1",
    VITEST: "",
  };
  try {
    const result = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "src/entry.ts", ...args],
      {
        cwd: process.cwd(),
        env,
        maxBuffer: 1024 * 1024,
      },
    );
    if (options?.expectFailure) {
      throw new Error(`expected command to fail: ${args.join(" ")}`);
    }
    return { ok: true as const, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (!options?.expectFailure) {
      throw error;
    }
    const failed = error as Error & { stdout?: string; stderr?: string; code?: number };
    return {
      ok: false as const,
      code: failed.code,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
}

function parseJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  expect(trimmed.length).toBeGreaterThan(0);
  return JSON.parse(trimmed);
}

describe("claws lifecycle cli e2e", () => {
  it("runs inspect, plan, and dry-run apply for a local Claw manifest", async () => {
    const manifestPath = "src/claws/fixtures/incident-response.claw.json";

    const inspect = parseJson(
      (await runOpenClaw(["claws", "inspect", manifestPath, "--json"])).stdout,
    );
    expect(inspect).toMatchObject({
      valid: true,
      manifest: { id: "incident-response", entries: expect.any(Array) },
    });

    const plan = parseJson(
      (await runOpenClaw(["claws", "plan", manifestPath, "--json"])).stdout,
    );
    expect(plan).toMatchObject({
      schemaVersion: "openclaw.clawPlan.v1",
      readOnly: true,
      summary: { totalEntries: 5, requiresConsent: 2, unsupportedRequiredEntries: 0 },
    });

    const apply = parseJson(
      (await runOpenClaw(["claws", "apply", manifestPath, "--dry-run", "--json"])).stdout,
    );
    expect(apply).toMatchObject({
      schemaVersion: "openclaw.clawApplyPlan.v1",
      dryRun: true,
      mutationAllowed: false,
      summary: {
        totalEntries: 5,
        installActions: 5,
        consentRequired: 2,
        blockedEntries: 0,
        provenanceRecords: 5,
        rollbackActions: 5,
      },
    });
  });

  it("runs feed plan and feed dry-run apply from the local feed fixture", async () => {
    const feedPath = "src/claws/fixtures/local-claws.feed.json";

    const plan = parseJson(
      (await runOpenClaw(["claws", "feed", "plan", feedPath, "incident-response", "--json"]))
        .stdout,
    );
    expect(plan).toMatchObject({
      schemaVersion: "openclaw.clawPlan.v1",
      feed: { id: "local-starter-claws", entry: { id: "incident-response" } },
      summary: { totalEntries: 5, requiresConsent: 2 },
    });

    const apply = parseJson(
      (
        await runOpenClaw([
          "claws",
          "feed",
          "apply",
          feedPath,
          "incident-response",
          "--dry-run",
          "--json",
        ])
      ).stdout,
    );
    expect(apply).toMatchObject({
      schemaVersion: "openclaw.clawApplyPlan.v1",
      dryRun: true,
      mutationAllowed: false,
      feed: { id: "local-starter-claws", entry: { id: "incident-response" } },
      summary: { totalEntries: 5, consentRequired: 2, blockedEntries: 0 },
    });
  });

  it("fails closed when apply is invoked without --dry-run", async () => {
    const result = await runOpenClaw(
      ["claws", "apply", "src/claws/fixtures/incident-response.claw.json"],
      { expectFailure: true },
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Claw apply is dry-run only");
  });
});
