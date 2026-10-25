import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
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
  const write = async (result: Partial<Result>, error?: string) => {
    const outputPath = await writeTriageUpdateFailure(
      { result: { status: "error", mode: "npm", steps: [], ...result }, error },
      { env },
    );
    return {
      outputPath,
      raw: await fs.readFile(outputPath, "utf8"),
      failure: await readTriageUpdateFailure(outputPath, { env, stateDir }),
    };
  };
  const writePlugins = (plugins: Plugins) =>
    write({ reason: "post-update-plugins", postUpdate: { plugins } });

  it("omits whole words when bounding the swap cause and recovery advice", async () => {
    const { raw, failure } = await write({
      steps: [
        {
          name: "global install swap",
          exitCode: 1,
          stderrTail: `Package rollback verification timed out. ${"diagnostic context ".repeat(30)}Installation recovery is unverified; inspect the installation and backups before restarting.`,
        },
      ],
    });
    expect(raw).toContain("Package rollback verification timed out.");
    const detail = "result" in failure ? failure.result.steps[0]?.stderrTail : undefined;
    expect(detail).toContain(" ... ");
    const [head, tail] = detail!.split(" ... ");
    expect(head).toMatch(/(?:timed out\.|diagnostic|context)$/u);
    expect(tail).toMatch(
      /^(?:diagnostic|context|Installation|recovery|is|unverified;|inspect|the|installation|and|backups|before|restarting\.)\b/u,
    );
  });

  it.runIf(process.platform !== "win32")("rejects a writerless FIFO without blocking", async () => {
    // This directory must outlive afterEach so the deadline cleanup can release the FIFO.
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-triage-fifo-"));
    const inputPath = path.join(directory, "failure.fifo");
    execFileSync("mkfifo", [inputPath]);
    const reading = readTriageUpdateFailure(inputPath, { env, stateDir });
    onTestFinished(async () => {
      // Release a regressed blocking open after the deadline so cleanup can finish.
      const release = await fs.open(inputPath, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
      try {
        await reading.catch(() => undefined);
      } finally {
        await release.close();
        await fs.rm(directory, { recursive: true, force: true });
      }
    });
    await expect(reading).rejects.toThrow("Update failure diagnostics must be a regular file.");
    expect((await fs.lstat(inputPath)).isFIFO()).toBe(true);
  });

  it.runIf(process.platform !== "win32")(
    "reads a symlink to a regular failure artifact",
    async () => {
      const inputPath = path.join(home, "failure.json");
      const linkPath = path.join(home, "failure-link.json");
      await fs.writeFile(inputPath, JSON.stringify({ error: "synthetic update failure" }));
      await fs.symlink(inputPath, linkPath);
      await expect(readTriageUpdateFailure(linkPath, { env, stateDir })).resolves.toEqual({
        error: "synthetic update failure",
      });
    },
  );

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
        stdoutTail: index === 1 ? null : `${"output\n".repeat(300)}stdout failure`,
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

    const { outputPath, raw, failure } = await write(result);

    expect(outputPath.startsWith(path.join(stateDir, "logs", "support"))).toBe(true);
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(8 * 1024);
    for (const excluded of [secret, home, "unredacted-command", "\uFFFD", "step-4"]) {
      expect(raw).not.toContain(excluded);
    }
    expect(failure).toMatchObject({
      result: {
        runId: result.runId,
        reason: "Package install failed",
        before: { version: "2026.8.1" },
        recovery: result.recovery,
        steps: [{ name: "step-1" }, { name: "step-2" }, { name: "step-3" }],
      },
    });
    for (const included of [
      "core/doctor/runtime-tool-schemas",
      "mcp.servers",
      "stdout failure",
      "npm.log",
      "PackageUpdateSwapError",
      "recovery is unverified",
      "...",
    ]) {
      expect(raw).toContain(included);
    }
    expect(result.steps).toHaveLength(5);
    expect(result.steps[0]?.command).toContain(secret);
    if (process.platform !== "win32") {
      expect((await fs.stat(outputPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("preserves a post-install activation error even when the core update succeeded", async () => {
    const result: Result = {
      status: "ok",
      mode: "git",
      after: { version: "2026.9.1" },
      recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      steps: [],
    };
    const { failure: recorded } = await write(
      result,
      `Gateway activation failed ${"intermediate context ".repeat(100)}terminal recovery cause`,
    );
    expect(recorded).toMatchObject({ result });
    expect(recorded.error).toContain("Gateway activation failed");
    expect(recorded.error).toContain("terminal recovery cause");
  });

  it("retains actual plugin sync and npm errors after a successful core replacement", async () => {
    const { raw, failure } = await writePlugins({
      status: "error",
      sync: { errors: ["Plugin sync failed"] },
      npm: {
        outcomes: [
          { pluginId: "fixture-ok", status: "updated", message: "Updated" },
          { pluginId: "fixture-failed", status: "error", message: "Plugin install failed" },
        ],
      },
    });

    expect(raw).toContain("Plugin sync failed");
    expect(raw).toContain("Plugin install failed");
    expect(raw).not.toContain("fixture-ok");
    expect(failure).toMatchObject({ result: { reason: "post-update-plugins" } });
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
