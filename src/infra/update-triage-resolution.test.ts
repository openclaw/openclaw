import { beforeEach, expect, it, vi } from "vitest";
import { resolveGatewayRestartProbeContext } from "../cli/daemon-cli/restart-health-probe.js";
import { verifyPreviousGatewayForUpdate } from "../cli/update-cli/update-command-verification.js";
import type { TriageUpdateFailure } from "../commands/triage-update.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
import { createCommandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { readDeferredPluginMigrationsAsync } from "./deferred-plugin-migrations.js";
import { collectPackageDistContentInventoryErrors } from "./package-dist-inventory.js";
import { readPackageVersion } from "./package-json.js";
import { collectGitRuntimeErrors } from "./update-git-runtime.js";
import { collectInstalledGlobalPackageErrors } from "./update-global.js";
import type { UpdateRepairValidation } from "./update-repair-protocol.js";
import {
  findActiveUpdateRun,
  getUpdateRun,
  readUpdateRunResolutionHistory,
} from "./update-run-reader.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import { createUpdateRunRecordFixture } from "./update-run-record.test-support.js";
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

const FAILED_RUN_ID = "10000000-0000-4000-8000-000000000001";
const SUCCEEDED_RUN_ID = "10000000-0000-4000-8000-000000000002";
const TARGET_SHA = "1111111111111111111111111111111111111111";
const BEFORE_SHA = "2222222222222222222222222222222222222222";
const TARGET_VERSION = "2026.9.4";
const BEFORE_VERSION = "2026.9.3";

function run(patch: Partial<UpdateRunRecord> = {}): UpdateRunRecord {
  return createUpdateRunRecordFixture(FAILED_RUN_ID, {
    createdAtMs: 10,
    updatedAtMs: 20,
    reason: "global-install-failed",
    target: { kind: "package", version: TARGET_VERSION },
    before: { version: BEFORE_VERSION },
    after: { version: BEFORE_VERSION },
    steps: [{ step: "global install swap", status: "failed", exitCode: 1 }],
    finishedAtMs: 20,
    ...patch,
  });
}

function failure(
  reason = "global-install-failed",
  patch: Partial<Extract<TriageUpdateFailure, { result: unknown }>["result"]> = {},
): TriageUpdateFailure {
  return {
    result: {
      runId: FAILED_RUN_ID,
      status: "error",
      mode: "npm",
      reason,
      steps: [],
      ...patch,
    },
  };
}

async function expectResolution(ok: boolean, saved = failure(), summary?: string) {
  expect(await validate(saved)).toMatchObject({
    ok,
    ...(summary ? { summary: expect.stringContaining(summary) } : {}),
  });
}
function expectStopped(result: UpdateRepairValidation, ...fragments: string[]) {
  expect(result).toMatchObject({ ok: false, score: -1, stopReason: result.summary });
  for (const fragment of fragments) {
    expect(result.summary).toContain(fragment);
  }
}

let failedRun: UpdateRunRecord;
let latestRun: UpdateRunRecord;
const validateDoctor = vi.fn<() => Promise<UpdateRepairValidation>>();
const healthy = { ok: true, score: 0, summary: "Doctor passed." };
const gitHead = (sha: string) => createCommandResult({ stdout: `${sha}\n` });

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
});

it("keeps plugin failures unresolved after Doctor", async () => {
  failedRun.reason = "post-update-failed";
  failedRun.steps = [{ step: "finalize:doctor", status: "failed" }];
  vi.mocked(verifyPreviousGatewayForUpdate).mockImplementation(
    async ({ requirePluginHealth }) => !requirePluginHealth,
  );
  const saved = failure("post-update-failed", {
    postUpdate: { plugins: { status: "error" } },
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
  latestRun = successfulRun;
  await expectResolution(true, savedFailure);
  vi.mocked(verifyPreviousGatewayForUpdate).mockResolvedValue(false);
  await expectResolution(false, savedFailure);
});

it("does not invent a target for an error-only artifact", async () => {
  expectStopped(
    await validate({ error: "Update failed" }),
    "Cannot establish the update target.",
    "`openclaw update status --json`",
    "`openclaw update repair`",
  );
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

it("rejects missing installed runtime files", async () => {
  vi.mocked(collectInstalledGlobalPackageErrors).mockResolvedValue(["Missing runtime file"]);
  expect(await validate()).toMatchObject({
    ok: false,
    score: -1,
    summary: expect.stringContaining("Installed runtime verification failed: Missing runtime file"),
  });
});
