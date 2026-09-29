// E2E coverage for experimental grouped Claw inspection and add planning.
import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function runOpenClaw(
  args: string[],
  options?: { expectFailure?: boolean; stateDir?: string },
) {
  const stateDir = options?.stateDir ?? tempDirs.make("openclaw-claws-lifecycle-e2e-");
  const env = {
    ...process.env,
    HOME: stateDir,
    USERPROFILE: stateDir,
    OPENCLAW_CONFIG_PATH: join(stateDir, "openclaw.json"),
    OPENCLAW_EXPERIMENTAL_CLAWS: "1",
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_HOME: stateDir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_TEST_FAST: "1",
    OPENCLAW_TEST_RUNTIME_LOG: "1",
    VITEST: "",
  };
  try {
    const result = await execFileAsync(process.execPath, ["openclaw.mjs", ...args], {
      cwd: process.cwd(),
      env,
      maxBuffer: 1024 * 1024,
    });
    if (options?.expectFailure) {
      throw new Error(`expected command to fail: ${args.join(" ")}`);
    }
    return { ok: true as const, stdout: result.stdout, stderr: result.stderr, stateDir };
  } catch (error) {
    if (!options?.expectFailure) {
      const failed = error as Error & { stdout?: string; stderr?: string };
      throw new Error(
        `${failed.message}\nstdout:\n${failed.stdout ?? ""}\nstderr:\n${failed.stderr ?? ""}`,
        { cause: error },
      );
    }
    const failed = error as Error & { stdout?: string; stderr?: string; code?: number };
    return {
      ok: false as const,
      code: failed.code,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
      stateDir,
    };
  }
}

function parseJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  expect(trimmed.length).toBeGreaterThan(0);
  return JSON.parse(trimmed);
}

describe("claws lifecycle cli e2e", () => {
  const manifestPath = "src/claws/fixtures/incident-response.claw.json";

  it("inspects a grouped development manifest", async () => {
    const inspect = parseJson(
      (await runOpenClaw(["claws", "inspect", manifestPath, "--json"])).stdout,
    );

    expect(inspect).toMatchObject({
      schemaVersion: "openclaw.clawInspect.v1",
      stability: "experimental",
      valid: true,
      source: { kind: "development", version: "0.0.0-development" },
      manifest: {
        schemaVersion: 1,
        agent: { id: "incident-response" },
        packages: expect.any(Array),
      },
      openClawProfile: {
        schemaVersion: 1,
        agent: {
          tools: { allow: ["read", "write", "web_fetch"], deny: ["exec", "browser"] },
          heartbeat: { every: "30m", isolatedSession: true, timeoutSeconds: 120 },
        },
      },
    });
  });

  it("reports and removes a Claw-created agent through plan-first lifecycle commands", async () => {
    const instance = await createOpenClawTestInstance({
      name: "claws-lifecycle-remove",
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_EXPERIMENTAL_CLAWS: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });
    await runQaGatewayFixture(
      async () => {
        const run = async (args: string[]) => {
          const result = await instance.cli(args);
          expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
          return result;
        };
        const addPreview = await run([
          "claws",
          "add",
          "src/claws/fixtures/workspace-agent.claw.json",
          "--dry-run",
          "--json",
        ]);
        const addPlan = parseJson(addPreview.stdout) as { planIntegrity: string };
        await run([
          "claws",
          "add",
          "src/claws/fixtures/workspace-agent.claw.json",
          "--yes",
          "--plan-integrity",
          addPlan.planIntegrity,
          "--json",
        ]);
        await instance.startGateway();
        const status = await run(["claws", "status", "workspace-agent", "--json"]);
        expect(parseJson(status.stdout)).toMatchObject({
          schemaVersion: "openclaw.clawStatus.v1",
          summary: { claws: 1, driftedFiles: 0 },
          records: [{ install: { agentId: "workspace-agent" }, agentState: "present" }],
        });

        const preview = await run(["claws", "remove", "workspace-agent", "--dry-run", "--json"]);
        const removePlan = parseJson(preview.stdout) as { planIntegrity: string };
        expect(removePlan).toMatchObject({
          schemaVersion: "openclaw.clawRemovePlan.v1",
          mutationAllowed: false,
          agentId: "workspace-agent",
          blockers: [],
        });

        const removed = await run([
          "claws",
          "remove",
          "workspace-agent",
          "--yes",
          "--plan-integrity",
          removePlan.planIntegrity,
          "--json",
        ]);
        expect(parseJson(removed.stdout)).toMatchObject({
          schemaVersion: "openclaw.clawRemoveResult.v1",
          status: "complete",
          agentId: "workspace-agent",
          agentRemoved: true,
        });
        const config = JSON.parse(await readFile(instance.configPath, "utf8"));
        const canonicalStateDir = await realpath(instance.stateDir);
        expect(config.agents).toEqual({
          defaults: {
            heartbeat: { agentId: "main" },
            systemAgent: { agentId: "main" },
          },
          entries: { main: { workspace: join(canonicalStateDir, "workspace") } },
        });
      },
      () => instance.cleanup(),
    );
  });

  it("exports an installed agent as a self-contained grouped package", async () => {
    const source = "src/claws/fixtures/workspace-agent.claw.json";
    const addPreview = await runOpenClaw(["claws", "add", source, "--dry-run", "--json"]);
    const addPlan = parseJson(addPreview.stdout) as { planIntegrity: string };
    const added = await runOpenClaw(
      ["claws", "add", source, "--yes", "--plan-integrity", addPlan.planIntegrity, "--json"],
      { stateDir: addPreview.stateDir },
    );
    const outputDirectory = join(added.stateDir, "exported-claw");
    const exported = await runOpenClaw(
      ["claws", "export", "workspace-agent", "--out", outputDirectory, "--json"],
      { stateDir: added.stateDir },
    );
    expect(parseJson(exported.stdout)).toMatchObject({
      schemaVersion: "openclaw.clawExportResult.v1",
      stability: "experimental",
      agentId: "workspace-agent",
      outputDirectory,
      manifest: {
        schemaVersion: 1,
        agent: { id: "workspace-agent" },
        workspace: {
          bootstrapFiles: {
            "HEARTBEAT.md": { source: "workspace/HEARTBEAT.md" },
          },
          files: [
            {
              source: "workspace/reference/policy.md",
              path: "reference/policy.md",
            },
          ],
        },
      },
    });
    expect(JSON.parse(await readFile(join(outputDirectory, "package.json"), "utf8"))).toMatchObject(
      {
        name: "openclaw-claw-workspace-agent",
        version: expect.stringMatching(/^0\.0\.0-export\.[0-9a-f]{64}$/),
        type: "module",
      },
    );
    await expect(readFile(join(outputDirectory, "CLAW.md"), "utf8")).resolves.toContain(
      "Incident Response",
    );
    const inspected = await runOpenClaw(["claws", "inspect", outputDirectory, "--json"]);
    expect(parseJson(inspected.stdout)).toMatchObject({
      valid: true,
      source: { kind: "package" },
      manifest: { agent: { id: "workspace-agent" } },
    });
    const roundTripPreview = await runOpenClaw([
      "claws",
      "add",
      outputDirectory,
      "--dry-run",
      "--json",
    ]);
    const roundTripPlan = parseJson(roundTripPreview.stdout) as { planIntegrity: string };
    const roundTrip = await runOpenClaw(
      [
        "claws",
        "add",
        outputDirectory,
        "--yes",
        "--plan-integrity",
        roundTripPlan.planIntegrity,
        "--json",
      ],
      { stateDir: roundTripPreview.stateDir },
    );
    expect(parseJson(roundTrip.stdout)).toMatchObject({
      status: "complete",
      claw: { kind: "package" },
      agent: { finalId: "workspace-agent" },
      workspaceFiles: [
        expect.objectContaining({ path: "SOUL.md" }),
        expect.objectContaining({ path: "HEARTBEAT.md" }),
        expect.objectContaining({ path: "reference/policy.md" }),
      ],
    });
  });
});
