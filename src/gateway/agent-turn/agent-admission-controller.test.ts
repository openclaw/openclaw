import { describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { runExclusiveSessionStoreWrite } from "../../config/sessions/store-writer.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createAgentAdmissionController } from "./agent-admission-controller.js";
import { createAgentDedupeLifecycle } from "./agent-dedupe-lifecycle.js";
import { createAgentTurnIo } from "./io.js";

const readEntry = vi.hoisted(() => vi.fn());
// mock-isolation: Lease-admission fixtures control prepared and committed rows without opening storage.
vi.mock("../session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: readEntry,
}));

describe("agent admission session ownership", () => {
  it.for(["other session", "same session"])(
    "orders marker admission against pending replay for %s",
    async (replay, { signal }) => {
      const sessionKey = "agent:main:dashboard:acceptance-marker";
      const replayKey = replay === "same session" ? sessionKey : "agent:main:dashboard:recovery";
      const scope = `agent-admission-replay-${replay}.sqlite`;
      const replayEntered = createDeferred();
      const releaseReplay = createDeferred();
      const replayAdmission = beginSessionWorkAdmission({
        scope,
        identities: [replayKey],
        storeWriterIdentities: [replayKey],
        signal,
        assertAllowed: async () => {
          replayEntered.resolve();
          await releaseReplay.promise;
        },
      });
      let entry: SessionEntry | undefined = { sessionId: "marker", updatedAt: 1 };
      readEntry.mockReset().mockResolvedValue({ entry });
      const context = createDirectChatContext({ getRuntimeConfig: () => ({}) });
      const io = createAgentTurnIo(vi.fn());
      const runId = `marker-${replay}`;
      const agentDedupeKeys = [runId];
      const dedupeLifecycle = createAgentDedupeLifecycle({
        cfg: {},
        request: { message: "marker", idempotencyKey: runId },
        runId,
        agentDedupeKeys,
        suppressVisibleSessionEffects: false,
        context,
        io,
      });
      const controller = createAgentAdmissionController({
        runId,
        agentDedupeKeys,
        context,
        io,
        dedupeLifecycle,
        getRequestedSessionKey: () => sessionKey,
        getResolvedSessionKey: () => sessionKey,
        getResolvedSessionId: () => "marker",
        getSessionEntry: () => entry,
        setSessionEntry: (current) => {
          entry = current;
        },
        getResolvedSessionAgentId: () => "main",
        getAgentId: () => "main",
        getSessionPersisted: () => true,
        getSupersededSessionId: () => undefined,
        setAdmittedSessionId: () => {},
      });
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
    "refreshes after acquiring the lifecycle lease and keeps committed state (expected=%s)",
    async (expected) => {
      const sessionKey = `agent:main:admission-owner-${expected}`;
      let entry: SessionEntry | undefined = { sessionId: "prepared", updatedAt: 1 };
      let admittedSessionId = "prepared";
      readEntry.mockReset().mockResolvedValue({
        entry: { sessionId: "replacement", updatedAt: 2 },
      });
      const context = createDirectChatContext({ getRuntimeConfig: () => ({}) });
      const io = createAgentTurnIo(vi.fn());
      const runId = `admission-owner-${expected}`;
      const agentDedupeKeys = [runId];
      const dedupeLifecycle = createAgentDedupeLifecycle({
        cfg: {},
        request: { message: "continue", idempotencyKey: runId },
        runId,
        agentDedupeKeys,
        suppressVisibleSessionEffects: false,
        context,
        io,
      });
      const controller = createAgentAdmissionController({
        runId,
        agentDedupeKeys,
        expectedSession: expected ? { sessionId: "prepared" } : undefined,
        context,
        io,
        dedupeLifecycle,
        getRequestedSessionKey: () => sessionKey,
        getResolvedSessionKey: () => sessionKey,
        getResolvedSessionId: () => admittedSessionId,
        getSessionEntry: () => entry,
        setSessionEntry: (current) => {
          entry = current;
        },
        getResolvedSessionAgentId: () => "main",
        getAgentId: () => "main",
        getSessionPersisted: () => true,
        getSupersededSessionId: () => undefined,
        setAdmittedSessionId: (sessionId) => {
          admittedSessionId = sessionId;
        },
      });
      try {
        if (expected) {
          await expect(controller.acquire(runId)).rejects.toThrow("changed while starting");
        } else {
          await controller.acquire(runId);
          expect(admittedSessionId).toBe("replacement");
          // The committing owner installs its postimage before the next synchronous guard.
          entry = { sessionId: "committed", updatedAt: 3 };
          controller.assertAllowed();
          expect(admittedSessionId).toBe("committed");
          entry = { ...entry, archivedAt: 4 };
          expect(() => controller.assertAllowed()).toThrow(/archived/i);
        }
        expect(readEntry).toHaveBeenCalledTimes(1);
      } finally {
        controller.release();
      }
    },
  );
});
