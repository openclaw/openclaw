import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  loadRunCronIsolatedAgentTurn,
  loadSessionEntryMock,
  mockRunCronFallbackPassthrough,
  patchSessionEntryMock,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const accessor = await vi.importActual<typeof import("../../config/sessions/session-accessor.js")>(
  "../../config/sessions/session-accessor.js",
);
const actualSession = await vi.importActual<typeof import("./session.js")>("./session.js");

function completedTurn() {
  return {
    payloads: [{ text: "Scheduled turn completed" }],
    meta: {
      agentMeta: {
        agentHarnessId: "openclaw",
        provider: "openai",
        model: "gpt-5.4",
        contextTokens: 128_000,
      },
    },
  };
}

function startCron(
  target: { sessionKey: string; storePath: string },
  options: Pick<RunCronAgentTurnParams, "abortSignal" | "onLaneWait"> & { name?: string } = {},
) {
  return runCronIsolatedAgentTurn(
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
    resetRunCronIsolatedAgentTurnHarness();
    mockRunCronFallbackPassthrough();
    resolveCronSessionMock.mockImplementation(actualSession.prepareCronSession);
    loadSessionEntryMock.mockImplementation(actualSession.loadCronSessionEntryLatest);
    patchSessionEntryMock.mockImplementation(accessor.patchSessionEntryCore);
    runEmbeddedAgentMock.mockImplementation(async () => completedTurn());
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
      modelProvider: "openai",
      model: "gpt-5.4",
      agentHarnessId: "openclaw",
      contextTokens: 128_000,
      contextTokensSource: "resolved",
      contextBudgetStatus: contextBudgetStatusFixture({ provider: "openai", model: "gpt-5.4" }),
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
      expect(resolveCronSessionMock).not.toHaveBeenCalled();
      expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
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

  it("borrows an inherited controller turn without waiting on itself", async ({ signal }) => {
    const { target } = await seedSession();
    await expect(
      withinTest(
        withSessionTurn(target, () => startCron(target)),
        signal,
      ),
    ).resolves.toMatchObject({ status: "ok" });
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
  });

  it("passes caller cancellation into a borrowed native turn", async ({ signal }) => {
    const { target } = await seedSession();
    const caller = new AbortController();
    await withinTest(
      withSessionTurn(target, async (operation) => {
        if (!operation) {
          throw new Error("Expected an admitted outer operation");
        }
        runEmbeddedAgentMock.mockImplementationOnce(async (params: RunEmbeddedAgentParams) => {
          expect(params.abortSignal?.aborted).toBe(false);
          caller.abort(new Error("cancel nested cron"));
          expect(params.abortSignal?.aborted).toBe(true);
          expect(operation.abortSignal.aborted).toBe(false);
          throw params.abortSignal?.reason;
        });
        const result = await startCron(target, { abortSignal: caller.signal });
        expect(result.status).toBe("error");
        expect(operation.abortSignal.aborted).toBe(false);
      }),
      signal,
    );
  });

  it("keeps prepared cron invocations in FIFO order through model settlement", async ({
    signal,
  }) => {
    const { target } = await seedSession();
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const secondWaiting = createDeferred();
    const order: string[] = [];
    runEmbeddedAgentMock.mockImplementation(async (params: RunEmbeddedAgentParams) => {
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
      expect(resolveCronSessionMock).toHaveBeenCalledOnce();
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
