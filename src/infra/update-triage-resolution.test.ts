import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveGatewayRestartProbeContext } from "../cli/daemon-cli/restart-health-probe.js";
import { verifyPreviousGatewayForUpdate } from "../cli/update-cli/update-command-verification.js";
import type { TriageUpdateFailure } from "../commands/triage-update.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
import { readDeferredPluginMigrations } from "./deferred-plugin-migrations.js";
import { collectPackageDistContentInventoryErrors } from "./package-dist-inventory.js";
import { readPackageVersion } from "./package-json.js";
import { assertNoPendingPackageActivation } from "./package-update-activation.js";
import { collectGitRuntimeErrors } from "./update-git-runtime.js";
import { collectInstalledGlobalPackageErrors } from "./update-global.js";
import { runUpdateRepairLoop } from "./update-repair-agent.js";
import type { UpdateRepairValidation } from "./update-repair-protocol.js";
import {
  findActiveUpdateRun,
  getUpdateRun,
  readUpdateRunResolutionHistory,
} from "./update-run-reader.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import type { UpdateRunResult } from "./update-runner-types.js";
import { validateTriageUpdateResolution } from "./update-triage-resolution.js";

vi.mock("../cli/daemon-cli/restart-health-probe.js", () => ({
  resolveGatewayRestartProbeContext: vi.fn(),
}));
vi.mock("../cli/update-cli/update-command-verification.js", () => ({
  verifyPreviousGatewayForUpdate: vi.fn(),
}));
vi.mock("../process/exec.js", () => ({ runUtf8CommandWithTimeout: vi.fn() }));
vi.mock("./package-dist-inventory.js", () => ({
  collectPackageDistContentInventoryErrors: vi.fn(),
}));
vi.mock("./package-json.js", () => ({ readPackageVersion: vi.fn() }));
// mock-isolation: Exercise triage decisions without opening package journals or lease databases.
vi.mock("./package-update-activation.js", () => ({ assertNoPendingPackageActivation: vi.fn() }));
vi.mock("./deferred-plugin-migrations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./deferred-plugin-migrations.js")>()),
  readDeferredPluginMigrations: vi.fn(),
}));
vi.mock("./update-git-runtime.js", () => ({ collectGitRuntimeErrors: vi.fn() }));
vi.mock("./update-global.js", () => ({ collectInstalledGlobalPackageErrors: vi.fn() }));
vi.mock("./update-run-reader.js", () => ({
  findActiveUpdateRun: vi.fn(),
  getUpdateRun: vi.fn(),
  readUpdateRunResolutionHistory: vi.fn(),
}));
const repairRuntime = vi.hoisted(() => ({
  prepareUpdateRepairInference: vi.fn(),
  runUpdateRepairTurn: vi.fn(),
}));
vi.mock("./update-repair-agent.runtime.js", () => ({
  ...repairRuntime,
  withUpdateRepairEnvironment: <T>(_target: unknown, operation: () => Promise<T>) => operation(),
}));

const FAILED_RUN_ID = "10000000-0000-4000-8000-000000000001";
const SUCCEEDED_RUN_ID = "10000000-0000-4000-8000-000000000002";
const TARGET_SHA = "1111111111111111111111111111111111111111";
const BEFORE_SHA = "2222222222222222222222222222222222222222";
const TARGET_VERSION = "2026.9.4";
const BEFORE_VERSION = "2026.9.3";
const MISSING_TARGET =
  "Next step: run `openclaw update status --json`, then `openclaw update repair`. Cannot establish the update target.";

function run(patch: Partial<UpdateRunRecord> = {}): UpdateRunRecord {
  return {
    runId: FAILED_RUN_ID,
    createdAtMs: 10,
    updatedAtMs: 20,
    trigger: "cli",
    phase: "finished",
    status: "failed",
    reason: "global-install-failed",
    origin: {},
    target: { kind: "package", version: TARGET_VERSION },
    before: { version: BEFORE_VERSION },
    after: { version: BEFORE_VERSION },
    steps: [{ step: "global install swap", status: "failed", exitCode: 1 }],
    verification: {},
    repair: [],
    confirmedAtMs: null,
    finishedAtMs: 20,
    downtimeMs: null,
    ...patch,
  };
}

function failure(
  reason = "global-install-failed",
  patch: Partial<UpdateRunResult> = {},
): TriageUpdateFailure {
  const result: UpdateRunResult = {
    runId: FAILED_RUN_ID,
    status: "error",
    mode: "npm",
    reason,
    before: { version: BEFORE_VERSION },
    after: { version: BEFORE_VERSION },
    recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
    steps: [],
    durationMs: 1,
    ...patch,
  };
  return { result };
}

let failedRun: UpdateRunRecord;
let latestRun: UpdateRunRecord;
const validateDoctor = vi.fn<() => Promise<UpdateRepairValidation>>();

function validate(
  savedFailure = failure(),
  env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: "/fixture/state" },
) {
  return validateTriageUpdateResolution({
    failure: savedFailure,
    installRoot: "/fixture/openclaw",
    env,
    signal: new AbortController().signal,
    validateDoctor,
  });
}

function useGitTarget() {
  failedRun.target = { kind: "git", version: TARGET_VERSION, sha: TARGET_SHA };
  failedRun.before = { version: BEFORE_VERSION, sha: BEFORE_SHA };
  latestRun.target = { ...failedRun.target };
  latestRun.after = { version: TARGET_VERSION, sha: TARGET_SHA };
}

function repair() {
  return runUpdateRepairLoop({
    target: {
      installRoot: "/fixture/openclaw",
      stateDir: "/fixture/state",
      configPath: "/fixture/config.json",
      workspaceDir: "/fixture/workspace",
    },
    context: { ...failure(), phase: "verifying", targetVersion: TARGET_VERSION },
    validate: (signal) =>
      validateTriageUpdateResolution({
        failure: failure(),
        installRoot: "/fixture/openclaw",
        env: { OPENCLAW_STATE_DIR: "/fixture/state" },
        signal,
        validateDoctor,
      }),
  });
}

const successfulTurn = {
  toolCalls: 1,
  exitCode: 0,
  envelope: {
    model: "repair",
    provider: "fixture",
    final: 'REPAIR_RESULT: {"status":"fixed","summary":"Restored the missing runtime file."}',
    status: "ok",
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(readDeferredPluginMigrations).mockReturnValue([]);
  validateDoctor.mockResolvedValue({
    ok: true,
    score: 0,
    summary: "Doctor lint reports no errors.",
  });
  failedRun = run();
  latestRun = run({
    runId: SUCCEEDED_RUN_ID,
    createdAtMs: 30,
    updatedAtMs: 40,
    status: "succeeded",
    reason: null,
    after: { version: TARGET_VERSION },
    steps: [{ step: "gateway verification", status: "completed", exitCode: 0 }],
    verification: {
      serviceRunning: true,
      runningVersion: TARGET_VERSION,
      versionMatch: true,
      settled: true,
      readyz: true,
      channelsReady: true,
      pluginErrors: [],
    },
    confirmedAtMs: 40,
    finishedAtMs: 40,
  });
  vi.mocked(getUpdateRun).mockImplementation((runId) =>
    runId === FAILED_RUN_ID ? failedRun : undefined,
  );
  vi.mocked(findActiveUpdateRun).mockReturnValue(undefined);
  vi.mocked(readUpdateRunResolutionHistory).mockImplementation(() => ({
    failure: failedRun,
    outcome: latestRun,
  }));
  vi.mocked(collectInstalledGlobalPackageErrors).mockResolvedValue([]);
  vi.mocked(collectPackageDistContentInventoryErrors).mockResolvedValue([]);
  vi.mocked(collectGitRuntimeErrors).mockResolvedValue([]);
  vi.mocked(readPackageVersion).mockResolvedValue(TARGET_VERSION);
  vi.mocked(resolveGatewayRestartProbeContext).mockResolvedValue({ config: {}, auth: undefined });
  vi.mocked(verifyPreviousGatewayForUpdate).mockResolvedValue(true);
  vi.mocked(runUtf8CommandWithTimeout).mockResolvedValue({
    code: 0,
    stdout: `${TARGET_SHA}\n`,
    stderr: "",
    signal: null,
    killed: false,
    termination: "exit",
  });
  repairRuntime.prepareUpdateRepairInference.mockResolvedValue({
    ok: true,
    route: {
      runner: "embedded",
      agentId: "owner",
      provider: "fixture",
      model: "repair",
      modelLabel: "fixture/repair",
      agentDir: "/fixture/agent",
      runConfig: {},
    },
    modelFallbacks: [],
  });
  repairRuntime.runUpdateRepairTurn.mockResolvedValue(successfulTurn);
});

describe("saved update failure resolution", () => {
  it.each(["during Doctor", "during verification"])(
    "prescribes repair when package admission is blocked %s despite a successful last run",
    async (when) => {
      const blockAdmission = () => {
        vi.mocked(assertNoPendingPackageActivation).mockImplementation(() => {
          throw new Error("managed handoff lease database identity changed");
        });
      };
      if (when === "during Doctor") {
        validateDoctor.mockImplementationOnce(async () => {
          blockAdmission();
          return { ok: true, score: 0, summary: "Doctor passed." };
        });
      } else {
        vi.mocked(verifyPreviousGatewayForUpdate).mockImplementationOnce(async () => {
          blockAdmission();
          return true;
        });
      }
      const result = await validate();
      expect(result.ok).toBe(false);
      expect(result.summary).toContain("managed handoff lease database identity changed");
      expect(result.summary).toContain("`openclaw update repair`");
      expect(result.summary).not.toContain("retry `openclaw update`");
      expect(result.stopReason).toBe(result.summary);
    },
  );

  it("does not certify plugin migrations appearing during verification", async () => {
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", undefined);
    vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_CONVERGENCE", undefined);
    const pending = [
      {
        pluginId: "codex",
        reason: "The plugin has not reported completion of its retained state migration.",
        command: "openclaw doctor --fix",
        requiresStateMigration: true as const,
      },
    ];
    vi.mocked(verifyPreviousGatewayForUpdate).mockImplementationOnce(async () => {
      vi.mocked(readDeferredPluginMigrations).mockReturnValue(pending);
      return true;
    });
    const result = await validate(failure(), {
      OPENCLAW_STATE_DIR: "/fixture/state",
      OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
    });
    expect(result).toMatchObject({
      ok: false,
      summary: expect.stringContaining('Plugin "codex" data/settings upgrade is unfinished'),
    });
    expect(result.summary).toContain("Let the current update or repair finish.");
  });

  it("preserves the caller's post-core convergence context in pending migration guidance", async () => {
    vi.mocked(readDeferredPluginMigrations).mockReturnValue(
      ["first", "second"].map((pluginId) => ({
        pluginId,
        reason: "Package repair deferred.",
        command: "openclaw update repair",
      })),
    );
    const env = {
      OPENCLAW_STATE_DIR: "/fixture/state",
      OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
    };
    const result = await validate(failure(), env);

    expect(result).toMatchObject({
      ok: false,
      summary: expect.stringContaining("Let the current update or repair finish."),
    });
    expect(result.summary).toContain('Plugin "first"');
    expect(result.summary).toContain('Plugin "second"');
    expect(result.summary.match(/Let the current update or repair finish/g)).toHaveLength(2);
    expect(result.summary).toContain(
      'If this warning remains afterward, run "openclaw update repair"',
    );
    expect(result.stopReason).toBe(result.summary);
    expect(readDeferredPluginMigrations).toHaveBeenCalledWith({ env });
    expect(validateDoctor).not.toHaveBeenCalled();
  });

  it("keeps mixed plugin installation failures unresolved after Doctor and updater completion", async () => {
    failedRun.reason = "post-update-failed";
    failedRun.steps = [{ step: "finalize:doctor", status: "failed" }];
    vi.mocked(verifyPreviousGatewayForUpdate).mockImplementation(
      async ({ requirePluginHealth }) => !requirePluginHealth,
    );
    const saved = failure("post-update-failed", {
      postUpdate: {
        plugins: {
          status: "error",
          reason: "post-plugin-doctor-invalid-config",
          changed: false,
          sync: {
            changed: false,
            switchedToBundled: [],
            switchedToNpm: [],
            warnings: [],
            errors: [],
          },
          npm: {
            changed: false,
            outcomes: [{ pluginId: "sample", status: "error", message: "Package install failed" }],
          },
          integrityDrifts: [],
        },
      },
    });
    expect(await validate(saved)).toMatchObject({ ok: false });
  });

  it("verifies a Git target recorded with only its SHA", async () => {
    useGitTarget();
    failedRun.target = { kind: "git", sha: TARGET_SHA };
    expect(await validate(failure("checkout-failed", { mode: "git" }))).toMatchObject({
      ok: true,
    });
  });
  it.each(["restart-unhealthy", "update-recovery-pending"])(
    "requires a later verified updater outcome for %s",
    async (reason) => {
      failedRun.reason = reason;
      const savedFailure = failure(reason);
      const successfulRun = latestRun;
      latestRun = failedRun;
      expect(await validate(savedFailure)).toMatchObject({
        ok: false,
        summary: expect.stringContaining("Next step:"),
      });
      expect(failedRun.status).toBe("failed");
      expect(verifyPreviousGatewayForUpdate).not.toHaveBeenCalled();

      latestRun = successfulRun;
      expect(await validate(savedFailure)).toMatchObject({ ok: true });

      vi.mocked(verifyPreviousGatewayForUpdate).mockResolvedValue(false);
      expect(await validate(savedFailure)).toMatchObject({ ok: false });
    },
  );

  it("does not invent a target for an error-only artifact", async () => {
    expect(await validate({ error: "Update failed" })).toEqual({
      ok: false,
      score: -1,
      summary: MISSING_TARGET,
      stopReason: MISSING_TARGET,
    });
  });

  it("does not resolve revoked authority from unrelated healthy installation facts", async () => {
    const reason = "requester-revoked";
    failedRun.reason = reason;
    expect(await validate(failure(reason))).toMatchObject({
      ok: false,
      summary: expect.stringContaining("`openclaw update repair`"),
      stopReason: expect.stringContaining(
        "No resolution predicate for update failure requester-revoked",
      ),
    });
  });

  it("does not report resolution while an updater is active", async () => {
    vi.mocked(findActiveUpdateRun).mockReturnValue(run({ status: "running", phase: "staging" }));
    expect(await validate()).toMatchObject({ ok: false });
  });

  it.each(["new active run", "new terminal run"])(
    "rejects a %s appearing during service verification",
    async (change) => {
      vi.mocked(verifyPreviousGatewayForUpdate).mockImplementationOnce(async () => {
        if (change === "new active run") {
          vi.mocked(findActiveUpdateRun).mockReturnValue(
            run({ status: "running", phase: "staging" }),
          );
        } else {
          latestRun = run({ runId: "10000000-0000-4000-8000-000000000003" });
        }
        return true;
      });
      expect(await validate()).toMatchObject({
        ok: false,
        summary: expect.stringContaining("owner changed"),
      });
    },
  );

  it("rejects current Doctor errors even after the updater recorded success", async () => {
    validateDoctor.mockResolvedValue({
      ok: false,
      score: -1,
      summary: "Plugin configuration invalid.",
    });
    expect(await validate(failure("finalize:doctor"))).toMatchObject({
      ok: false,
      summary: expect.stringContaining("Plugin configuration invalid. Next step:"),
    });
  });

  it.each(["installed version", "checkout HEAD"])(
    "rejects mismatched Git %s despite a healthy Gateway",
    async (identity) => {
      useGitTarget();
      if (identity === "installed version") {
        vi.mocked(readPackageVersion).mockResolvedValue(BEFORE_VERSION);
      } else {
        vi.mocked(runUtf8CommandWithTimeout).mockResolvedValue({
          code: 0,
          stdout: `${BEFORE_SHA}\n`,
          stderr: "",
          signal: null,
          killed: false,
          termination: "exit",
        });
      }
      expect(await validate(failure("checkout-failed", { mode: "git" }))).toMatchObject({
        ok: false,
      });
    },
  );

  it("accepts an owner-recorded Git rollback only with the previous runtime currently verified", async () => {
    useGitTarget();
    vi.mocked(runUtf8CommandWithTimeout).mockResolvedValue({
      code: 0,
      stdout: `${BEFORE_SHA}\n`,
      stderr: "",
      signal: null,
      killed: false,
      termination: "exit",
    });
    latestRun.status = "rolled-back";
    latestRun.after = { ...failedRun.before };
    latestRun.steps.push({ step: "package rollback", status: "completed", exitCode: 0 });
    vi.mocked(readPackageVersion).mockResolvedValue(BEFORE_VERSION);
    const savedFailure = failure("checkout-failed", { mode: "git" });
    expect(await validate(savedFailure)).toMatchObject({
      ok: true,
      summary: expect.stringContaining(`Rollback to ${BEFORE_VERSION}`),
    });

    latestRun.steps = [];
    expect(await validate(savedFailure)).toMatchObject({ ok: false });
  });

  it("returns a zero-attempt result only after the owners verify existing resolution", async () => {
    const result = await repair();
    expect(result).toMatchObject({
      status: "repaired",
      attempts: [],
      finalValidation: {
        ok: true,
        summary: expect.stringContaining("recorded by the updater"),
      },
    });
    expect(repairRuntime.prepareUpdateRepairInference).not.toHaveBeenCalled();
    expect(repairRuntime.runUpdateRepairTurn).not.toHaveBeenCalled();
  });

  it("reports repaired after a real turn clears the current runtime verification failure", async () => {
    let runtimeErrors = ["Missing runtime file"];
    vi.mocked(collectInstalledGlobalPackageErrors).mockImplementation(async () => [
      ...runtimeErrors,
    ]);
    repairRuntime.runUpdateRepairTurn.mockImplementationOnce(async () => {
      runtimeErrors = [];
      return successfulTurn;
    });
    const result = await repair();
    expect(result).toMatchObject({ status: "repaired", finalValidation: { ok: true } });
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({
      turn: 1,
      toolCalls: 1,
      validation: { ok: true },
    });
  });
});
