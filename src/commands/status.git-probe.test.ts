import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { SpawnResult } from "../process/exec-result.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { statusCommand } from "./status.command.js";
import { createStatusScanCoreBootstrap } from "./status.scan.bootstrap-shared.js";
import { baseStatusServices, createStatusScanResultFixture } from "./status.test-support.js";
import { getUpdateCheckResult } from "./status.update.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

vi.mock("../process/exec.js", async (original) => ({
  ...(await original<typeof import("../process/exec.js")>()),
  runCommandWithTimeout: vi.fn(),
}));
vi.mock("../infra/openclaw-root.js", async (original) => ({
  ...(await original<typeof import("../infra/openclaw-root.js")>()),
  resolveOpenClawPackageRoot: async () => "/repo",
}));
vi.mock("../infra/detect-package-manager.js", () => ({ detectPackageManager: async () => "pnpm" }));
vi.mock("../infra/update-run-ledger.js", () => ({ getLatestUpdateFetchFailure: () => undefined }));
vi.mock("../infra/update-check-package-target.js", () => ({
  fetchNpmPackageTargetStatus: async () => ({ version: "0.0.0" }),
}));
vi.mock("./node-runtime-diagnostics.js", () => ({ collectNodeRuntimeFindings: async () => [] }));
vi.mock("./status.node-mode.js", () => ({ resolveNodeOnlyGatewayInfo: async () => null }));
vi.mock("./status-runtime-shared.ts", () => ({
  resolveStatusRuntimeSnapshot: async () => ({ ...baseStatusServices }),
  resolveStatusGatewayHealth: vi.fn(),
  resolveStatusSecurityAudit: vi.fn(),
  resolveStatusUsageSummary: vi.fn(),
}));
vi.mock("./status.scan.shared.js", async (original) => ({
  ...(await original<typeof import("./status.scan.shared.js")>()),
  resolveGatewayProbeSnapshot: async () => ({}),
}));
// Keep the bootstrap, Git check, command routing, and output real; unrelated scan data is synthetic.
vi.mock("./status.scan.js", () => ({ scanStatus: scanWithGitProbe }));
vi.mock("./status.scan.fast-json.js", () => ({ scanStatusJsonFast: scanWithGitProbe }));

async function scanWithGitProbe(opts: Parameters<typeof createStatusScanCoreBootstrap>[0]["opts"]) {
  const fixture = createStatusScanResultFixture({
    env: { OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR },
  });
  const bootstrap = await createStatusScanCoreBootstrap({
    coldStart: false,
    cfg: fixture.cfg,
    configPath: "/repo/openclaw.json",
    env: fixture.env ?? {},
    hasConfiguredChannels: true,
    opts,
    fetchGitUpdate: opts.all === true,
    includeRegistryUpdate: opts.all === true,
    getTailnetHostname: async () => null,
    getUpdateCheckResult,
    getAgentLocalStatuses: async () => fixture.agentStatus,
  });
  return { ...fixture, update: await bootstrap.updatePromise };
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const successfulGit: SpawnResult = {
  pid: 1,
  stdout: "",
  stderr: "",
  code: 0,
  signal: null,
  killed: false,
  termination: "exit",
};

beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-status-git-probe-"));
  vi.mocked(runCommandWithTimeout)
    .mockReset()
    .mockImplementation(async (argv) => ({
      ...successfulGit,
      stdout: argv.includes("--show-toplevel")
        ? "/repo"
        : argv.includes("--abbrev-ref")
          ? "main"
          : argv.includes("--count")
            ? "0\t0"
            : argv.includes("--format=%ct")
              ? "1700000000"
              : argv.includes("--porcelain")
                ? ""
                : "abc123",
    }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function delayGitProbe(probe: string, delayMs: number | null, failure?: string) {
  const started = createDeferred();
  const run = vi.mocked(runCommandWithTimeout).getMockImplementation();
  if (!run) {
    throw new Error("Git runner was not initialized");
  }
  vi.mocked(runCommandWithTimeout).mockImplementation(async (argv, options) => {
    if (!argv.includes(probe)) {
      return run(argv, options);
    }
    const timeoutMs = typeof options === "number" ? options : options.timeoutMs;
    if (timeoutMs === undefined) {
      throw new Error("Git probe needs a finite budget");
    }
    const timedOut = delayMs === null || delayMs > timeoutMs;
    started.resolve();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, timedOut ? timeoutMs : delayMs);
    });
    return timedOut
      ? { ...successfulGit, code: null, signal: "SIGTERM", killed: true, termination: "timeout" }
      : failure
        ? { ...successfulGit, code: 128, stderr: failure }
        : run(argv, options);
  });
  return started.promise;
}

async function runStatusProbe(
  params: { json: boolean; all?: boolean; timeoutMs?: number },
  started: Promise<void>,
) {
  const runtime = createTestRuntime();
  const pending = statusCommand(params, runtime);
  // Observe rejection immediately so the pre-fix failure is an assertion, not an unhandled rejection.
  const outcome = pending.then(
    () => "completed",
    (error: unknown) => error,
  );
  await started;
  await vi.runAllTimersAsync();
  expect(await outcome).toBe("completed");
  expect(runtime.exit).not.toHaveBeenCalled();
  expect(runtime.error).not.toHaveBeenCalled();
  const output = stripAnsi(runtime.log.mock.calls.map(([line]) => String(line)).join("\n"));
  if (params.json) {
    const payload = JSON.parse(output);
    expect(payload.gateway).toBeDefined();
    expect(payload.sessions.count).toBe(2);
    return { output, update: payload.update };
  }
  expect(output).toContain("Gateway");
  expect(output).toContain("Sessions");
  return { output, update: undefined };
}

describe("status optional Git probes", () => {
  it.each([false, true])("allows a cold 4 s local probe (JSON: %s)", async (json) => {
    vi.useFakeTimers();
    const result = await runStatusProbe({ json }, delayGitProbe("--show-toplevel", 4000));
    expect(result.output).not.toContain("update status unknown");
    if (json) {
      expect(result.update.installKind).toBe("git");
      expect(result.update.error).toBeUndefined();
    } else {
      expect(result.output).toContain("up to date");
    }
  });

  it.each([
    { json: false, probe: "--show-toplevel", timeoutMs: undefined, budgetMs: 10_000 },
    { json: true, probe: "--show-toplevel", timeoutMs: undefined, budgetMs: 10_000 },
    { json: true, all: true, probe: "--show-toplevel", timeoutMs: 20_000, budgetMs: 20_000 },
    { json: false, probe: "--show-toplevel", timeoutMs: 1000, budgetMs: 1000 },
    { json: true, probe: "--show-toplevel", timeoutMs: 1000, budgetMs: 1000 },
    { json: false, probe: "--porcelain", timeoutMs: undefined, budgetMs: 10_000 },
    { json: true, probe: "--abbrev-ref", timeoutMs: undefined, budgetMs: 10_000 },
  ])(
    "keeps the report after $probe times out (JSON: $json, budget: $budgetMs)",
    async ({ probe, budgetMs, ...opts }) => {
      vi.useFakeTimers();
      const startedAt = Date.now();
      const { output, update } = await runStatusProbe(opts, delayGitProbe(probe, null));
      expect(Date.now() - startedAt).toBe(budgetMs);
      expect(output).toContain(`git probe did not finish within ${budgetMs / 1000} s (slow host)`);
      expect(output).not.toContain("remote reachability");
      if (opts.json) {
        expect(update.error).toMatchObject({ status: "unknown", timeoutMs: budgetMs });
      } else {
        expect(output).toContain("update status unknown");
        expect(output.replace(/[│\s]+/gu, " ")).toContain("openclaw update status");
        expect(output).not.toContain("up to date");
      }
    },
  );

  it.each([false, true])(
    "keeps a genuine Git error inside the update section (JSON: %s)",
    async (json) => {
      vi.useFakeTimers();
      const { output, update } = await runStatusProbe(
        { json },
        delayGitProbe("--abbrev-ref", 1, "fatal: permission denied"),
      );
      expect(output).toContain("fatal: permission denied");
      expect(output).not.toContain("slow host");
      if (json) {
        expect(update.error.status).toBe("failed");
      } else {
        expect(output).toContain("update status failed");
      }
    },
  );
});
