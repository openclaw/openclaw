// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  deleteSession,
  getSession,
  waitForExecSession,
  type ProcessSession,
} from "../../agents/bash-process-registry.js";
import type { AgentCommandDeliveryResult } from "../../agents/command/delivery-result.js";
import type { AgentCommandOpts } from "../../agents/command/types.js";
import { createLazyExecTool } from "../../agents/lazy-exec-tool.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { getProcessSupervisor } from "../../process/supervisor/index.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createAgentDedupeLifecycle } from "../agent-turn/agent-dedupe-lifecycle.js";
import { waitForAgentJob } from "../agent-turn/agent-job.js";
import { dispatchAgentRunFromGateway } from "../agent-turn/agent-run-dispatch.js";
import { registerChatAbortController } from "../chat-abort.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";
import * as transcriptPersistence from "./chat-transcript-persistence.js";
import { sessionAbortHandlers } from "./sessions-abort.js";
import type { RespondFn } from "./types.js";

const fixture = useChatAbortRegistryFixture();

const dispatchMocks = vi.hoisted(() => ({
  agentCommand: vi.fn(
    async (
      _options: AgentCommandOpts,
    ): Promise<
      Pick<AgentCommandDeliveryResult, "payloads"> & {
        meta: Partial<AgentCommandDeliveryResult["meta"]>;
      }
    > => ({ payloads: [], meta: {} }),
  ),
}));
vi.mock("../../commands/agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/agent.js")>()),
  agentCommandFromGatewayIngress: dispatchMocks.agentCommand,
}));

it.each([
  { method: "sessions.abort", hidden: false },
  { method: "chat.abort", hidden: false },
  { method: "chat.abort", hidden: true },
] as const)(
  "$method stops direct-agent residual exec without rewriting its completed receipt (hidden=$hidden)",
  async ({ method, hidden }) => {
    const caseId = `${method}-${hidden ? "hidden" : "visible"}`;
    const scope = {
      agentId: "main",
      sessionKey: `agent:main:completed-exec-${caseId}`,
      sessionId: `completed-exec-session-${caseId}`,
    };
    const runId = `completed-exec-run-${caseId}`;
    const ownerDeviceId = "completed-exec-owner";
    const context = createDirectChatContext({ getRuntimeConfig });
    await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const registration = registerChatAbortController({
      chatAbortControllers: context.chatAbortControllers,
      ...scope,
      runId,
      ownerDeviceId,
      controlUiVisible: !hidden,
      timeoutMs: 60_000,
    });
    expect(registration.markExecutionStarted()).toBe(true);
    let processSession: ProcessSession | undefined;
    const terminalReply = {
      disposition: "visible" as const,
      text: "The command is still running.",
    };
    const key = `agent:${runId}`;
    const emitFinal = vi.fn();
    try {
      dispatchMocks.agentCommand.mockImplementationOnce(async (options) => {
        // Actor and visibility come only from dispatch's registered owner, never tool defaults.
        const tool = createLazyExecTool({
          ...scope,
          runId,
          config: getRuntimeConfig(),
          host: "gateway",
          mode: "full",
          ask: "off",
          cwd: fixture.stateDir,
          scopeKey: scope.sessionKey,
          allowBackground: true,
          notifyOnExit: false,
          preparedStoreEnvironment: {},
        });
        // A native watcher keeps the real command alive without test sleeps or polling.
        const result = await tool.execute(
          "residual-command",
          {
            command: `node -e "require('fs').watch('.', () => {})"`,
            yieldMs: 10,
            timeoutSeconds: 60,
          },
          options.abortSignal,
        );
        const details = asOptionalRecord(result.details);
        expect(details?.status).toBe("running");
        if (details?.status !== "running" || typeof details.sessionId !== "string") {
          throw new Error("Expected an ordinary command to yield its process handle");
        }
        processSession = expectDefined(getSession(details.sessionId), "running ordinary command");
        return { payloads: [], meta: { terminalReply } };
      });
      await withEnvAsync({ OPENCLAW_EXEC_SHELL_SNAPSHOT: "0" }, () =>
        dispatchAgentRunFromGateway({
          admittedRunEntry: registration.entry,
          ingressOpts: {
            ...scope,
            runId,
            message: "Start a command and return while it is still running.",
            allowModelOverride: false,
            abortSignal: registration.controller.signal,
          },
          runId,
          dedupeKeys: [key],
          abortController: registration.controller,
          cleanupAbortController: registration.cleanup,
          io: { emitAcceptance: vi.fn(), emitFinal },
          context,
        }),
      );
      expect(emitFinal).toHaveBeenCalledWith(
        [true, expect.objectContaining({ status: "ok" }), undefined],
        expect.objectContaining({ runId }),
      );
      const command = expectDefined(processSession, "direct Gateway command process");
      const receipt = expectDefined(context.dedupe.get(key), "completed model receipt");
      const completed = await waitForAgentJob({ runId, source: "agent", timeoutMs: 0 });
      expect(completed).toMatchObject({ status: "ok", terminalReply });
      expect(context.chatAbortControllers.size).toBe(0);
      expect(command.exited).toBe(false);
      const stop = async (deviceId: string, exact = true) => {
        const respond = vi.fn<RespondFn>();
        const handler =
          method === "chat.abort" ? handleChatAbortRequest : sessionAbortHandlers[method]!;
        await handler({
          req: { type: "req", id: "stop-completed-exec", method },
          params:
            method === "chat.abort"
              ? { sessionKey: scope.sessionKey, ...(exact ? { runId } : {}) }
              : { key: scope.sessionKey },
          context,
          client: sharingPolicyClient({ deviceId }),
          respond,
          isWebchatConnect: () => false,
        });
        return respond;
      };
      if (hidden) {
        const preserved = await stop(ownerDeviceId, false);
        expect(preserved).toHaveBeenCalledExactlyOnceWith(true, {
          ok: true,
          aborted: false,
          runIds: [],
        });
        expect(command.exited).toBe(false);
        expect(command.cancellationRequested).not.toBe(true);
      }
      if (method === "chat.abort") {
        const denied = await stop("unrelated-device");
        expect(denied).toHaveBeenCalledExactlyOnceWith(
          false,
          undefined,
          expect.objectContaining({ code: "INVALID_REQUEST", message: "unauthorized" }),
        );
        expect(command.exited).toBe(false);
        expect(command.cancellationRequested).not.toBe(true);
        expect(context.dedupe.get(key)).toBe(receipt);
      }
      const stopped = await stop(ownerDeviceId);
      expect(stopped).toHaveBeenCalledOnce();
      expect(stopped.mock.calls[0]?.slice(0, 2)).toEqual([
        true,
        method === "chat.abort"
          ? { ok: true, aborted: true, runIds: [] }
          : { ok: true, abortedRunId: null, status: "aborted" },
      ]);
      expect(command).toMatchObject({ exited: true, exitReason: "manual-cancel" });
      expect(command.finalizationFailed).not.toBe(true);
      expect(context.dedupe.get(key)).toBe(receipt);
      expect(await waitForAgentJob({ runId, source: "agent", timeoutMs: 0 })).toEqual(completed);
    } finally {
      registration.cleanup();
      if (processSession) {
        getProcessSupervisor().cancel(processSession.id, "manual-cancel");
        await waitForExecSession(processSession);
        deleteSession(processSession.id);
      }
    }
  },
);

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
        expect(context.dedupe.get(key)?.payload).not.toHaveProperty("timeoutPhase");
        expect(context.dedupe.get(key)?.payload).not.toHaveProperty("providerStarted");
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
