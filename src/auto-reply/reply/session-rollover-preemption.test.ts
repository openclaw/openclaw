import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { disposeAllSessionMcpRuntimes } from "../../agents/agent-bundle-mcp-manager-api.js";
import { prepareOperatorModelPolicy } from "../../agents/operator-model-policy.js";
import { diagnosticLogger } from "../../logging/diagnostic-runtime.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import {
  beginSessionEffect,
  bindSessionControllerTarget,
  captureSessionTarget,
  isSessionMutationActive,
} from "../../sessions/session-controller.lifecycle.js";
import { runAfterReplyOperationClear } from "../../sessions/session-controller.state.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { enqueueFollowupRun, getFollowupQueueDepth } from "./queue.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { clearSessionQueues } from "./queue/cleanup.js";
import { bindReplyOperationTyping } from "./reply-run-typing.js";
import {
  initSessionState,
  writeSessionStore as writeSessionStoreFast,
} from "./test/session.test-support.js";
import { createTypingController } from "./typing.js";

vi.mock("../../plugin-sdk/browser-maintenance.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugin-sdk/browser-maintenance.js")>()),
  closeTrackedBrowserTabsForSessions: vi.fn(async () => 0),
}));

vi.mock("../../plugins/hook-runner-global.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/hook-runner-global.js")>()),
  getGlobalHookRunner: () => null,
}));

const tempDirs = createTempDirTracker();
afterAll(tempDirs.cleanup);

afterEach(async () => {
  vi.useRealTimers();
  await disposeAllSessionMcpRuntimes();
  await closeOpenClawStateDatabaseAsync();
});

async function rolloverFixture(suffix: string) {
  const storePath = path.join(tempDirs.make("openclaw-rollover-preemption-"), "sessions.json");
  const sessionKey = `agent:main:telegram:dm:rollover-${suffix}`;
  const sessionId = `session-before-${suffix}-rollover`;
  await writeSessionStoreFast(storePath, {
    [sessionKey]: { sessionId, updatedAt: Date.now() },
  });
  const target = captureSessionTarget({
    storeScope: storePath,
    sessionKey,
    aliases: [sessionId],
    incarnation: sessionId,
    agentId: "main",
  });
  return { storePath, sessionKey, sessionId, target };
}

function resetSession(storePath: string, sessionKey: string, from: string) {
  return initSessionState({
    ctx: {
      Body: "/new",
      RawBody: "/new",
      CommandBody: "/new",
      From: from,
      To: "bot",
      ChatType: "direct",
      SessionKey: sessionKey,
      Provider: "telegram",
      Surface: "telegram",
    },
    cfg: { session: { store: storePath, reset: { mode: "idle", idleMinutes: 999 } } },
  });
}

it("preempts a running turn and cancels two queued follow-ups before /new resets", async () => {
  const { storePath, sessionKey, sessionId, target } = await rolloverFixture("admission");
  const transcriptPath = path.join(path.dirname(storePath), `${sessionId}.jsonl`);
  await fs.writeFile(transcriptPath, '{"type":"message"}\n', "utf8");
  const runStarted = createDeferred();
  let runInterrupted = false;
  const activeRun = withSessionTurn(
    { sessionKey, sessionId, target },
    async (_operation, signal) => {
      runStarted.resolve();
      await once(signal, "abort");
      runInterrupted = true;
    },
  );
  await runStarted.promise;
  for (const prompt of ["first waiting follow-up", "second waiting follow-up"]) {
    const queued = createQueueTestRun(
      { prompt },
      {
        sessionKey,
        sessionId,
        agentId: "main",
        config: { session: { store: storePath } },
      },
    );
    expect(
      enqueueFollowupRun(
        sessionKey,
        queued,
        { mode: "followup", debounceMs: 60_000 },
        "none",
        undefined,
        false,
      ),
    ).toBe(true);
  }
  expect(getFollowupQueueDepth(sessionKey)).toBe(2);
  const initialization = resetSession(storePath, sessionKey, "user-rollover-admission");

  try {
    const result = await initialization;
    await activeRun;
    expect(runInterrupted).toBe(true);
    expect(result).toMatchObject({ sessionId, resetTriggered: true });
    expect(getFollowupQueueDepth(sessionKey)).toBe(0);
    expect(await fs.stat(transcriptPath).catch(() => null)).not.toBeNull();
  } finally {
    clearSessionQueues([sessionKey, sessionId]);
    await Promise.allSettled([initialization, activeRun]);
  }
});

it("preserves the rollover timeout error when /new preemption does not settle", async () => {
  const { storePath, sessionKey, sessionId, target } = await rolloverFixture("timeout");
  const operation = createReplyOperation({
    sessionKey,
    sessionId,
    target,
    resetTriggered: false,
  });
  bindSessionControllerTarget(operation, target);
  const preemptAttempted = createDeferred();
  vi.spyOn(operation, "abort").mockImplementation(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    preemptAttempted.resolve();
    return false;
  });
  const initialization = resetSession(storePath, sessionKey, "user-rollover-timeout");
  void initialization.catch(() => {});
  try {
    await preemptAttempted.promise;
    expect(isSessionMutationActive(storePath, target.aliases)).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    vi.useRealTimers();

    await expect(initialization).rejects.toThrow(
      `timed out draining work before reply session rollover: ${sessionKey}`,
    );
  } finally {
    operation.complete();
    await initialization.catch(() => undefined);
  }
});

it("rejects /new before interrupting a session whose saved Access is forbidden", async () => {
  const { storePath, sessionKey, sessionId, target } = await rolloverFixture("access-denied");
  await writeSessionStoreFast(storePath, {
    [sessionKey]: { sessionId, updatedAt: Date.now(), cyberAccessProgram: "daybreak_red" },
  });
  const operation = createReplyOperation({ sessionKey, sessionId, target, resetTriggered: false });
  bindSessionControllerTarget(operation, target);
  const abort = vi.spyOn(operation, "abort");
  const cfg = { session: { store: storePath }, agents: { defaults: { model: "openai/fixture" } } };
  const operatorAuthority = createAdmittedRunOperatorAuthority({
    profileId: "limited-operator",
    scopes: ["operator.write"],
    assertCurrent() {},
    rolePolicy: { sessionAccessCap: "none", sandboxRequired: false, agents: "*" },
    modelPolicy: prepareOperatorModelPolicy({ cfg, policy: { allow: ["openai/fixture"] } }),
  });
  try {
    await expect(
      initSessionState({
        ctx: {
          Body: "/new",
          RawBody: "/new",
          CommandBody: "/new",
          From: "access-user",
          To: "bot",
          ChatType: "direct",
          SessionKey: sessionKey,
          Provider: "telegram",
          Surface: "telegram",
        },
        cfg,
        operatorAuthority,
      }),
    ).rejects.toThrow("operator role cannot use this Access level");
    expect(abort).not.toHaveBeenCalled();
  } finally {
    operation.complete();
  }
});

it.for([false, true])(
  "finishes /new after failed typing cleanup (delivery barrier: %s)",
  async (deliveryBarrier, { signal }) => {
    const { storePath, sessionKey, sessionId, target } = await rolloverFixture(
      deliveryBarrier ? "cleanup-after-delivery" : "cleanup-at-completion",
    );
    const operation = createReplyOperation({
      sessionKey,
      sessionId,
      target,
      resetTriggered: false,
    });
    const warning = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => {});
    const typing = createTypingController({
      onReplyStart() {},
      onCleanup() {
        throw new Error("typing transport cleanup failed");
      },
    });
    await typing.startTypingLoop();
    bindReplyOperationTyping(operation, typing);
    const interrupted = createDeferred();
    const finishWriter = createDeferred();
    const effect = await beginSessionEffect({
      target,
      onInterrupt: () => {
        interrupted.resolve();
      },
    });
    let writerFinished = false;
    const writer = effect.run(async () => {
      await finishWriter.promise;
      writerFinished = true;
    });
    runAfterReplyOperationClear(operation, effect.release);
    const delivery = createDeferred();
    let completionFailure: unknown;
    // Observe a synchronous callback failure without skipping the real next initialization.
    try {
      if (deliveryBarrier) {
        operation.completeWithAfterClearBarrier(delivery.promise);
      } else {
        operation.complete();
      }
    } catch (error) {
      completionFailure = error;
    }
    delivery.resolve();
    const initialization = resetSession(storePath, sessionKey, "user-after-cleanup-failure");
    let initialized = false;
    const outcome = initialization.then(
      (result) => {
        initialized = true;
        return result;
      },
      (error: unknown) => error,
    );
    try {
      await withinTest(interrupted.promise, signal);
      expect(initialized).toBe(false);
      expect(writerFinished).toBe(false);
      finishWriter.resolve();
      await writer;
      expect(await withinTest(outcome, signal)).toMatchObject({ sessionId, resetTriggered: true });
      expect(writerFinished).toBe(true);
      expect(completionFailure).toBeUndefined();
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("typing transport cleanup failed"),
      );
      await operation.ownerSettlement;
      await effect.released;
    } finally {
      finishWriter.resolve();
      effect.release();
      await writer;
      await outcome;
      warning.mockRestore();
    }
  },
);
