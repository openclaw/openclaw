import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { recordDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import { resolveInstallationTarget } from "../infra/installation-target-context.js";
import { readPackageVersion } from "../infra/package-json.js";
import { readRestartSentinelReadOnly, writeRestartSentinel } from "../infra/restart-sentinel.js";
import {
  acknowledgeAbandonedUpdateRun,
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunStep,
} from "../infra/update-run-ledger.js";
import { triageCommand } from "./triage.js";
import {
  createTriageRuntime,
  resetTriageRepairRuntimeMocks,
  withTriageTerminal,
} from "./triage.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let runtime: ReturnType<typeof createTriageRuntime>;
const healthy = { ok: true, score: 0, summary: "Doctor lint reports no errors." };
vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  confirm: mocks.confirm,
}));
const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  collectDoctorFindings: vi.fn(),
  runUpdateRepairLoop: vi.fn(),
  runUtf8CommandWithTimeout: vi.fn(),
  resolveGatewayInstallEntrypoint: vi.fn(),
  prepareUpdateRepairInference: vi.fn(),
  runUpdateRepairTurn: vi.fn(),
}));
vi.mock("./doctor-lint-runner.js", () => ({ collectDoctorFindings: mocks.collectDoctorFindings }));
vi.mock("../infra/update-repair-agent.js", () => ({
  runUpdateRepairLoop: mocks.runUpdateRepairLoop,
}));
vi.mock("../infra/update-repair-agent.runtime.js", () => ({
  prepareUpdateRepairInference: mocks.prepareUpdateRepairInference,
  runUpdateRepairTurn: mocks.runUpdateRepairTurn,
  withUpdateRepairEnvironment: <T>(_target: unknown, run: () => Promise<T>) => run(),
}));
vi.mock("../infra/executable-path.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/executable-path.js")>()),
  resolveExecutablePath: () => undefined,
}));
vi.mock("../process/exec.js", () => ({
  runUtf8CommandWithTimeout: mocks.runUtf8CommandWithTimeout,
}));
vi.mock("../daemon/gateway-entrypoint.js", () => ({
  resolveGatewayInstallEntrypoint: mocks.resolveGatewayInstallEntrypoint,
}));

async function useRealRepairLoop() {
  const { runUpdateRepairLoop } = await vi.importActual<
    typeof import("../infra/update-repair-agent.js")
  >("../infra/update-repair-agent.js");
  mocks.runUpdateRepairLoop.mockImplementation(runUpdateRepairLoop);
}

async function installationVersion() {
  const version = await readPackageVersion(path.resolve(import.meta.dirname, "../.."));
  if (!version) {
    throw new Error("Fixture installation version missing");
  }
  return version;
}

function runEmbedded(options: Parameters<typeof triageCommand>[1] = {}, terminal = true) {
  return withTriageTerminal(terminal, () =>
    triageCommand(runtime, { noExport: true, run: true, ...options }),
  );
}
function expectLog(text: string | RegExp) {
  expect(runtime.log).toHaveBeenCalledWith(
    typeof text === "string" ? expect.stringContaining(text) : expect.stringMatching(text),
  );
}
function output() {
  return runtime.log.mock.calls.flat().join("\n");
}
function doctorResult(severity?: "error" | "warning", message = "") {
  return {
    code: severity === "error" ? 1 : 0,
    termination: "exit",
    stdout: JSON.stringify({
      ok: severity !== "error",
      findings: severity ? [{ severity, message }] : [],
    }),
  };
}
function packageRun(version: string) {
  return createUpdateRun({ trigger: "cli", target: { kind: "package", version } });
}

describe("triage --run", () => {
  let stateDir: string;
  beforeEach(() => {
    vi.clearAllMocks();
    runtime = createTriageRuntime();
    mocks.confirm.mockResolvedValue(true);
    stateDir = tempDirs.make("openclaw-triage-run-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", undefined);
    vi.stubEnv("OPENCLAW_WORKSPACE_DIR", undefined);
    mocks.collectDoctorFindings.mockResolvedValue([]);
    mocks.resolveGatewayInstallEntrypoint.mockImplementation(async (root) =>
      path.join(root, "dist/index.js"),
    );
    mocks.runUtf8CommandWithTimeout.mockReset().mockResolvedValue(doctorResult());
    resetTriageRepairRuntimeMocks(mocks, stateDir);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([false, true])(
    "keeps update notifications unresolved (correlated: %s)",
    async (correlated) => {
      const run = correlated ? packageRun(await installationVersion()) : undefined;
      if (run) {
        finishUpdateRun(run.runId, { status: "failed", reason: "global-install-failed" });
      }
      const saved = await writeRestartSentinel({
        kind: "update",
        status: "error",
        ts: Date.UTC(2026, 8, 8),
        stats: {
          ...(run ? { runId: run.runId } : {}),
          mode: "npm",
          reason: "global-install-failed",
        },
      });
      await useRealRepairLoop();
      await expect(runEmbedded()).rejects.toMatchObject({ code: 1 });
      expectLog("Embedded repair unrepaired:");
      if (correlated) {
        expect(runtime.log).not.toHaveBeenCalledWith(
          expect.stringContaining("could not be correlated"),
        );
      } else {
        expectLog(/Embedded repair unrepaired: .*Cannot establish the update target\./);
        expectLog("openclaw update repair");
        expect(mocks.runUpdateRepairTurn).not.toHaveBeenCalled();
      }
      expect(await readRestartSentinelReadOnly()).toEqual(saved);
    },
  );

  it.each(["failed", "succeeded with migration", "101 previews"])(
    "keeps update recovery unresolved without a restart sentinel: %s",
    async (outcome) => {
      const pendingMigration = outcome.includes("migration");
      const targetVersion = await installationVersion();
      const run = packageRun(targetVersion);
      recordUpdateRunStep(run.runId, {
        step: "finalize:doctor",
        status: "failed",
        exitCode: 1,
        detail: "Doctor could not enter maintenance.",
      });
      finishUpdateRun(run.runId, { status: "failed", reason: "finalize:doctor" });
      if (pendingMigration) {
        await recordDeferredPluginMigrations({
          pending: [
            {
              pluginId: "codex",
              reason: "The plugin has not reported completion of its retained state migration.",
              command: "openclaw doctor --fix",
              requiresStateMigration: true,
            },
          ],
        });
      }
      if (outcome === "succeeded with migration") {
        const completed = packageRun(targetVersion);
        finishUpdateRun(completed.runId, {
          status: "succeeded",
          after: { version: targetVersion },
        });
      }
      if (outcome === "101 previews") {
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1);
        for (let index = 0; index < 101; index += 1) {
          const preview = createUpdateRun({ trigger: "cli", preview: true });
          finishUpdateRun(preview.runId, { status: "skipped", reason: "dry-run" });
        }
      }
      await useRealRepairLoop();
      await expect(runEmbedded()).rejects.toMatchObject({ code: 1 });
      expect(output()).toContain("Embedded repair unrepaired:");
      expect(output()).toContain("openclaw update repair");
      expect(output()).not.toContain("already resolved");
      if (pendingMigration) {
        expect(output()).toContain('Plugin "codex" data/settings upgrade is unfinished');
      }
      expect(getUpdateRun(run.runId)?.status).toBe("failed");
      expect(await readRestartSentinelReadOnly()).toBeNull();
      expect(mocks.runUpdateRepairTurn).not.toHaveBeenCalled();
    },
  );

  it("reports unavailable update history instead of a healthy Doctor verdict", async () => {
    const ledger = await import("../infra/update-run-reader.js");
    vi.spyOn(ledger, "readUpdateRunResolutionHistory").mockImplementationOnce(() => {
      throw new Error("Ledger snapshot unavailable");
    });
    await useRealRepairLoop();
    await expect(runEmbedded()).rejects.toMatchObject({ code: 1 });
    expectLog(/Embedded repair unrepaired: .*Update history is unavailable/);
    expectLog("openclaw update repair");
    expect(mocks.runUpdateRepairTurn).not.toHaveBeenCalled();
  });

  it.each([
    "preview",
    "acknowledged abandonment",
    "upgrade with generic failure",
    "upgrade from git",
    "explicit upgrade",
    "rollback",
    "rollback without restoration",
    "rollback with mismatched restoration",
    "explicit rollback",
  ])("preserves recorded resolution behind a newer %s", async (newer) => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now++);
    const version = await installationVersion();
    const upgrade = newer.includes("upgrade");
    const rollback = newer.includes("rollback");
    const target = {
      kind: newer === "upgrade from git" ? ("git" as const) : ("package" as const),
      version: upgrade ? "2026.9.1" : version,
    };
    const failed = createUpdateRun({ trigger: "cli", target, before: { version: "2026.9.1" } });
    finishUpdateRun(failed.runId, {
      status: "failed",
      reason: newer === "upgrade with generic failure" ? "update-failed" : "finalize:doctor",
    });
    const completed = createUpdateRun({ trigger: "cli", target });
    finishUpdateRun(completed.runId, { status: "succeeded", after: { version: target.version } });
    const extra = createUpdateRun({
      trigger: "cli",
      preview: newer === "preview",
      ...(upgrade ? { target: { kind: "package", version } } : {}),
      ...(rollback
        ? {
            target: { kind: "package", version: "2099.1.0" },
            before: {
              version: newer === "rollback with mismatched restoration" ? "2026.9.1" : version,
            },
          }
        : {}),
    });
    if (rollback && newer !== "rollback without restoration") {
      recordUpdateRunStep(extra.runId, { step: "package rollback", status: "completed" });
    }
    finishUpdateRun(extra.runId, {
      status: rollback
        ? "rolled-back"
        : upgrade
          ? "succeeded"
          : newer === "preview"
            ? "skipped"
            : "failed",
      ...(upgrade || rollback
        ? { after: { version } }
        : { reason: newer === "preview" ? "dry-run" : "abandoned" }),
    });
    if (newer === "acknowledged abandonment") {
      acknowledgeAbandonedUpdateRun(extra.runId);
    }
    const packages = await import("../infra/update-global.js");
    const inventory = await import("../infra/package-dist-inventory.js");
    const probe = await import("../cli/daemon-cli/restart-health-probe.js");
    const verification = await import("../cli/update-cli/update-command-verification.js");
    vi.spyOn(packages, "collectInstalledGlobalPackageErrors").mockResolvedValue([]);
    vi.spyOn(inventory, "collectPackageDistContentInventoryErrors").mockResolvedValue([]);
    vi.spyOn(probe, "resolveGatewayRestartProbeContext").mockResolvedValue({
      config: {},
      auth: undefined,
    });
    const verified = vi
      .spyOn(verification, "verifyPreviousGatewayForUpdate")
      .mockResolvedValue(true);
    await useRealRepairLoop();
    let updateResult: string | undefined;
    if (newer.startsWith("explicit")) {
      updateResult = path.join(stateDir, "explicit-failure.json");
      await fs.writeFile(
        updateResult,
        JSON.stringify({
          result: {
            runId: failed.runId,
            status: "error",
            mode: "npm",
            reason: "finalize:doctor",
            steps: [],
          },
        }),
      );
    }
    const command = runEmbedded({ updateResult });
    if (updateResult || newer.includes("restoration")) {
      await expect(command).rejects.toMatchObject({ code: 1 });
      expect(verified).not.toHaveBeenCalled();
      expect(output()).not.toContain("already resolved");
      return;
    }
    await command;
    expectLog(
      `Embedded repair already resolved: ${rollback ? "Rollback" : "Update"} to ${version}`,
    );
    expect(verified).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ expectedVersion: version }),
    );
    expect(getUpdateRun(failed.runId)?.status).toBe("failed");
  });

  it.each([
    { history: false, notification: false, doctorErrors: false },
    { history: true, notification: false, doctorErrors: false },
    { history: true, notification: true, doctorErrors: false },
    { history: true, notification: true, doctorErrors: true },
  ])(
    "checks current Doctor findings after acknowledged or absent history (history: $history, notification: $notification, errors: $doctorErrors)",
    async ({ history, notification, doctorErrors }) => {
      const run = history ? createUpdateRun({ trigger: "cli" }) : undefined;
      if (run) {
        finishUpdateRun(run.runId, { status: "failed", reason: "abandoned" });
        acknowledgeAbandonedUpdateRun(run.runId);
      }
      if (notification && run) {
        await writeRestartSentinel({
          kind: "update",
          status: "error",
          ts: Date.now(),
          stats: { runId: run.runId, reason: "abandoned" },
        });
      }
      await useRealRepairLoop();
      if (doctorErrors) {
        mocks.runUtf8CommandWithTimeout.mockResolvedValue(
          doctorResult("error", "Current configuration is invalid."),
        );
      }
      const command = runEmbedded();
      if (doctorErrors) {
        await expect(command).rejects.toMatchObject({ code: 1 });
        expect(output()).toContain("Current configuration is invalid.");
        expect(output()).not.toContain("already resolved");
        return;
      }
      await command;
      expect(runtime.log).toHaveBeenCalledWith(
        "Embedded repair already resolved: Doctor lint reports no errors.",
      );
      expect(mocks.runUpdateRepairTurn).not.toHaveBeenCalled();
      if (run) {
        expect(getUpdateRun(run.runId)?.status).toBe("failed");
      }
    },
  );

  it.each(["missing run", "missing target", "recorded target", "unresolved global install"])(
    "requires updater completion for a saved failure: %s",
    async (identity) => {
      const globalInstall = identity === "unresolved global install";
      const targetVersion = await installationVersion();
      const run =
        identity === "missing run" || globalInstall
          ? undefined
          : createUpdateRun({
              trigger: "cli",
              target:
                identity === "recorded target" ? { kind: "package", version: targetVersion } : {},
            });
      if (run) {
        recordUpdateRunStep(run.runId, {
          step: "finalize:doctor",
          status: "failed",
          exitCode: 1,
          failureFacts: [{ check: "doctor", code: "doctor-failed" }],
        });
        finishUpdateRun(run.runId, { status: "failed", reason: "post-update-failed" });
      }
      const saved = JSON.stringify({
        result: {
          ...(run ? { runId: run.runId } : {}),
          status: "error",
          mode: "npm",
          reason: globalInstall ? "global-install-failed" : "post-update-failed",
          ...(globalInstall
            ? {
                before: { version: "2026.9.3" },
                after: { version: "2026.9.3" },
                recovery: { serviceRestartSafe: false, packageRollbackVerified: false },
              }
            : {}),
          steps: globalInstall
            ? [
                {
                  name: "global install swap",
                  exitCode: 1,
                  stderrTail: "retained package tree changed; Installation recovery is unverified",
                },
              ]
            : [{ name: "doctor", exitCode: 1 }],
        },
      });
      const failurePath = path.join(stateDir, "doctor-failure.json");
      await fs.writeFile(failurePath, saved);
      await useRealRepairLoop();
      const command = runEmbedded({ updateResult: failurePath });
      await expect(command).rejects.toMatchObject({ code: 1 });
      const result = await mocks.runUpdateRepairLoop.mock.results[0]?.value;
      expect(result).toMatchObject({ status: "unrepaired", finalValidation: { ok: false } });
      expectLog(
        identity === "recorded target"
          ? "The updater has not recorded a completed resolution"
          : "Cannot establish the update target.",
      );
      expect(mocks.runUpdateRepairTurn).not.toHaveBeenCalled();
      expect(await fs.readFile(failurePath, "utf8")).toBe(saved);
      if (globalInstall) {
        expect(output()).toContain("Next step");
      }
    },
  );

  it("keeps an older owned update continuation diagnostics-only even on a terminal", async () => {
    await fs.writeFile(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({ agents: { defaults: { model: "openai/gpt-5.6-luna" } } }),
    );
    mocks.confirm.mockResolvedValue(false);
    await withTriageTerminal(true, () =>
      triageCommand(
        runtime,
        { noExport: true },
        {
          signal: new AbortController().signal,
          assertCurrent: vi.fn(),
          failure: { kind: "update", phase: "build", error: "install failed", gateway: "preserve" },
        },
      ),
    );
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.prepareUpdateRepairInference).not.toHaveBeenCalled();
    expect(mocks.runUpdateRepairTurn).not.toHaveBeenCalled();
    expect(output()).not.toContain("the embedded OpenClaw agent using your configured model");
    expect(output()).not.toContain("gpt-5.6-luna");
    expect(runtime.log).toHaveBeenCalledWith("No repair agent was started.");
  });

  it("runs one shared repair turn with fresh Doctor severity validation and the captured target", async () => {
    const signal = new AbortController().signal;
    mocks.runUtf8CommandWithTimeout
      .mockResolvedValueOnce(doctorResult("error", "Broken installation"))
      .mockResolvedValueOnce(doctorResult("warning", "Optional improvement"));
    mocks.runUpdateRepairLoop.mockImplementation(async ({ validate }) => {
      expect(await validate(signal)).toEqual({
        ok: false,
        score: -1,
        summary: "1 Doctor lint error(s): Broken installation",
      });
      const finalValidation = await validate(signal);
      expect(finalValidation).toEqual(healthy);
      return {
        status: "repaired",
        attempts: [{ summary: "Doctor errors repaired." }],
        finalValidation,
      };
    });

    await runEmbedded();

    expect(mocks.runUpdateRepairLoop).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        target: {
          stateDir,
          configPath: path.join(stateDir, "openclaw.json"),
          workspaceDir: path.join(stateDir, "workspace"),
          installRoot: path.resolve(import.meta.dirname, "../.."),
        },
        context: expect.objectContaining({
          error: "Operator requested installation triage",
          phase: "verifying",
        }),
      }),
    );
    expect(mocks.collectDoctorFindings).toHaveBeenCalledOnce();
    expect(mocks.runUtf8CommandWithTimeout).toHaveBeenCalledTimes(2);
    expect(mocks.runUtf8CommandWithTimeout).toHaveBeenCalledWith(
      [
        process.versions.bun ? "node" : process.execPath,
        path.resolve(import.meta.dirname, "../../dist/index.js"),
        "doctor",
        "--lint",
        "--json",
        "--severity-min",
        "error",
      ],
      expect.objectContaining({
        cwd: path.resolve(import.meta.dirname, "../.."),
        baseEnv: {},
        env: expect.objectContaining({
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
          OPENCLAW_WORKSPACE_DIR: path.join(stateDir, "workspace"),
        }),
        signal,
        input: "",
        killProcessTree: true,
        terminateOnOutputLimit: true,
      }),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "Embedded repair repaired: Doctor lint reports no errors.",
    );
  });

  it.each([
    { name: "collection failure", secret: "sk-test-triage-oracle-secret-1234567890" },
    { name: "malformed JSON", result: { code: 0, termination: "exit", stdout: "not-json" } },
    { name: "missing findings", result: { code: 0, termination: "exit", stdout: "{}" } },
    {
      name: "unexplained failure",
      result: { code: 1, termination: "exit", stdout: '{"ok":false,"findings":[]}' },
    },
    {
      name: "output limit",
      result: { code: null, termination: "signal", stdout: "", outputLimitExceeded: true },
    },
  ])("never accepts $name as healthy Doctor validation", async (input) => {
    if ("secret" in input) {
      mocks.runUtf8CommandWithTimeout.mockRejectedValue(
        new Error(`Doctor unavailable; token=${input.secret}`),
      );
    } else {
      mocks.runUtf8CommandWithTimeout.mockResolvedValue(input.result);
    }
    mocks.runUpdateRepairLoop.mockImplementation(async ({ validate }) => {
      const finalValidation = await validate(new AbortController().signal);
      expect(finalValidation.ok).toBe(false);
      expect(finalValidation.summary).toContain("Doctor checks unavailable:");
      if ("secret" in input) {
        expect(finalValidation.score).toBe(Number.MIN_SAFE_INTEGER);
        expect(finalValidation.summary).not.toContain(input.secret);
      }
      return { status: "unrepaired", attempts: [], finalValidation };
    });
    await expect(runEmbedded()).rejects.toMatchObject({ code: 1 });
  });

  it("propagates validation cancellation after the Doctor child settles", async () => {
    const controller = new AbortController();
    const reason = new Error("wall-clock-budget");
    mocks.runUtf8CommandWithTimeout.mockImplementation(async (_argv, { signal }) => {
      expect(signal).toBe(controller.signal);
      controller.abort(reason);
      return { termination: "signal", code: null, stdout: "" };
    });
    mocks.runUpdateRepairLoop.mockImplementation(async ({ validate }) => {
      await expect(validate(controller.signal)).rejects.toBe(reason);
      return {
        status: "aborted",
        reason: "wall-clock-budget",
        attempts: [],
        finalValidation: { ok: false, score: -1, summary: "Cancelled" },
      };
    });
    await expect(runEmbedded()).rejects.toMatchObject({ code: 2 });
  });

  it.each([
    { interactive: false, nonInteractive: false },
    { interactive: true, nonInteractive: true },
  ])(
    "refuses embedded execution without an allowed terminal ($interactive/$nonInteractive)",
    async ({ interactive, nonInteractive }) => {
      await expect(runEmbedded({ nonInteractive }, interactive)).rejects.toThrow(
        "Embedded triage requires an interactive terminal",
      );
      expect(mocks.runUpdateRepairLoop).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "unavailable",
      "The configured model is unavailable",
      "Run `openclaw onboard` or use a suggested handoff command.",
    ],
    [
      "unavailable",
      "exec-denied-by-policy",
      "The operator's policy denies unattended repair (exec-denied-by-policy). Use `openclaw triage` for an external handoff.",
    ],
    ["aborted", "cancelled", 1],
    ["unrepaired", "per-turn-budget", 2],
    ["improved", "wall-clock-budget", 2],
  ] as const)("reports %s with actionable failure for %s", async (status, reason, failure) => {
    mocks.runUpdateRepairLoop.mockResolvedValue({
      status,
      reason,
      attempts: typeof failure === "string" ? [] : [{ summary: "Attempt completed." }],
      finalValidation: { ok: false, score: -1, summary: "Doctor lint found an error." },
    });
    const command = runEmbedded();
    if (typeof failure === "string") {
      await expect(command).rejects.toThrow(failure);
      expect(mocks.runUpdateRepairLoop).toHaveBeenCalledOnce();
    } else {
      await expect(command).rejects.toMatchObject({ code: failure });
      expect(runtime.log).toHaveBeenCalledWith("Attempt completed.");
      expect(runtime.log).toHaveBeenCalledWith(
        `Embedded repair ${status}: Doctor lint found an error.`,
      );
      expect(runtime.error).toHaveBeenCalledWith(reason);
    }
  });

  it("runs embedded triage from in-memory diagnostics when its artifact cannot be saved", async () => {
    vi.spyOn(fs, "writeFile").mockRejectedValueOnce(
      Object.assign(new Error("EACCES: support artifact permission denied"), { code: "EACCES" }),
    );
    await runEmbedded();

    expect(mocks.runUpdateRepairLoop).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        context: expect.objectContaining({ error: "Operator requested installation triage" }),
      }),
    );
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
    expect(runtime.log).not.toHaveBeenCalledWith(expect.stringMatching(/^Debugging prompt: /u));
  });

  it("does not publish a result after its recovery owner closes during repair", async () => {
    let current = true;
    mocks.runUpdateRepairLoop.mockImplementation(async ({ isCurrent, onEvent }) => {
      expect(isCurrent()).toBe(true);
      onEvent({ type: "turn-started", turn: 1, provider: "openai", model: "gpt-5.6-luna" });
      expect(runtime.log).toHaveBeenCalledWith("Starting repair turn 1 with openai/gpt-5.6-luna.");
      current = false;
      return {
        status: "aborted",
        attempts: [],
        finalValidation: { ok: false, score: -1, summary: "Closed" },
      };
    });
    await runEmbedded({
      recovery: {
        target: resolveInstallationTarget(),
        updateFailure: { error: "Captured update failure" },
        isCurrent: () => current,
      },
    });
    expect(runtime.log).not.toHaveBeenCalledWith(
      expect.stringContaining("Embedded repair aborted"),
    );
    expect(runtime.exit).not.toHaveBeenCalled();
  });
});
