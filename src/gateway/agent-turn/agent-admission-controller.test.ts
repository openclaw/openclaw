import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { runExclusiveSessionStoreWrite } from "../../config/sessions/store-writer.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { beginSessionEffect } from "../../sessions/session-controller.lifecycle.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createAgentAdmissionController } from "./agent-admission-controller.js";
import { createAgentDedupeLifecycle } from "./agent-dedupe-lifecycle.js";
import { createAgentTurnIo } from "./io.js";

const readEntry = vi.hoisted(() => vi.fn());
// mock-isolation: Lease-admission fixtures control prepared and committed rows without opening storage.
vi.mock("../session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: readEntry,
}));

function admission(sessionKey: string, runId: string, sessionId: string, expected = false) {
  const state: { entry: SessionEntry | undefined; admittedSessionId: string } = {
    entry: { sessionId, updatedAt: 1 },
    admittedSessionId: sessionId,
  };
  const context = createDirectChatContext({ getRuntimeConfig: () => ({}) });
  const io = createAgentTurnIo(vi.fn());
  const agentDedupeKeys = [runId];
  const controller = createAgentAdmissionController({
    runId,
    agentDedupeKeys,
    expectedSession: expected ? { sessionId } : undefined,
    context,
    io,
    dedupeLifecycle: createAgentDedupeLifecycle({
      cfg: {},
      request: { message: "continue", idempotencyKey: runId },
      runId,
      agentDedupeKeys,
      suppressVisibleSessionEffects: false,
      context,
      io,
    }),
    getRequestedSessionKey: () => sessionKey,
    getResolvedSessionKey: () => sessionKey,
    getResolvedSessionId: () => state.admittedSessionId,
    getSessionEntry: () => state.entry,
    setSessionEntry: (current) => {
      state.entry = current;
    },
    getResolvedSessionAgentId: () => "main",
    getAgentId: () => "main",
    getSessionPersisted: () => true,
    getSupersededSessionId: () => undefined,
    setAdmittedSessionId: (current) => {
      state.admittedSessionId = current;
    },
  });
  return { controller, state };
}

it.for(["other session", "same session"])(
  "orders marker admission against %s replay",
  async (replay, { signal }) => {
    const sessionKey = "agent:main:dashboard:acceptance-marker";
    const replayKey = replay === "same session" ? sessionKey : "agent:main:dashboard:recovery";
    const scope = `agent-admission-replay-${replay}.sqlite`;
    const replayEntered = createDeferred();
    const releaseReplay = createDeferred();
    const replayAdmission = beginSessionEffect({
      scope,
      identities: [replayKey],
      storeWriterIdentities: [replayKey],
      signal,
      assertAllowed: async () => {
        replayEntered.resolve();
        await releaseReplay.promise;
      },
    });
    readEntry.mockReset().mockResolvedValue({ entry: { sessionId: "marker", updatedAt: 1 } });
    const runId = `marker-${replay}`;
    const { controller } = admission(sessionKey, runId, "marker");
    let marker: Promise<void> | undefined;
    try {
      await withinTest(replayEntered.promise, signal);
      marker = controller.acquire(scope);
      if (replay === "same session") {
        await withinTest(
          runExclusiveSessionStoreWrite(scope, async () => {}, {
            identities: ["agent:main:dashboard:independent"],
            signal,
          }),
          signal,
        );
        expect(readEntry).not.toHaveBeenCalled();
      } else {
        await withinTest(marker, signal);
        expect(readEntry).toHaveBeenCalledOnce();
      }
    } finally {
      releaseReplay.resolve();
      await Promise.allSettled([
        replayAdmission.then((lease) => lease.release()),
        ...(marker ? [marker] : []),
      ]);
      controller.release();
    }
    await expect(marker).resolves.toBeUndefined();
    expect(readEntry).toHaveBeenCalledOnce();
  },
);

it.each([false, true])(
  "refreshes after the lifecycle lease and keeps committed state (expected=%s)",
  async (expected) => {
    const sessionKey = `agent:main:admission-owner-${expected}`;
    readEntry.mockReset().mockResolvedValue({
      entry: { sessionId: "replacement", updatedAt: 2 },
    });
    const runId = `admission-owner-${expected}`;
    const { controller, state } = admission(sessionKey, runId, "prepared", expected);
    try {
      if (expected) {
        await expect(controller.acquire(runId)).rejects.toThrow("changed while starting");
      } else {
        await controller.acquire(runId);
        expect(state.admittedSessionId).toBe("replacement");
        // The committing owner installs its postimage before the next synchronous guard.
        state.entry = { sessionId: "committed", updatedAt: 3 };
        controller.assertAllowed();
        expect(state.admittedSessionId).toBe("committed");
        state.entry = { ...state.entry, archivedAt: 4 };
        expect(() => controller.assertAllowed()).toThrow(/archived/i);
      }
      expect(readEntry).toHaveBeenCalledTimes(1);
    } finally {
      controller.release();
    }
  },
);
