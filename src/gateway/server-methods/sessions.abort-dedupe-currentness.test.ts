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
import { updateRpcSourceSessionId } from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createAgentDedupeLifecycle } from "../agent-turn/agent-dedupe-lifecycle.js";
import { waitForAgentJob } from "../agent-turn/agent-job.js";
import * as agentJob from "../agent-turn/agent-job.js";
import { dispatchAgentRunFromGateway } from "../agent-turn/agent-run-dispatch.js";
import { registerChatAbortController } from "../chat-abort.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { withGatewaySessionEntry } from "../session-utils-store.js";
import { claimRpcSourceForTest } from "../test-helpers.rpc-source.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";
import * as transcriptPersistence from "./chat-transcript-persistence.js";
import { captureRpcTargetForTest } from "./rpc-source-fixtures.test-support.js";
import { sessionAbortHandlers } from "./sessions-abort.js";
import { stopSession } from "./sessions.abort-lifecycle.test-support.js";
import type { RespondFn } from "./types.js";

const fixture = useChatAbortRegistryFixture();
type CommandReply = Pick<AgentCommandDeliveryResult, "payloads"> & {
  meta: Partial<AgentCommandDeliveryResult["meta"]>;
};

const dispatchMocks = vi.hoisted(() => ({
  agentCommand: vi.fn<(options: AgentCommandOpts) => Promise<CommandReply>>(),
}));
vi.mock("../../commands/agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/agent.js")>()),
  agentCommandFromGatewayIngress: dispatchMocks.agentCommand,
}));

async function abortTarget(id = "abort-receipt") {
  const scope = { agentId: "main", sessionKey: `agent:main:${id}`, sessionId: id };
  const runId = `run-${id}`;
  const context = createDirectChatContext({ getRuntimeConfig });
  await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const sourceTarget = await withGatewaySessionEntry(
    scope.sessionKey,
    { agentId: scope.agentId },
    (session) => captureRpcTargetForTest({ ...scope, storeScope: session.storePath }),
  );
  const register = (options: Partial<Parameters<typeof registerChatAbortController>[0]> = {}) =>
    registerChatAbortController({
      target: sourceTarget,
      ...scope,
      runId,
      timeoutMs: 60_000,
      ...options,
    });
  return { scope, runId, key: `agent:${runId}`, context, register };
}

async function startExecution(
  registration: ReturnType<typeof registerChatAbortController>,
  releaseOnAbort = false,
) {
  const entry = expectDefined(registration.entry, "registered RPC source");
  const release = await claimRpcSourceForTest(entry);
  if (releaseOnAbort) {
    registration.controller.signal.addEventListener("abort", release, { once: true });
  }
  registration.initializeTiming();
  expect(registration.markExecutionStarted()).toBe(true);
  return release;
}

function expectStopped(respond: RespondFn, runId: string) {
  expect(respond).toHaveBeenCalledExactlyOnceWith(
    true,
    { ok: true, abortedRunId: runId, status: "aborted" },
    undefined,
    undefined,
  );
}

it.each([
  { method: "sessions.abort", hidden: false },
  { method: "chat.abort", hidden: false },
  { method: "chat.abort", hidden: true },
] as const)(
  "$method stops direct-agent residual exec without rewriting its completed receipt (hidden=$hidden)",
  async ({ method, hidden }) => {
    const { scope, runId, key, context, register } = await abortTarget(`${method}-${hidden}`);
    const ownerDeviceId = "completed-exec-owner";
    const registration = register({ ownerDeviceId, controlUiVisible: !hidden });
    const releaseExecution = await startExecution(registration);
    let processSession: ProcessSession | undefined;
    const terminalReply = { disposition: "visible" as const, text: "Still running." };
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
          cleanupAbortController: () => {
            releaseExecution();
            registration.cleanup();
          },
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
      const completion = () => waitForAgentJob({ runId, source: "agent", timeoutMs: 0 });
      const completed = await completion();
      expect(completed).toMatchObject({ status: "ok", terminalReply });
      expect(rpcSourceTesting.size).toBe(0);
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
      expect(await completion()).toEqual(completed);
    } finally {
      releaseExecution();
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
    const { scope, runId, key, context, register } = await abortTarget();
    const { sessionId } = scope;
    const reserve = () => {
      const lifecycle = createAgentDedupeLifecycle({
        cfg: getRuntimeConfig(),
        request: { message: "Continue durable input", idempotencyKey: runId },
        runId,
        agentDedupeKeys: [key],
        suppressVisibleSessionEffects: false,
        reconcileDurableInput: true,
        context,
        io: { emitAcceptance: vi.fn(), emitFinal: vi.fn() },
      });
      lifecycle.reserve(scope.sessionKey, scope.agentId);
      lifecycle.bindSessionTarget(scope);
      return lifecycle;
    };
    const original = mode === "unchanged" || mode === "successor" ? reserve() : undefined;
    const originalReceipt = context.dedupe.get(key);
    const removed = createDeferred();
    const registration = register({ kind: "agent", onRemoved: () => removed.resolve() });
    expect(registration.registered).toBe(true);
    const releaseExecution = await startExecution(registration, true);
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
      stopSession(scope.sessionKey, respond, context, { runId }, null),
    );
    let successor: ReturnType<typeof registerChatAbortController> | undefined;
    try {
      await expect(
        Promise.race([committed.promise.then(() => true), request.then(() => false)]),
      ).resolves.toBe(true);
      expect(registration.controller.signal.aborted).toBe(true);
      expect(rpcSourceTesting.has(runId)).toBe(false);
      await removed.promise;
      expect(respond).not.toHaveBeenCalled();
      expect(context.dedupe.get(key)).toBe(originalReceipt);
      const committedTranscript = await loadTranscriptEvents(scope);
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
        successor = register({ kind: "agent" });
        expect(successor.registered).toBe(true);
        context.chatRunState.getOrCreate(runId).buffer = "Successor partial";
      }
      release.resolve();
      await request;
      expectStopped(respond, runId);
      expect(persistence).toHaveBeenCalledOnce();
      expect(await loadTranscriptEvents(scope)).toEqual(committedTranscript);
      if (replacesReceipt) {
        expect(context.dedupe.get(key)).toBe(successorReceipt);
        expect(rpcSourceTesting.get(runId)).toBe(successor?.entry);
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
      releaseExecution();
      successor?.cleanup();
      registration.cleanup();
      context.chatRunState.clearRun(runId);
    }
  },
);

it("sessions.abort records the rotated RPC source identity on its terminal receipt", async () => {
  const { scope, runId, context, register } = await abortTarget("rotated-abort-receipt");
  const rotatedSessionId = "rotated-abort-receipt-session";
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const registration = register({ lifecycleGeneration, kind: "chat-send" });
  const entry = expectDefined(registration.entry, "registered RPC source");
  const releaseExecution = await startExecution(registration, true);
  await replaceSessionEntry(scope, { sessionId: rotatedSessionId, updatedAt: 2 });
  updateRpcSourceSessionId(entry, rotatedSessionId);
  context.chatRunState.getOrCreate(runId).buffer = "Rotated abort partial";
  const respond = vi.fn<RespondFn>();
  const setDedupeEntry = vi.spyOn(agentJob, "setGatewayDedupeEntry");

  try {
    await stopSession(scope.sessionKey, respond, context, { runId }, null);
    expectStopped(respond, runId);
    const expectedSession = {
      ...scope,
      sessionId: rotatedSessionId,
      lifecycleGeneration,
    };
    expect(setDedupeEntry).toHaveBeenCalledWith(
      expect.objectContaining({ key: `chat:${runId}`, session: expectedSession }),
    );
    expect(agentJob.getAgentJobSession(runId, "chat")).toEqual(expectedSession);
  } finally {
    setDedupeEntry.mockRestore();
    releaseExecution();
    registration.cleanup();
    context.chatRunState.clearRun(runId);
  }
});
