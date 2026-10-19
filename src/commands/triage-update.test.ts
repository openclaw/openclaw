import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeTriageUpdateFailure } from "../infra/update-failure-report-artifact.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { readTriageUpdateFailure } from "./triage-update.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type Failure = Parameters<typeof writeTriageUpdateFailure>[0];
type Result = Extract<Failure, { result: unknown }>["result"];
type Plugins = NonNullable<NonNullable<Result["postUpdate"]>["plugins"]>;

describe("update failure triage diagnostics", () => {
  let home: string;
  let stateDir: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    home = tempDirs.make("openclaw-update-triage-");
    stateDir = path.join(home, ".openclaw");
    env = { HOME: home, OPENCLAW_STATE_DIR: stateDir };
  });
  const write = async (input: Failure) => {
    const outputPath = await writeTriageUpdateFailure(input, { env });
    return {
      outputPath,
      raw: await fs.readFile(outputPath, "utf8"),
      failure: await readTriageUpdateFailure(outputPath, { env, stateDir }),
    };
  };
  const writePlugins = (plugins: Plugins) =>
    write({
      result: {
        status: "error",
        mode: "npm",
        reason: "post-update-plugins",
        steps: [],
        postUpdate: { plugins },
      },
    });

  it("writes bounded sanitized failure evidence without changing the result", async () => {
    const secret = "sk-test-update-triage-secret-1234567890";
    const result: UpdateRunResult = {
      runId: "10000000-0000-4000-8000-000000000001",
      status: "error",
      mode: "npm",
      root: path.join(home, "npm", "openclaw"),
      reason: "Package install failed",
      before: { version: "2026.8.1" },
      recovery: {
        serviceRestartSafe: true,
        version: "2026.8.1",
        buildId: "verified-recovery-build",
        service: "healthy",
      },
      durationMs: 10,
      steps: Array.from({ length: 5 }, (_, index) => ({
        name: `step-${index}`,
        command: `unredacted-command --token ${secret}`,
        cwd: home,
        durationMs: 1,
        exitCode: index === 0 ? 0 : 1,
        stdoutTail:
          index === 1
            ? null
            : `${"Earlier build output\n".repeat(100)}The compiler reported the actual failure on stdout`,
        stderrTail: `PackageUpdateSwapError: token=${secret}\n${"🦞".repeat(8_000)} ${stateDir}/npm.log recovery is unverified token=${secret}`,
        failureFacts: [
          {
            check: "core/doctor/runtime-tool-schemas",
            code: "doctor-failed",
            affectedKey: "mcp.servers",
            message: `Cannot expose runtime tools: token=${secret}`,
          },
        ],
        advisory:
          index === 4
            ? { kind: "package-post-install-doctor" as const, message: "Non-failure update advice" }
            : undefined,
      })),
    };

    const { outputPath, raw, failure } = await write({ result });

    expect(outputPath.startsWith(path.join(stateDir, "logs", "support"))).toBe(true);
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(8 * 1024);
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain(home);
    expect(raw).not.toContain("unredacted-command");
    expect(raw).toContain("core/doctor/runtime-tool-schemas");
    expect(raw).toContain("mcp.servers");
    expect(raw).not.toContain("\uFFFD");
    expect(failure).toMatchObject({
      result: {
        runId: result.runId,
        reason: "Package install failed",
        before: { version: "2026.8.1" },
        recovery: result.recovery,
      },
    });
    expect("result" in failure && failure.result.steps.map((step) => step.name)).toEqual([
      "step-1",
      "step-2",
      "step-3",
    ]);
    expect(raw).toContain("actual failure on stdout");
    expect(raw).toContain("npm.log");
    expect(raw).toContain("PackageUpdateSwapError");
    expect(raw).toContain("recovery is unverified");
    expect(raw).toContain("...");
    expect(raw).not.toContain("step-4");
    expect(result.steps).toHaveLength(5);
    expect(result.steps[0]?.command).toContain(secret);
    if (process.platform !== "win32") {
      expect((await fs.stat(outputPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("preserves a post-install activation error even when the core update succeeded", async () => {
    const failure = {
      result: {
        status: "ok" as const,
        mode: "git" as const,
        after: { version: "2026.9.1" },
        recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
        steps: [],
      },
      error: `Gateway activation failed ${"intermediate context ".repeat(100)}terminal recovery cause`,
    };
    const { failure: recorded } = await write(failure);
    expect(recorded).toMatchObject({ result: failure.result });
    expect(recorded.error).toContain("Gateway activation failed");
    expect(recorded.error).toContain("terminal recovery cause");
  });

  it("retains actual plugin sync and npm errors after a successful core replacement", async () => {
    const { raw, failure } = await writePlugins({
      status: "error",
      sync: { errors: ["Configured plugin package is unavailable"] },
      npm: {
        outcomes: [
          {
            pluginId: "fixture-ok",
            status: "updated",
            message: "Updated successfully",
          },
          {
            pluginId: "fixture-failed",
            status: "error",
            message: "Plugin dependency resolution failed",
          },
        ],
      },
    });

    expect(raw).toContain("Configured plugin package is unavailable");
    expect(raw).toContain("Plugin dependency resolution failed");
    expect(raw).not.toContain("fixture-ok");
    expect(failure).toMatchObject({
      result: { reason: "post-update-plugins" },
    });
  });

  it("reserves the terminal plugin warning before earlier errors exhaust the diagnostic budget", async () => {
    const { failure: recorded } = await writePlugins({
      status: "error",
      sync: {
        errors: ["Earlier failure one", "Earlier failure two", "Earlier failure three"],
      },
      warnings: [{ reason: "Terminal Doctor failure", message: "Refusing to restart" }],
    });

    expect(recorded).toMatchObject({
      omittedDetails: 1,
      result: {
        postUpdate: {
          plugins: {
            sync: { errors: ["Earlier failure one", "Earlier failure two"] },
            warnings: [{ reason: "Terminal Doctor failure", message: "Refusing to restart" }],
          },
        },
      },
    });
  });

  it.each([
    { name: "invalid JSON", input: "not-json", error: "Invalid update failure diagnostics JSON" },
    {
      name: "successful result without an error",
      input: JSON.stringify({ result: { status: "ok", mode: "npm", steps: [] } }),
      error: "expected a failed result or error",
    },
  ])("rejects $name diagnostic input", async ({ input, error }) => {
    const inputPath = path.join(home, "failure.json");
    await fs.writeFile(inputPath, input);

    await expect(readTriageUpdateFailure(inputPath, { env: {}, stateDir })).rejects.toThrow(error);
  });
});
