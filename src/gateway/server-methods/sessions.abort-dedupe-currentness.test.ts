import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { createAgentDedupeLifecycle } from "../agent-turn/agent-dedupe-lifecycle.js";
import { registerChatAbortController } from "../chat-abort.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import * as transcriptPersistence from "./chat-transcript-persistence.js";
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { sessionAbortHandlers } from "./sessions-abort.js";
import type { RespondFn } from "./types.js";

useChatAbortRegistryFixture();

it.each(["unchanged", "absent", "successor", "successor from absent"] as const)(
  "sessions.abort preserves the %s receipt after committed partial persistence",
  async (mode) => {
    const scope = { agentId: "main", sessionKey: "agent:main:abort-receipt" };
    const sessionId = "abort-receipt-session";
    const runId = "abort-receipt-run";
    const key = `agent:${runId}`;
    const context = createDirectChatContext({ getRuntimeConfig });
    await replaceSessionEntry(scope, { sessionId, updatedAt: 1 });
    const reserve = () => {
      const lifecycle = createAgentDedupeLifecycle({
        cfg: getRuntimeConfig(),
        request: { message: "Continue durable input", idempotencyKey: runId },
        runId,
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        agentDedupeKeys: [key],
        suppressVisibleSessionEffects: false,
        privateCompletion: true,
        context,
        io: { emitAcceptance: vi.fn(), emitFinal: vi.fn() },
      });
      lifecycle.reserve(scope.sessionKey, scope.agentId);
      lifecycle.bindSessionTarget({ ...scope, sessionId });
      return lifecycle;
    };
    const original = mode === "unchanged" || mode === "successor" ? reserve() : undefined;
    const originalReceipt = context.dedupe.get(key);
    const removed = createDeferred();
    const registration = registerChatAbortController({
      chatAbortControllers: context.chatAbortControllers,
      ...scope,
      sessionId,
      runId,
      kind: "agent",
      timeoutMs: 60_000,
      onRemoved: () => removed.resolve(),
    });
    expect(registration.registered).toBe(true);
    expect(registration.markExecutionStarted()).toBe(true);
    context.chatRunState.getOrCreate(runId).buffer = "Predecessor partial";
    const committed = createDeferred();
    const release = createDeferred();
    const persist = transcriptPersistence.persistAbortedPartials;
    const persistence = vi
      .spyOn(transcriptPersistence, "persistAbortedPartials")
      .mockImplementation(async (params) => {
        // Hold the return after the real COMMIT, never the SQLite writer or controller cleanup.
        await persist(params);
        committed.resolve();
        await release.promise;
      });
    const respond = vi.fn<RespondFn>();
    const request = Promise.resolve(
      sessionAbortHandlers["sessions.abort"]!({
        req: { type: "req", id: "abort-receipt", method: "sessions.abort" },
        params: { key: scope.sessionKey, runId },
        context,
        client: null,
        respond,
        isWebchatConnect: () => false,
      }),
    );
    let successor: ReturnType<typeof registerChatAbortController> | undefined;
    try {
      await expect(
        Promise.race([committed.promise.then(() => true), request.then(() => false)]),
      ).resolves.toBe(true);
      expect(registration.controller.signal.aborted).toBe(true);
      expect(context.chatAbortControllers.has(runId)).toBe(false);
      await removed.promise;
      expect(respond).not.toHaveBeenCalled();
      expect(context.dedupe.get(key)).toBe(originalReceipt);
      const transcriptScope = { ...scope, sessionId };
      const committedTranscript = await loadTranscriptEvents(transcriptScope);
      expect(
        committedTranscript.filter((event) => asOptionalRecord(event)?.type === "message"),
      ).toEqual([
        expect.objectContaining({
          message: expect.objectContaining({
            role: "assistant",
            content: [{ type: "text", text: "Predecessor partial" }],
          }),
        }),
      ]);
      const replacesReceipt = mode === "successor" || mode === "successor from absent";
      let successorReceipt: typeof originalReceipt;
      if (replacesReceipt) {
        const reservation = reserve();
        successorReceipt = expectDefined(context.dedupe.get(key), "successor receipt");
        expect(successorReceipt).not.toBe(originalReceipt);
        expect(reservation.reservationId).not.toBe(original?.reservationId);
        expect(successorReceipt.payload).toMatchObject({
          runId,
          reservationId: reservation.reservationId,
          status: "accepted",
          sessionId,
          sessionKey: scope.sessionKey,
        });
        successor = registerChatAbortController({
          chatAbortControllers: context.chatAbortControllers,
          ...scope,
          sessionId,
          runId,
          kind: "agent",
          timeoutMs: 60_000,
        });
        expect(successor.registered).toBe(true);
        context.chatRunState.getOrCreate(runId).buffer = "Successor partial";
      }
      release.resolve();
      await request;
      expect(respond).toHaveBeenCalledExactlyOnceWith(
        true,
        { ok: true, abortedRunId: runId, status: "aborted" },
        undefined,
        undefined,
      );
      expect(persistence).toHaveBeenCalledOnce();
      expect(await loadTranscriptEvents(transcriptScope)).toEqual(committedTranscript);
      if (replacesReceipt) {
        expect(context.dedupe.get(key)).toBe(successorReceipt);
        expect(context.chatAbortControllers.get(runId)).toBe(successor?.entry);
        expect(successor?.controller.signal.aborted).toBe(false);
        expect(context.chatRunState.resolveBuffer(runId, { final: true }).text).toBe(
          "Successor partial",
        );
      } else {
        expect(context.dedupe.get(key)?.payload).toMatchObject({
          runId,
          status: "timeout",
          stopReason: "rpc",
        });
      }
    } finally {
      release.resolve();
      await request.catch(() => {});
      persistence.mockRestore();
      successor?.cleanup();
      registration.cleanup();
      context.chatRunState.clearRun(runId);
    }
  },
);
