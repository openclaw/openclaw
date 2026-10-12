import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createAgentAdmissionController } from "./agent-admission-controller.js";
import { createAgentDedupeLifecycle } from "./agent-dedupe-lifecycle.js";
import { createAgentTurnIo } from "./io.js";

const readEntry = vi.hoisted(() => vi.fn());
vi.mock("../session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: readEntry,
}));

describe("agent admission session ownership", () => {
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
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      const runId = `admission-owner-${expected}`;
      const agentDedupeKeys = [runId];
      const dedupeLifecycle = createAgentDedupeLifecycle({
        cfg: {},
        request: { message: "continue", idempotencyKey: runId },
        runId,
        lifecycleGeneration,
        agentDedupeKeys,
        suppressVisibleSessionEffects: false,
        context,
        io,
      });
      const controller = createAgentAdmissionController({
        runId,
        lifecycleGeneration,
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
