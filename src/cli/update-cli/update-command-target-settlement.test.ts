import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import {
  resolveCommandProcessSignal,
  retainCommandProcessCleanup,
  withCommandProcessScope,
} from "../../process/exec-spawn.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
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
  vi.resetAllMocks();
});

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
