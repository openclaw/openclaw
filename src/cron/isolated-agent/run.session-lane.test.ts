import path from "node:path";
import { afterAll, assert, beforeEach, describe, expect, it } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { contextBudgetStatusFixture } from "../../config/sessions/context-budget.test-support.js";
import { SESSION_TOTAL_TOKENS_VERSION, type SessionEntry } from "../../config/sessions/types.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import type { RunCronAgentTurnParams } from "./run-prepare-runtime.js";
import { realCronSession } from "./run.session.test-support.js";
import * as harness from "./run.test-harness.js";

const runCron = await harness.loadRunCronIsolatedAgentTurn();
const realSession = await realCronSession();
const { accessor } = realSession;

const model = { provider: "openai", model: "gpt-5.4" };
const agentMeta = { ...model, agentHarnessId: "openclaw", contextTokens: 128_000 };
function completedTurn() {
  return { payloads: [{ text: "Done" }], meta: { agentMeta: { ...agentMeta } } };
}

function startCron(
  target: { sessionKey: string; storePath: string },
  options: Pick<RunCronAgentTurnParams, "abortSignal" | "onLaneWait"> & { name?: string } = {},
) {
  return runCron(
    makeIsolatedAgentParamsFixture({
      agentId: "main",
      sessionKey: target.sessionKey,
      job: makeIsolatedAgentJobFixture({
        id: options.name ?? "scheduled-turn",
        name: options.name ?? "Scheduled turn",
        sessionTarget: `session:${target.sessionKey}`,
        delivery: { mode: "none" },
      }),
      cfg: { session: { store: target.storePath, reset: { mode: "idle", idleMinutes: 60 } } },
      abortSignal: options.abortSignal,
      onLaneWait: options.onLaneWait,
    }),
  );
}

describe("session-bound cron lane admission", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-cron-session-lane-");

  async function seedSession(stale = false) {
    const target = {
      agentId: "main",
      sessionKey: "agent:main:cron-admission",
      sessionId: "occupied-session",
      storePath: path.join(sessionDirs.make(), "openclaw-agent.sqlite"),
    };
    const updatedAt = Date.now() - (stale ? 120 * 60_000 : 0);
    const entry: SessionEntry = {
      sessionId: target.sessionId,
      updatedAt,
      sessionStartedAt: updatedAt,
      lastInteractionAt: updatedAt,
      ...(stale ? { lifecycleRevision: "occupied-generation" } : {}),
    };
    await accessor.replaceSessionEntry(target, entry);
    return { target, entry };
  }

  beforeEach(() => {
    harness.resetRunCronIsolatedAgentTurnHarness();
    harness.mockRunCronFallbackPassthrough();
    realSession.install();
    harness.runEmbeddedAgentMock.mockImplementation(async () => completedTurn());
  });

  it.for([
    { name: "legacy row", stale: false, cancel: false },
    { name: "stale row", stale: true, cancel: false },
    { name: "cancelled wait", stale: false, cancel: true },
  ])("preserves the generation through $name", async ({ stale, cancel }, { signal }) => {
    const { target, entry } = await seedSession(stale);
    const occupied = createDeferred();
    const release = createDeferred();
    const waiting = createDeferred();
    const laneSignals: Parameters<NonNullable<RunCronAgentTurnParams["onLaneWait"]>>[0][] = [];
    const terminal: Partial<SessionEntry> = {
      lastInteractionAt: Date.now(),
      modelProvider: model.provider,
      model: model.model,
      agentHarnessId: agentMeta.agentHarnessId,
      contextTokens: agentMeta.contextTokens,
      contextTokensSource: "resolved",
      contextBudgetStatus: contextBudgetStatusFixture(model),
      inputTokens: 240,
      outputTokens: 16,
      compactionCount: 1,
      totalTokens: 256,
      totalTokensFresh: true,
      totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
    };
    const previous = withSessionTurn(target, async () => {
      occupied.resolve();
      await release.promise;
      await accessor.patchSessionEntryCore(target, () => terminal);
    });
    await occupied.promise;
    const controller = new AbortController();
    const run = startCron(target, {
      abortSignal: controller.signal,
      onLaneWait: (info) => {
        laneSignals.push(info);
        if (info?.waiting) {
          waiting.resolve();
        }
      },
    });
    try {
      await withinTest(
        awaitGateBeforeSettlement(waiting.promise, run, "Cron missed controller admission"),
        signal,
      );
      expect(accessor.loadSessionEntry(target)).toMatchObject(entry);
      expect(harness.resolveCronSessionMock).not.toHaveBeenCalled();
      expect(harness.runEmbeddedAgentMock).not.toHaveBeenCalled();
      if (cancel) {
        controller.abort(new Error("cancel queued cron"));
        await expect(withinTest(run, signal)).rejects.toThrow("cancel queued cron");
        expect(accessor.loadSessionEntry(target)).toMatchObject(entry);
      } else {
        release.resolve();
        await previous;
        await expect(withinTest(run, signal)).resolves.toMatchObject({ status: "ok" });
        expect(laneSignals).toContainEqual({ waiting: false, stage: "session-preparation" });
        expect(laneSignals.filter((info) => info?.stage !== "session-preparation")).toEqual([]);
        expect(accessor.loadSessionEntry(target)).toMatchObject({
          sessionId: target.sessionId,
          ...terminal,
        });
      }
    } finally {
      controller.abort();
      release.resolve();
      await Promise.allSettled([previous, run]);
    }
  });

  it.for([false, true])("borrowed controller cancellation=%s", async (cancel, { signal }) => {
    const { target } = await seedSession();
    const caller = new AbortController();
    await withinTest(
      withSessionTurn(target, async (operation) => {
        assert(operation, "Expected an admitted outer operation");
        if (cancel) {
          harness.runEmbeddedAgentMock.mockImplementationOnce(
            async (params: RunEmbeddedAgentParams) => {
              expect(params.abortSignal?.aborted).toBe(false);
              caller.abort(new Error("cancel nested cron"));
              expect(params.abortSignal?.aborted).toBe(true);
              expect(operation.abortSignal.aborted).toBe(false);
              throw params.abortSignal?.reason;
            },
          );
        }
        const result = await startCron(target, cancel ? { abortSignal: caller.signal } : {});
        expect(result.status).toBe(cancel ? "error" : "ok");
        if (cancel) {
          expect(operation.abortSignal.aborted).toBe(false);
        }
      }),
      signal,
    );
    if (!cancel) {
      expect(harness.runEmbeddedAgentMock).toHaveBeenCalledOnce();
    }
  });

  it("serializes cron turns through model settlement", async ({ signal }) => {
    const { target } = await seedSession();
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const secondWaiting = createDeferred();
    const order: string[] = [];
    harness.runEmbeddedAgentMock.mockImplementation(async (params: RunEmbeddedAgentParams) => {
      const name = params.prompt.includes("fifo-first") ? "first" : "second";
      order.push(name);
      if (name === "first") {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      return completedTurn();
    });
    const first = startCron(target, { name: "fifo-first", abortSignal: signal });
    await withinTest(firstStarted.promise, signal);
    const second = startCron(target, {
      name: "fifo-second",
      abortSignal: signal,
      onLaneWait: (info) => info?.waiting && secondWaiting.resolve(),
    });
    try {
      await withinTest(
        awaitGateBeforeSettlement(secondWaiting.promise, second, "Second cron skipped admission"),
        signal,
      );
      expect(order).toEqual(["first"]);
      expect(harness.resolveCronSessionMock).toHaveBeenCalledOnce();
      releaseFirst.resolve();
      await expect(withinTest(Promise.all([first, second]), signal)).resolves.toEqual([
        expect.objectContaining({ status: "ok" }),
        expect.objectContaining({ status: "ok" }),
      ]);
      expect(order).toEqual(["first", "second"]);
    } finally {
      releaseFirst.resolve();
      await Promise.allSettled([first, second]);
    }
  });
});
