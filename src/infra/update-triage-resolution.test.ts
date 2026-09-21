import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveGatewayRestartProbeContext } from "../cli/daemon-cli/restart-health-probe.js";
import { verifyPreviousGatewayForUpdate } from "../cli/update-cli/update-command-verification.js";
import type { TriageUpdateFailure } from "../commands/triage-update.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
import { readDeferredPluginMigrations } from "./deferred-plugin-migrations.js";
import { collectPackageDistContentInventoryErrors } from "./package-dist-inventory.js";
import { readPackageVersion } from "./package-json.js";
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
    budget: { maxTurns: 1 },
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
  it.each([
    ["post-update-failed", "finalize:doctor"],
    ["doctor-failed", "finalize:doctor"],
    ["finalize:doctor", "finalize:doctor"],
    ["repair-requires-config-change", "finalize:doctor"],
    ["post-plugin-doctor-invalid-config", "finalize:doctor"],
    ["doctor-failed", "openclaw doctor"],
    ["doctor-failed", "candidate-doctor"],
  ])(
    "keeps an attributed %s Doctor failure at %s unresolved until updater completion",
    async (reason, step) => {
      failedRun.reason = reason;
      failedRun.steps = [
        {
          step,
          status: "failed",
          failureFacts: [{ check: "doctor", code: "doctor-failed" }],
        },
      ];
      latestRun = failedRun;
      expect(await validate(failure(reason))).toMatchObject({
        ok: false,
        summary: expect.stringContaining("The updater has not recorded a completed resolution"),
      });
      expect(failedRun.status).toBe("failed");
      expect(verifyPreviousGatewayForUpdate).not.toHaveBeenCalled();
    },
  );

  it("rejects a correlated Doctor repair without a recorded update target", async () => {
    failedRun.reason = "post-update-failed";
    failedRun.target = {};
    failedRun.steps = [{ step: "doctor", status: "failed" }];
    latestRun = failedRun;
    expect(await validate(failure("post-update-failed"))).toMatchObject({
      ok: false,
      summary: MISSING_TARGET,
      stopReason: MISSING_TARGET,
    });
    expect(validateDoctor).not.toHaveBeenCalled();
  });

  it("does not treat a later preview as completion of a Doctor failure", async () => {
    failedRun.reason = "post-update-failed";
    failedRun.steps = [{ step: "finalize:doctor", status: "failed" }];
    latestRun.status = "skipped";
    latestRun.reason = "dry-run";
    expect(await validate(failure("post-update-failed"))).toMatchObject({
      ok: false,
      summary: expect.stringContaining("The updater has not recorded a completed resolution"),
    });
    expect(failedRun.status).toBe("failed");
    expect(latestRun.status).toBe("skipped");
  });

  it.each([
    ["before verification", "OPENCLAW_UPDATE_IN_PROGRESS"],
    ["during verification", "OPENCLAW_UPDATE_POST_CORE_CONVERGENCE"],
  ])(
    "does not certify pending plugin migrations %s despite updater completion",
    async (when, marker) => {
      const pending = [
        {
          pluginId: "codex",
          reason: "The plugin has not reported completion of its retained state migration.",
          command: "openclaw doctor --fix",
          requiresStateMigration: true as const,
        },
      ];
      if (when === "before verification") {
        vi.mocked(readDeferredPluginMigrations).mockReturnValue(pending);
      } else {
        vi.mocked(verifyPreviousGatewayForUpdate).mockImplementationOnce(async () => {
          vi.mocked(readDeferredPluginMigrations).mockReturnValue(pending);
          return true;
        });
      }
      const result = await validate(failure(), {
        OPENCLAW_STATE_DIR: "/fixture/state",
        [marker]: "1",
      });
      expect(result).toMatchObject({
        ok: false,
        summary: expect.stringContaining('Plugin "codex" state migration is pending'),
      });
      expect(result.summary).toContain("Let the current update or repair finish.");
    },
  );

  it.each(["OPENCLAW_UPDATE_IN_PROGRESS", "OPENCLAW_UPDATE_POST_CORE_CONVERGENCE"])(
    "preserves the caller's %s context in pending migration guidance",
    async (marker) => {
      vi.mocked(readDeferredPluginMigrations).mockReturnValue([
        {
          pluginId: "fixture-plugin",
          reason: "Package repair deferred.",
          command: "openclaw update repair",
        },
      ]);
      const result = await validateTriageUpdateResolution({
        failure: failure(),
        installRoot: "/fixture/openclaw",
        env: { OPENCLAW_STATE_DIR: "/fixture/state", [marker]: "1" },
        signal: new AbortController().signal,
        validateDoctor,
      });

      expect(result).toMatchObject({
        ok: false,
        summary: expect.stringContaining("Let the current update or repair finish."),
      });
      expect(result.summary).toContain(
        'If this warning remains afterward, run "openclaw update repair"',
      );
      expect(result.stopReason).toBe(result.summary);
    },
  );

  it("formats every pending migration with the supplied update environment", async () => {
    const env = { OPENCLAW_STATE_DIR: "/fixture/state", OPENCLAW_UPDATE_IN_PROGRESS: "1" };
    vi.mocked(readDeferredPluginMigrations).mockReturnValue(
      ["first", "second"].map((pluginId) => ({
        pluginId,
        reason: "State migration is incomplete.",
        command: "openclaw doctor --fix",
      })),
    );
    const result = await validateTriageUpdateResolution({
      failure: failure(),
      installRoot: "/fixture/openclaw",
      env,
      signal: new AbortController().signal,
      validateDoctor,
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Plugin "first"');
    expect(result.summary).toContain('Plugin "second"');
    expect(result.summary.match(/Let the current update or repair finish/g)).toHaveLength(2);
    expect(readDeferredPluginMigrations).toHaveBeenCalledWith({ env });
    expect(validateDoctor).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "keeps mixed plugin installation failures unresolved after Doctor is clean (completed update: %s)",
    async (completed) => {
      failedRun.reason = "post-update-failed";
      failedRun.steps = [{ step: "finalize:doctor", status: "failed" }];
      if (!completed) {
        latestRun = failedRun;
      }
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
              outcomes: [
                { pluginId: "sample", status: "error", message: "Package install failed" },
              ],
            },
            integrityDrifts: [],
          },
        },
      });
      expect(await validate(saved)).toMatchObject({ ok: false });
    },
  );

  it.each(["version", "sha"] as const)(
    "verifies a Git target recorded with only its %s",
    async (identity) => {
      useGitTarget();
      failedRun.target =
        identity === "version"
          ? { kind: "git", version: TARGET_VERSION }
          : { kind: "git", sha: TARGET_SHA };
      expect(await validate(failure("checkout-failed", { mode: "git" }))).toMatchObject({
        ok: true,
      });
    },
  );
  it.each([
    "global-install-failed",
    "runtime-verification-failed",
    "database-schema-preflight",
    "invalid-config",
    "finalize:doctor",
    "post-update-plugins",
    "restart-unhealthy",
    "plugin-errors",
  ])("requires a later verified updater outcome for %s", async (reason) => {
    failedRun.reason = reason;
    const savedFailure = failure(reason);
    const successfulRun = latestRun;
    latestRun = failedRun;
    expect(await validate(savedFailure)).toMatchObject({
      ok: false,
      summary: expect.stringContaining("Next step:"),
    });

    latestRun = successfulRun;
    expect(await validate(savedFailure)).toMatchObject({ ok: true });

    vi.mocked(verifyPreviousGatewayForUpdate).mockResolvedValue(false);
    expect(await validate(savedFailure)).toMatchObject({ ok: false });
  });

  it.each([
    "fetch-failed",
    "preflight-node-runtime-incompatible",
    "checkout-failed",
    "target-sha-mismatch",
  ])("verifies the selected Git runtime after %s", async (reason) => {
    useGitTarget();
    failedRun.reason = reason;
    const savedFailure = failure(reason, { mode: "git" });
    expect(await validate(savedFailure)).toMatchObject({ ok: true });

    vi.mocked(collectGitRuntimeErrors).mockResolvedValue(["runtime stamp does not match target"]);
    expect(await validate(savedFailure)).toMatchObject({ ok: false });
  });

  it.each([
    { name: "error-only artifact", input: { error: "Update failed" } },
    {
      name: "artifact without run identity",
      input: failure("global-install-failed", { runId: undefined }),
    },
  ])("does not invent a target for $name", async ({ input }) => {
    expect(await validate(input)).toEqual({
      ok: false,
      score: -1,
      summary: MISSING_TARGET,
      stopReason: MISSING_TARGET,
    });
  });

  it.each(["missing run", "missing version", "missing install kind", "missing Git identity"])(
    "cannot establish the target with %s",
    async (missing) => {
      if (missing === "missing run") {
        vi.mocked(getUpdateRun).mockReturnValue(undefined);
      } else if (missing === "missing version") {
        failedRun.target = { kind: "package" };
      } else if (missing === "missing install kind") {
        failedRun.target = { version: TARGET_VERSION };
      } else {
        failedRun.target = { kind: "git", channel: "dev", tag: "latest" };
      }
      expect(await validate()).toMatchObject({ ok: false, summary: MISSING_TARGET });
    },
  );

  it.each(["future-unknown-failure", "requester-revoked", "update-recovery-pending"])(
    "does not resolve %s from unrelated healthy installation facts",
    async (reason) => {
      failedRun.reason = reason;
      expect(await validate(failure(reason))).toMatchObject({
        ok: false,
        summary: expect.stringContaining("Next step:"),
      });
    },
  );

  it.each([
    ["older successful run", { createdAtMs: 1, finishedAtMs: 5 }],
    ["different target version", { target: { kind: "package", version: "2026.9.5" } }],
    [
      "different install kind",
      { target: { kind: "git", version: TARGET_VERSION, sha: TARGET_SHA } },
    ],
    ["surviving previous package", { after: { version: BEFORE_VERSION } }],
    ["unfinished outcome", { finishedAtMs: null }],
    ["latest failure", { status: "failed" }],
  ] satisfies Array<[string, Partial<UpdateRunRecord>]>)(
    "does not accept %s as completion of the failed update",
    async (_name, patch) => {
      Object.assign(latestRun, patch);
      expect(await validate()).toMatchObject({ ok: false });
    },
  );

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

  it.each(["package runtime", "package content inventory", "managed service"])(
    "does not trust saved success when the current %s is unverified",
    async (owner) => {
      if (owner === "package runtime") {
        vi.mocked(collectInstalledGlobalPackageErrors).mockResolvedValue([
          "installed version mismatch",
        ]);
      } else if (owner === "package content inventory") {
        vi.mocked(collectPackageDistContentInventoryErrors).mockResolvedValue([
          "runtime file changed",
        ]);
      } else {
        vi.mocked(verifyPreviousGatewayForUpdate).mockResolvedValue(false);
      }
      expect(await validate()).toMatchObject({
        ok: false,
        summary: expect.stringContaining("Next step:"),
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

  it.each([
    ["global-install-failed", true],
    ["plugin-errors", false],
    ["post-update-plugins", false],
  ])("requires plugin health when resolving %s", async (reason, resolved) => {
    failedRun.reason = reason;
    vi.mocked(verifyPreviousGatewayForUpdate).mockImplementation(
      async ({ requirePluginHealth }) => !requirePluginHealth,
    );
    expect(await validate(failure(reason))).toMatchObject({ ok: resolved });
  });

  it.each(["recorded target", "recorded result", "installed version", "checkout HEAD"])(
    "rejects mismatched Git %s despite a healthy Gateway",
    async (identity) => {
      useGitTarget();
      if (identity === "recorded target") {
        latestRun.target.sha = BEFORE_SHA;
      } else if (identity === "recorded result") {
        latestRun.after.sha = BEFORE_SHA;
      } else if (identity === "installed version") {
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

  it("does not change the saved failure or terminal ledger records while validating", async () => {
    const savedFailure = failure();
    const before = structuredClone({ savedFailure, failedRun, latestRun });
    expect(await validate(savedFailure)).toMatchObject({ ok: true });
    expect({ savedFailure, failedRun, latestRun }).toEqual(before);
  });

  it.each(["package", "git"] as const)(
    "accepts an owner-recorded %s rollback only with the previous runtime currently verified",
    async (kind) => {
      if (kind === "git") {
        useGitTarget();
        vi.mocked(runUtf8CommandWithTimeout).mockResolvedValue({
          code: 0,
          stdout: `${BEFORE_SHA}\n`,
          stderr: "",
          signal: null,
          killed: false,
          termination: "exit",
        });
      }
      latestRun.status = "rolled-back";
      latestRun.after = { ...failedRun.before };
      latestRun.steps.push({ step: "package rollback", status: "completed", exitCode: 0 });
      vi.mocked(readPackageVersion).mockResolvedValue(BEFORE_VERSION);
      const savedFailure = failure(kind === "git" ? "checkout-failed" : "global-install-failed", {
        mode: kind === "git" ? "git" : "npm",
      });
      expect(await validate(savedFailure)).toMatchObject({
        ok: true,
        summary: expect.stringContaining(`Rollback to ${BEFORE_VERSION}`),
      });

      latestRun.steps = [];
      expect(await validate(savedFailure)).toMatchObject({ ok: false });
    },
  );

  it("does not confuse a surviving old version with verified package rollback", async () => {
    latestRun.status = "rolled-back";
    latestRun.after = { version: BEFORE_VERSION };
    latestRun.steps = [{ step: "package rollback", status: "failed", exitCode: 1 }];
    vi.mocked(readPackageVersion).mockResolvedValue(BEFORE_VERSION);
    expect(await validate()).toMatchObject({ ok: false });
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
