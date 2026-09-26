import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import { SqliteReadOnlyInspectionContentionError } from "../../infra/sqlite-readonly-worker-protocol.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import {
  resolveCommandProcessSignal,
  retainCommandProcessCleanup,
  withCommandProcessScope,
} from "../../process/exec-spawn.js";
import { defaultRuntime } from "../../runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import * as channelConfig from "./update-command-config.js";
import { UnreportedUpdateAdmissionOutcome } from "./update-command-result.js";
import { resolveUpdateCommandTarget } from "./update-command-target.js";

const boundary = vi.hoisted(() => ({ inspect: vi.fn(), report: vi.fn() }));
vi.mock("../../infra/update-freebsd-pkg-ownership.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-freebsd-pkg-ownership.js")>()),
  createFreeBsdPkgOwnershipInspection: () => ({
    assertUnowned: boundary.inspect,
    assertEntryUnowned: vi.fn(),
  }),
}));
vi.mock("./update-command-terminal.js", () => ({
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

it.each(["recovered", "busy", "corrupt"] as const)(
  "continues target inspection only after a successful contention reinspection (%s)",
  async (outcome) => {
    const config = await channelConfig.readUpdateChannelConfig(false);
    const contention = new SqliteReadOnlyInspectionContentionError(
      "SQLite read-only inspection: database is locked",
    );
    const corruption = Object.assign(new Error("database disk image is malformed"), {
      errcode: 11,
    });
    const read = vi.spyOn(channelConfig, "readUpdateChannelConfig");
    if (outcome === "recovered") {
      read.mockResolvedValue(config).mockRejectedValueOnce(contention);
    } else {
      read.mockRejectedValue(outcome === "busy" ? contention : corruption);
    }
    const warning = vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
    const run = {
      runId: createUpdateRun({ trigger: "cli" }, { env: state.env }).runId,
      env: state.env,
    };
    const enter = vi.fn(async () => ({ assertCurrent: () => {} }));
    const target = resolveUpdateCommandTarget(
      { json: true, dryRun: true, sourceUpdate: { root: state.root }, run },
      { triageTarget: { root: state.root, env: state.env } },
      undefined,
      {
        startedAt: Date.now(),
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
      },
      { enter },
      1000,
    );
    if (outcome === "recovered") {
      await expect(target).resolves.toMatchObject({ updateInstallKind: "git", channel: "dev" });
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("continuing the update"));
      expect(getUpdateRun(run.runId, { env: state.env })?.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            step: "warning:installation-inspection",
            status: "completed",
            detail: expect.stringContaining(contention.message),
          }),
        ]),
      );
    } else {
      await expect(target).rejects.toBe(outcome === "busy" ? contention : corruption);
      expect(warning).not.toHaveBeenCalled();
    }
    expect(read).toHaveBeenCalledTimes(outcome === "corrupt" ? 1 : 2);
    expect(enter).not.toHaveBeenCalled();
  },
);

it.each(["forced", "uncertain"] as const)(
  "settles target inspection before reporting preflight refusal (%s)",
  async (cleanupResult) => {
    const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
    const cleanup = createDeferredCore<"forced" | "uncertain">();
    const joining = createDeferredCore();
    const reported = new Error("terminal refusal was reported");
    boundary.report.mockRejectedValue(reported);
    boundary.inspect.mockImplementation(async () => {
      retainCommandProcessCleanup(cleanup.promise);
      resolveCommandProcessSignal()?.addEventListener("abort", () => joining.resolve(), {
        once: true,
      });
    });
    const enter = vi.fn(async () => ({ assertCurrent: () => {} }));
    const prepared = {
      startedAt: 0,
      postCoreUpdateResume: false,
      postCoreUpdateChannel: undefined,
      timeoutMs: 1000,
      shouldRestart: true,
      requestedChannel: "extended-stable",
      devTarget: undefined,
      controlPlaneUpdateSentinelMeta: null,
      discoveredRoot: "/synthetic/install",
      installKind: "git",
      servicePlan: undefined,
      pkgOwnership: { assertUnowned: boundary.inspect, assertEntryUnowned: vi.fn() },
    } satisfies Parameters<typeof resolveUpdateCommandTarget>[3];
    const work = withCommandProcessScope(() =>
      resolveUpdateCommandTarget(
        { json: true, run: { runId: run.runId, env: state.env } },
        { triageTarget: { root: prepared.discoveredRoot, env: state.env } },
        undefined,
        prepared,
        { enter },
        1000,
      ),
    ).catch((error: unknown) => error);
    try {
      await Promise.race([
        joining.promise,
        work.then(() => {
          throw new Error("target preparation escaped cleanup ownership");
        }),
      ]);
      expect(boundary.report).not.toHaveBeenCalled();
    } finally {
      cleanup.resolve(cleanupResult);
      await work;
    }
    const result = await work;
    expect(enter).not.toHaveBeenCalled();
    expect(hasCommandProcessCleanupError(result)).toBe(cleanupResult === "uncertain");
    if (cleanupResult === "forced") {
      expect(result).toBe(reported);
      expect(boundary.report).toHaveBeenCalledOnce();
      expect(boundary.report).toHaveBeenCalledWith(
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
