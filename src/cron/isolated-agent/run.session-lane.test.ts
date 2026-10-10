import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { resolveSessionLane } from "../../agents/embedded-agent-runner/lanes.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { contextBudgetStatusFixture } from "../../config/sessions/context-budget.test-support.js";
import { SESSION_TOTAL_TOKENS_VERSION, type SessionEntry } from "../../config/sessions/types.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
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
    return { target, entry, lane: resolveSessionLane(target.sessionKey) };
  }

  beforeEach(() => {
    resetRunCronIsolatedAgentTurnHarness();
    mockRunCronFallbackPassthrough();
    resolveCronSessionMock.mockImplementation(actualSession.prepareCronSession);
    loadSessionEntryMock.mockImplementation(actualSession.loadCronSessionEntryLatest);
    patchSessionEntryMock.mockImplementation(accessor.patchSessionEntryCore);
    runEmbeddedAgentMock.mockImplementation((params: RunEmbeddedAgentParams) =>
      enqueueCommandInLane(
        resolveSessionLane(params.sessionKey ?? params.sessionId),
        async () => completedTurn(),
        {
          abortSignal: params.abortSignal,
          onQueued: () => params.onLaneWait?.({ waiting: true, waitMs: 0, queuedAhead: 1 }),
        },
      ),
    );
  });

  it.for([
    { name: "legacy row", stale: false, cancel: false, settle: false },
    { name: "stale row", stale: true, cancel: false, settle: false },
    { name: "cancelled lane wait", stale: false, cancel: true, settle: false },
    { name: "post-lane settlement", stale: false, cancel: false, settle: true },
    { name: "cancelled settlement wait", stale: false, cancel: true, settle: true },
  ])("preserves the generation through $name", async ({ stale, cancel, settle }, { signal }) => {
    const { target, entry, lane } = await seedSession(stale);
    const previous = settle
      ? await beginSessionWorkAdmission({
          scope: target.storePath,
          identities: [target.sessionKey, target.sessionId],
          assertAllowed: () => {},
        })
      : undefined;
    const occupied = createDeferred();
    const releaseLane = createDeferred();
    const laneWait = createDeferred();
    const settlementWait = createDeferred();
    let laneReleased = false;
    const blocker = enqueueCommandInLane(lane, async () => {
      occupied.resolve();
      await releaseLane.promise;
    });
    await occupied.promise;
    const controller = new AbortController();
    const run = startCron(target, {
      abortSignal: controller.signal,
      onLaneWait: (info) => {
        if (info?.waiting) {
          (laneReleased ? settlementWait : laneWait).resolve();
        }
      },
    });
    try {
      await withinTest(
        awaitGateBeforeSettlement(laneWait.promise, run, "Cron missed the busy lane"),
        signal,
      );
      expect(accessor.loadSessionEntry(target)?.lifecycleRevision).toBe(entry.lifecycleRevision);
      expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
      if (previous) {
        laneReleased = true;
        releaseLane.resolve();
        await withinTest(
          awaitGateBeforeSettlement(
            settlementWait.promise,
            run,
            "Cron overtook post-lane settlement",
          ),
          signal,
        );
        expect(resolveCronSessionMock).not.toHaveBeenCalled();
      }
      if (cancel) {
        controller.abort(new Error("Scheduled turn cancelled"));
        await expect(run).rejects.toThrow("Scheduled turn cancelled");
        expect(accessor.loadSessionEntry(target)?.lifecycleRevision).toBeUndefined();
        expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
        if (previous) {
          expect(previous.isActive()).toBe(true);
        }
      } else {
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
        if (previous) {
          await previous.run(() => accessor.patchSessionEntryCore(target, () => terminal));
          previous.release();
        }
        releaseLane.resolve();
        await expect(withinTest(run, signal)).resolves.toMatchObject({ status: "ok" });
        const committed = accessor.loadSessionEntry(target);
        expect(committed?.lifecycleRevision).toEqual(expect.any(String));
        expect(committed?.lifecycleRevision).not.toBe(entry.lifecycleRevision);
        expect(committed?.sessionId).toBe(target.sessionId);
        if (previous) {
          expect(committed).toMatchObject(terminal);
        }
      }
    } finally {
      controller.abort();
      releaseLane.resolve();
      previous?.release();
      await Promise.allSettled([blocker, run]);
    }
  });

  it("does not wait on an inherited admission", async ({ signal }) => {
    const { target } = await seedSession();
    const inherited = await beginSessionWorkAdmission({
      scope: target.storePath,
      identities: [target.sessionKey, target.sessionId],
      assertAllowed: () => {},
    });
    const run = inherited.run(() => startCron(target, { abortSignal: signal }));
    try {
      await expect(withinTest(run, signal)).resolves.toMatchObject({ status: "ok" });
      expect(inherited.isActive()).toBe(true);
    } finally {
      inherited.release();
      await run.catch(() => {});
    }
  });

  it("keeps queued cron turns in order when their predecessor set changes", async ({ signal }) => {
    const { target, lane } = await seedSession();
    const previous = await beginSessionWorkAdmission({
      scope: target.storePath,
      identities: [target.sessionKey, target.sessionId],
      assertAllowed: () => {},
    });
    const firstWaiting = createDeferred();
    const firstRequeued = createDeferred();
    const secondWaiting = createDeferred();
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const order: string[] = [];
    runEmbeddedAgentMock.mockImplementation((params: RunEmbeddedAgentParams) =>
      enqueueCommandInLane(lane, async () => {
        const name = params.prompt.includes("fifo-first") ? "first" : "second";
        order.push(name);
        if (name === "first") {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        return completedTurn();
      }),
    );
    const first = startCron(target, {
      name: "fifo-first",
      abortSignal: signal,
      onLaneWait: (info) => {
        if (info?.waiting) {
          (previous.isActive() ? firstWaiting : firstRequeued).resolve();
        }
      },
    });
    let second: ReturnType<typeof startCron> | undefined;
    let later: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          firstWaiting.promise,
          Promise.race([first, firstStarted.promise]),
          "First cron executed before prior settlement",
        ),
        signal,
      );
      later = await beginSessionWorkAdmission({
        scope: target.storePath,
        identities: [target.sessionKey, target.sessionId],
        assertAllowed: () => {},
      });
      second = startCron(target, {
        name: "fifo-second",
        abortSignal: signal,
        onLaneWait: (info) => info?.waiting && secondWaiting.resolve(),
      });
      await withinTest(
        awaitGateBeforeSettlement(secondWaiting.promise, second, "Second cron skipped settlement"),
        signal,
      );
      expect(order).toEqual([]);
      previous.release();
      await withinTest(
        awaitGateBeforeSettlement(
          firstRequeued.promise,
          first,
          "First cron skipped the later admission",
        ),
        signal,
      );
      later.release();
      await withinTest(
        awaitGateBeforeSettlement(firstStarted.promise, first, "First cron did not start"),
        signal,
      );
      expect(order).toEqual(["first"]);
      releaseFirst.resolve();
      await expect(withinTest(Promise.all([first, second]), signal)).resolves.toEqual([
        expect.objectContaining({ status: "ok" }),
        expect.objectContaining({ status: "ok" }),
      ]);
      expect(order).toEqual(["first", "second"]);
    } finally {
      previous.release();
      later?.release();
      releaseFirst.resolve();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
  });
});
