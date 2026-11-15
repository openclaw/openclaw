import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import { SqliteReadOnlyInspectionContentionError } from "../../infra/sqlite-readonly-worker-protocol.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { defaultRuntime } from "../../runtime.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import * as channelConfig from "./update-command-config.js";
import { retainedInspectionCleanup } from "./update-command-inspection-settlement.test-support.js";
import { UnreportedUpdateAdmissionOutcome } from "./update-command-result.js";
import { resolveUpdateCommandTarget } from "./update-command-target.js";

const boundary = vi.hoisted(() => ({ inspect: vi.fn(), report: vi.fn() }));
vi.mock("../../infra/update-system-package-ownership.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-system-package-ownership.js")>()),
  createSystemPackageOwnershipInspection: () => ({
    assertUnowned: boundary.inspect,
    assertEntryUnowned: vi.fn(),
  }),
}));
vi.mock("./update-command-admission-report.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-admission-report.js")>()),
  reportPreMutationUpdateResult: boundary.report,
}));
let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only" });
});
afterEach(async () => {
  await state.cleanup();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

function targetFixture(overrides: Partial<Parameters<typeof resolveUpdateCommandTarget>[3]> = {}) {
  const run = {
    runId: createUpdateRun({ trigger: "cli" }, { env: state.env }).runId,
    env: state.env,
  };
  const enter = vi.fn(async () => ({ assertCurrent: () => {} }));
  const prepared = {
    startedAt: 0,
    postCoreUpdateResume: false,
    postCoreUpdateChannel: undefined,
    timeoutMs: 1000,
    shouldRestart: false,
    requestedChannel: null,
    devTarget: undefined,
    controlPlaneUpdateSentinelMeta: null,
    discoveredRoot: state.root,
    installKind: "git",
    servicePlan: undefined,
    pkgOwnership: { assertUnowned: boundary.inspect, assertEntryUnowned: vi.fn() },
    ...overrides,
  } satisfies Parameters<typeof resolveUpdateCommandTarget>[3];
  return {
    run,
    enter,
    inspect: (dryRun = false) =>
      resolveUpdateCommandTarget(
        { json: true, run, ...(dryRun ? { dryRun, sourceUpdate: { root: state.root } } : {}) },
        { triageTarget: { root: prepared.discoveredRoot, env: state.env } },
        undefined,
        prepared,
        { enter },
        1000,
      ),
  };
}

it.each(["busy", "corrupt"] as const)(
  "rejects failed target inspection without acquiring mutation authority (%s)",
  async (outcome) => {
    const failure =
      outcome === "busy"
        ? new SqliteReadOnlyInspectionContentionError(
            "SQLite read-only inspection: database is locked",
          )
        : Object.assign(new Error("database disk image is malformed"), { errcode: 11 });
    const read = vi.spyOn(channelConfig, "readUpdateChannelConfig").mockRejectedValue(failure);
    const warning = vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
    const { enter, inspect } = targetFixture({ startedAt: Date.now() });
    await expect(inspect(true)).rejects.toBe(failure);
    expect(warning).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(outcome === "corrupt" ? 1 : 2);
    expect(enter).not.toHaveBeenCalled();
  },
);

it.each(["forced", "uncertain"] as const)(
  "settles target inspection before reporting preflight refusal (%s)",
  async (cleanupResult) => {
    const cleanup = retainedInspectionCleanup();
    const reported = new Error("terminal refusal was reported");
    boundary.report.mockRejectedValue(reported);
    boundary.inspect.mockImplementation(async () => cleanup.retain());
    const { enter, inspect } = targetFixture({
      shouldRestart: true,
      requestedChannel: "extended-stable",
      discoveredRoot: "/synthetic/install",
    });
    const work = withCommandProcessScope(() => inspect()).catch((error: unknown) => error);
    const result = await cleanup.join(work, cleanupResult, () => {
      expect(boundary.report).not.toHaveBeenCalled();
    });
    expect(enter).not.toHaveBeenCalled();
    expect(hasCommandProcessCleanupError(result)).toBe(cleanupResult === "uncertain");
    if (cleanupResult === "forced") {
      expect(result).toBe(reported);
      expect(boundary.report).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ reason: "unsupported_git_channel", installKind: "git" }),
      );
    } else {
      expect(boundary.report).not.toHaveBeenCalled();
      const refusal = collectNestedErrorCandidates(result).find(
        (error) => error instanceof UnreportedUpdateAdmissionOutcome,
      );
      expect(refusal).toMatchObject({ report: { reason: "unsupported_git_channel" } });
    }
  },
);
