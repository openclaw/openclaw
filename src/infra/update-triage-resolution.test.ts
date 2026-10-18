import { beforeEach, expect, it, vi } from "vitest";
import { resolveGatewayRestartProbeContext } from "../cli/daemon-cli/restart-health-probe.js";
import { verifyPreviousGatewayForUpdate } from "../cli/update-cli/update-command-verification.js";
import type { TriageUpdateFailure } from "../commands/triage-update.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
import { readDeferredPluginMigrationsAsync } from "./deferred-plugin-migrations.js";
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
  readDeferredPluginMigrationsAsync: vi.fn(),
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
    steps: [],
    durationMs: 1,
    ...patch,
  };
  return { result };
}

async function expectResolution(ok: boolean, saved = failure(), summary?: string) {
  expect(await validate(saved)).toMatchObject({
    ok,
    ...(summary ? { summary: expect.stringContaining(summary) } : {}),
  });
}
function expectStopped(result: UpdateRepairValidation, ...fragments: string[]) {
  expect(result).toMatchObject({ ok: false, stopReason: result.summary });
  for (const fragment of fragments) {
    expect(result.summary).toContain(fragment);
  }
}

let failedRun: UpdateRunRecord;
let latestRun: UpdateRunRecord;
const validateDoctor = vi.fn<() => Promise<UpdateRepairValidation>>();
const healthy = { ok: true, score: 0, summary: "Doctor passed." };
const gitHead = (sha: string) => ({
  code: 0,
  stdout: `${sha}\n`,
  stderr: "",
  signal: null,
  killed: false,
  termination: "exit" as const,
});

function validate(
  savedFailure = failure(),
  env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: "/fixture/state" },
  signal = new AbortController().signal,
) {
  return validateTriageUpdateResolution({
    failure: savedFailure,
    installRoot: "/fixture/openclaw",
    env,
    signal,
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
    validate: (signal) => validate(failure(), undefined, signal),
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
  vi.mocked(readDeferredPluginMigrationsAsync).mockResolvedValue([]);
  validateDoctor.mockResolvedValue(healthy);
  failedRun = run();
  latestRun = run({
    runId: SUCCEEDED_RUN_ID,
    createdAtMs: 30,
    status: "succeeded",
    after: { version: TARGET_VERSION },
    steps: [{ step: "gateway verification", status: "completed", exitCode: 0 }],
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
  vi.mocked(runUtf8CommandWithTimeout).mockResolvedValue(gitHead(TARGET_SHA));
  repairRuntime.prepareUpdateRepairInference.mockResolvedValue({
    ok: true,
    route: { provider: "fixture", model: "repair" },
    modelFallbacks: [],
  });
  repairRuntime.runUpdateRepairTurn.mockResolvedValue(successfulTurn);
});

it.each(["during Doctor", "during verification"])(
  "requires repair for admission blocked %s",
  async (when) => {
    const blockAdmission = () => {
      vi.mocked(assertNoPendingPackageActivation).mockImplementation(() => {
        throw new Error("managed handoff lease database identity changed");
      });
    };
    if (when === "during Doctor") {
      validateDoctor.mockImplementationOnce(async () => {
        blockAdmission();
        return healthy;
      });
    } else {
      vi.mocked(verifyPreviousGatewayForUpdate).mockImplementationOnce(async () => {
        blockAdmission();
        return true;
      });
    }
    const result = await validate();
    expectStopped(
      result,
      "managed handoff lease database identity changed",
      "`openclaw update repair`",
    );
    expect(result.summary).not.toContain("retry `openclaw update`");
  },
);

it("rejects migrations appearing during verification", async () => {
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", undefined);
  vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_CONVERGENCE", undefined);
  vi.mocked(verifyPreviousGatewayForUpdate).mockImplementationOnce(async () => {
    vi.mocked(readDeferredPluginMigrationsAsync).mockResolvedValue([
      {
        pluginId: "codex",
        reason: "Retained state migration incomplete.",
        command: "openclaw doctor --fix",
        requiresStateMigration: true,
      },
    ]);
    return true;
  });
  const result = await validate(failure(), {
    OPENCLAW_STATE_DIR: "/fixture/state",
    OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
  });
  expectStopped(
    result,
    'Plugin "codex" data/settings upgrade is unfinished',
    'Run "openclaw doctor --fix" to retry the upgrade.',
  );
});

it("preserves post-core migration guidance", async () => {
  vi.mocked(readDeferredPluginMigrationsAsync).mockResolvedValue(
    ["first", "second"].map((pluginId) => ({
      pluginId,
      reason: "Package repair deferred.",
      command: "openclaw update repair",
    })),
  );
  const env = {
    OPENCLAW_STATE_DIR: "/fixture/state",
    OPENCLAW_UPDATE_IN_PROGRESS: "1",
    OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
  };
  const result = await validate(failure(), env);
  expectStopped(
    result,
    'Run "openclaw update repair"',
    'Plugin "first"',
    'Plugin "second"',
    'then "openclaw doctor --fix" to retry the upgrade.',
  );
  expect(result.summary.match(/Run "openclaw update repair"/g)).toHaveLength(2);
  expect(result.summary).not.toContain("Let the current update or repair finish.");
  expect(readDeferredPluginMigrationsAsync).toHaveBeenCalledWith({ env });
  expect(validateDoctor).not.toHaveBeenCalled();
});

it("keeps plugin failures unresolved after Doctor", async () => {
  failedRun.reason = "post-update-failed";
  failedRun.steps = [{ step: "finalize:doctor", status: "failed" }];
  vi.mocked(verifyPreviousGatewayForUpdate).mockImplementation(
    async ({ requirePluginHealth }) => !requirePluginHealth,
  );
  const saved = failure("post-update-failed", {
    postUpdate: {
      plugins: {
        status: "error",
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
          outcomes: [],
        },
        integrityDrifts: [],
      },
    },
  });
  await expectResolution(false, saved);
});

it("verifies a SHA-only Git target", async () => {
  useGitTarget();
  failedRun.target = { kind: "git", sha: TARGET_SHA };
  await expectResolution(true);
});
it.each([
  "restart-unhealthy",
  "update-recovery-pending",
  "package-recovery-permissions-unsafe",
  "managed-handoff-lease-identity-changed",
])("requires a verified later outcome for %s", async (reason) => {
  failedRun.reason = reason;
  const savedFailure = failure(reason);
  const successfulRun = latestRun;
  latestRun = failedRun;
  await expectResolution(false, savedFailure, "Next step:");
  expect(failedRun.status).toBe("failed");
  expect(verifyPreviousGatewayForUpdate).not.toHaveBeenCalled();
  latestRun = successfulRun;
  await expectResolution(true, savedFailure);
  vi.mocked(verifyPreviousGatewayForUpdate).mockResolvedValue(false);
  await expectResolution(false, savedFailure);
});

it("does not invent a target for an error-only artifact", async () => {
  expect(await validate({ error: "Update failed" })).toEqual({
    ok: false,
    score: -1,
    summary: MISSING_TARGET,
    stopReason: MISSING_TARGET,
  });
});

it("does not resolve revoked authority from healthy state", async () => {
  failedRun.reason = "requester-revoked";
  expect(await validate()).toMatchObject({
    ok: false,
    summary: expect.stringContaining("`openclaw update repair`"),
    stopReason: expect.stringContaining(
      "No resolution predicate for update failure requester-revoked",
    ),
  });
});

it("rejects resolution during an active update", async () => {
  vi.mocked(findActiveUpdateRun).mockReturnValue(run({ status: "running", phase: "staging" }));
  await expectResolution(false);
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
    await expectResolution(false, failure(), "owner changed");
  },
);

it("rejects Doctor errors after recorded success", async () => {
  validateDoctor.mockResolvedValue({
    ok: false,
    score: -1,
    summary: "Plugin configuration invalid.",
  });
  await expectResolution(false, failure(), "Plugin configuration invalid. Next step:");
});

it.each(["installed version", "checkout HEAD"])("rejects mismatched Git %s", async (identity) => {
  useGitTarget();
  if (identity === "installed version") {
    vi.mocked(readPackageVersion).mockResolvedValue(BEFORE_VERSION);
  } else {
    vi.mocked(runUtf8CommandWithTimeout).mockResolvedValue(gitHead(BEFORE_SHA));
  }
  await expectResolution(false);
});

it("requires a verified runtime and rollback receipt", async () => {
  useGitTarget();
  vi.mocked(runUtf8CommandWithTimeout).mockResolvedValue(gitHead(BEFORE_SHA));
  latestRun.status = "rolled-back";
  latestRun.after = { ...failedRun.before };
  latestRun.steps.push({ step: "package rollback", status: "completed", exitCode: 0 });
  vi.mocked(readPackageVersion).mockResolvedValue(BEFORE_VERSION);
  await expectResolution(true, failure(), `Rollback to ${BEFORE_VERSION}`);
  latestRun.steps = [];
  await expectResolution(false);
});

it("skips repair after verified resolution", async () => {
  expect(await repair()).toMatchObject({
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

it("revalidates runtime after a repair turn", async () => {
  let runtimeErrors = ["Missing runtime file"];
  vi.mocked(collectInstalledGlobalPackageErrors).mockImplementation(async () => [...runtimeErrors]);
  repairRuntime.runUpdateRepairTurn.mockImplementationOnce(async () => {
    runtimeErrors = [];
    return successfulTurn;
  });
  expect(await repair()).toMatchObject({
    status: "repaired",
    finalValidation: { ok: true },
    attempts: [{ turn: 1, toolCalls: 1, validation: { ok: true } }],
  });
});
