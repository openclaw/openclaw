import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../../test/helpers/promise.js";
import * as operationAdmission from "../../../infra/sqlite-worker-operation-admission.js";
import { trackSessionControllerSourceWork } from "../../../sessions/session-controller.mailbox.js";
import {
  getRpcSource,
  registerRpcSource,
  requestRpcSourceCancellation,
  retireRpcSource,
} from "../../../sessions/session-controller.rpc-sources.js";
import { closeOpenClawAgentDatabasesAsync } from "../../../state/openclaw-agent-db-lifecycle.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "../../../state/openclaw-agent-write-admission.js";
import {
  captureClientVoiceSessionSettlement,
  prepareClientVoiceSessionClose,
} from "../../../talk/client-voice-session-lifecycle.js";
import type { ClientVoiceSessionSource } from "../../../talk/client-voice-session-source.js";
import { readVoiceSessionRecord } from "../../../talk/client-voice-session-store.js";
import {
  ensureClientVoiceAgentSessionEntry,
  type ClientVoiceSessionWriter,
} from "../../../talk/client-voice-session-write.js";
import * as voiceSessions from "../../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import { createGatewayRequestContext } from "../../server-request-context.js";
import { makeContextParams } from "../../server-request-context.test-support.js";
import { claimRpcSourceForTest, createRpcSourceForTest } from "../../test-helpers.rpc-source.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import { createIdleRelayProvider } from "./index.test-support.js";
import {
  cancelTalkRealtimeRelayProviderToolCall,
  closeRelaySession,
  registerTalkRealtimeRelayAgentRun,
} from "./operations.js";
import { clearRelayAgentToolCall } from "./provider-results.js";
import { createTalkRealtimeRelaySession } from "./session-create.js";
import { usePersistentRelayTestState } from "./session-state.test-support.js";
import { adoptRelayProviderToolCallId, relaySessions, type RelaySession } from "./state.js";
import { enqueueRelayVoiceTranscript, ensureRelayVoiceSession } from "./voice.js";

const activeRelaySessions = new Map<string, string>();
usePersistentRelayTestState(activeRelaySessions);

async function createControllerSource(
  relay: RelaySession,
  identity: { runId: string; sessionId: string },
) {
  const source = createRpcSourceForTest(
    { requester: { connectionId: relay.connId }, kind: "chat-send" },
    {
      ...identity,
      sessionKey: relay.sessionTarget.canonicalKey,
      agentId: relay.sessionTarget.agentId,
      storeScope: relay.sessionTarget.storePath,
    },
  );
  const release = await claimRpcSourceForTest(source);
  registerRpcSource(identity.runId, source);
  return {
    source,
    async cleanup() {
      release();
      retireRpcSource(identity.runId, source);
      await source.input.settlement.promise;
    },
  };
}

describe("relay consult registration authority", () => {
  const createRegistrationFixture = async () => {
    const context = createGatewayRequestContext(makeContextParams());
    context.getRuntimeConfig = () => ({});
    const created = createTalkRealtimeRelaySession({
      context,
      connId: "registration-owner",
      cfg: {},
      provider: createIdleRelayProvider(),
      providerConfig: {},
      instructions: "brief",
      tools: [],
      controlSource: "transcript",
      sessionTarget: await prepareTalkSessionTarget({}, "agent:main:main"),
    });
    activeRelaySessions.set(created.relaySessionId, "registration-owner");
    const relay = relaySessions.get(created.relaySessionId)!;
    const target = {
      relaySessionId: relay.id,
      connId: relay.connId,
      sessionKey: relay.sessionTarget.canonicalKey,
      runId: "registration-run",
    };
    const chat = await createControllerSource(relay, {
      runId: target.runId,
      sessionId: "registration-session",
    });
    return { relay, target, chat };
  };

  it.for(["release", "failure"] as const)(
    "preserves a newer registration with identical IDs after old %s",
    async (phase, { signal }) => {
      const { relay, target, chat } = await createRegistrationFixture();
      const callId = adoptRelayProviderToolCallId(relay, "registration-call")!;
      const held = createDeferred();
      const resume = createDeferred();
      let rejectOld = false;
      const old = registerTalkRealtimeRelayAgentRun({
        ...target,
        callId,
        assertCurrent: () => {
          if (rejectOld) {
            throw new Error("old registration retired");
          }
        },
        registerVoice: async (assertCurrent, physicalSource, onRegistered) => {
          await voiceSessions.registerClientVoiceConsultRun({
            agentId: "main",
            sessionKey: target.sessionKey,
            voiceSessionId: relay.id,
            runId: target.runId,
            assertCurrent,
            physicalSource,
            onRegistered,
          });
          held.resolve();
          if (phase === "failure") {
            await resume.promise;
          }
        },
      });
      const settled = old.then(
        (release) => ({ release }),
        (error: unknown) => ({ error }),
      );
      try {
        await withinTest(held.promise, signal);
        if (phase === "release") {
          await old;
        }
        const current = await registerTalkRealtimeRelayAgentRun({ ...target, callId });
        rejectOld = phase === "failure";
        resume.resolve();
        const result = await settled;
        if ("release" in result) {
          result.release.release();
        } else {
          expect(result.error).toBeInstanceOf(Error);
        }
        expect(relay.activeAgentRuns.size).toBe(1);
        expect(relay.activeAgentToolCalls.size).toBe(1);
        expect(voiceSessions.resolveClientVoiceRunBinding(target.runId)).toBeDefined();
        expect(chat.source.input.abortSignal.aborted).toBe(false);
        cancelTalkRealtimeRelayProviderToolCall(relay, "registration-call");
        expect(chat.source.input.abortSignal.aborted).toBe(true);
        current.release();
      } finally {
        resume.resolve();
        await settled;
        await chat.cleanup();
      }
    },
  );

  it.for(["none", "live", "detached"] as const)(
    "settles published cleanup before a replaced registration returns (successor=%s)",
    async (successor, { signal }) => {
      const { relay, target, chat } = await createRegistrationFixture();
      const callId = adoptRelayProviderToolCallId(relay, "publication-call")!;
      const held = createDeferred();
      const resume = createDeferred();
      let activeChat = chat;
      let current: Awaited<ReturnType<typeof registerTalkRealtimeRelayAgentRun>> | undefined;
      const register = voiceSessions.registerClientVoiceConsultRun;
      const registering = vi
        .spyOn(voiceSessions, "registerClientVoiceConsultRun")
        .mockImplementationOnce(async (params) => {
          const release = await register(params);
          held.resolve();
          await resume.promise;
          return release;
        });
      const pending = registerTalkRealtimeRelayAgentRun({ ...target, callId });
      const settled = pending.catch((error: unknown) => error);
      try {
        await withinTest(held.promise, signal);
        await expect(
          registerTalkRealtimeRelayAgentRun({
            ...target,
            callId,
            registerVoice: async () => {
              throw new Error("replacement registration refused");
            },
          }),
        ).rejects.toThrow("replacement registration refused");
        expect(relay.activeAgentRuns.size).toBe(0);
        expect(relay.activeAgentToolCalls.size).toBe(0);
        if (successor !== "none") {
          await chat.cleanup();
          activeChat = await createControllerSource(relay, {
            runId: target.runId,
            sessionId: "successor-session",
          });
          current = await registerTalkRealtimeRelayAgentRun({ ...target, callId });
          expect(voiceSessions.resolveClientVoiceRunBinding(target.runId)).toBeDefined();
          if (successor === "detached") {
            clearRelayAgentToolCall(relay, callId);
            expect(relay.activeAgentRuns.size).toBe(0);
          }
        }
        const binding = voiceSessions.resolveClientVoiceRunBinding(target.runId);
        resume.resolve();
        expect(await settled).toMatchObject({
          message: "Realtime relay run registration changed while waiting",
        });
        if (successor === "none") {
          expect(voiceSessions.resolveClientVoiceRunBinding(target.runId)).toBeUndefined();
        } else {
          expect(voiceSessions.resolveClientVoiceRunBinding(target.runId)).toBe(binding);
          expect(activeChat.source.input.abortSignal.aborted).toBe(false);
          if (successor === "live") {
            expect(current?.isCurrent()).toBe(true);
            current?.release();
            expect(voiceSessions.resolveClientVoiceRunBinding(target.runId)).toBeUndefined();
          }
        }
      } finally {
        resume.resolve();
        await settled;
        current?.release();
        await activeChat.cleanup();
        registering.mockRestore();
      }
    },
  );

  it.each(["call-1", "call-2"])("retains a shared run when %s clears first", async (first) => {
    const { relay, target, chat } = await createRegistrationFixture();
    const second = first === "call-1" ? "call-2" : "call-1";
    try {
      for (const callId of ["call-1", "call-2"]) {
        adoptRelayProviderToolCallId(relay, callId);
        await registerTalkRealtimeRelayAgentRun({ ...target, callId });
      }
      clearRelayAgentToolCall(relay, first);
      expect(relay.activeAgentRuns.size).toBe(1);
      expect(relay.activeAgentToolCalls.has(second)).toBe(true);
      expect(voiceSessions.resolveClientVoiceRunBinding(target.runId)).toBeDefined();
      cancelTalkRealtimeRelayProviderToolCall(relay, second);
      expect(chat.source.input.abortSignal.aborted).toBe(true);
      expect(relay.activeAgentRuns.size).toBe(0);
    } finally {
      await chat.cleanup();
    }
  });

  it.each(["standalone", "call"])(
    "retains shared voice ownership when the %s registration releases first",
    async (first) => {
      const { relay, target, chat } = await createRegistrationFixture();
      const standalone = await registerTalkRealtimeRelayAgentRun(target);
      const call = await registerTalkRealtimeRelayAgentRun({ ...target, callId: "shared-call" });
      try {
        (first === "standalone" ? standalone : call).release();
        expect(relay.activeAgentRuns.size).toBe(1);
        expect(voiceSessions.resolveClientVoiceRunBinding(target.runId)).toBeDefined();
        (first === "standalone" ? call : standalone).release();
        expect(relay.activeAgentRuns.size).toBe(0);
        expect(voiceSessions.resolveClientVoiceRunBinding(target.runId)).toBeUndefined();
      } finally {
        standalone.release();
        call.release();
        await chat.cleanup();
      }
    },
  );

  it.for(["creation", "registration", "failure", "aborted", "cleanup"] as const)(
    "preserves controller source ownership across the %s wait",
    async (phase, { signal }) => {
      const { relay, target, chat } = await createRegistrationFixture();
      const callId = adoptRelayProviderToolCallId(relay, "controller-call")!;
      const held = createDeferred();
      const resume = createDeferred();
      const waitForReplacement = async () => {
        held.resolve();
        await resume.promise;
      };
      const create = voiceSessions.createOrResumeClientVoiceSession;
      const creating =
        phase === "creation"
          ? vi
              .spyOn(voiceSessions, "createOrResumeClientVoiceSession")
              .mockImplementationOnce(async (...args) => {
                const result = await create(...args);
                await waitForReplacement();
                return result;
              })
          : undefined;
      const register = voiceSessions.registerClientVoiceConsultRun;
      const registering =
        phase === "registration" || phase === "aborted" || phase === "cleanup"
          ? vi
              .spyOn(voiceSessions, "registerClientVoiceConsultRun")
              .mockImplementationOnce(async (...args) => {
                const release = await register(...args);
                await waitForReplacement();
                return release;
              })
          : undefined;
      const pending = registerTalkRealtimeRelayAgentRun({
        ...target,
        callId,
        ...(phase === "failure"
          ? {
              registerVoice: async () => {
                await waitForReplacement();
                throw new Error("registration refused");
              },
            }
          : {}),
      });
      const settled = pending.catch((error: unknown) => error);
      let replacement: typeof chat | undefined;
      const terminalWrite = createDeferred();
      let terminalCleanup: Promise<void> | undefined;
      try {
        await withinTest(held.promise, signal);
        if (phase === "aborted" || phase === "cleanup") {
          const entry = chat.source;
          if (phase === "aborted") {
            requestRpcSourceCancellation(chat.source);
          } else {
            entry.adapter.projectSessionTerminalPending = true;
            trackSessionControllerSourceWork(entry.input, terminalWrite.promise);
            terminalCleanup = chat.cleanup();
          }
          expect(getRpcSource(target.runId)).toBe(entry);
        } else {
          await chat.cleanup();
          replacement = await createControllerSource(relay, {
            runId: target.runId,
            sessionId: "replacement-chat",
          });
        }
        resume.resolve();
        const result = await settled;
        cancelTalkRealtimeRelayProviderToolCall(relay, "controller-call");
        if (replacement) {
          expect(replacement.source.input.abortSignal.aborted).toBe(false);
        }
        expect(result).toMatchObject({
          message:
            phase === "failure"
              ? "registration refused"
              : "Realtime relay run registration changed while waiting",
        });
        expect(relay.activeAgentRuns.size).toBe(0);
        expect(relay.activeAgentToolCalls.size).toBe(0);
        expect(voiceSessions.resolveClientVoiceRunBinding(target.runId)).toBeUndefined();
        expect(clientVoiceSessionTesting.readRecord("main", relay.id)?.consultRunIds).toEqual(
          phase === "registration" || phase === "aborted" || phase === "cleanup"
            ? [target.runId]
            : [],
        );
        if (replacement) {
          adoptRelayProviderToolCallId(relay, "replacement-call");
          await registerTalkRealtimeRelayAgentRun({ ...target, callId: "replacement-call" });
          cancelTalkRealtimeRelayProviderToolCall(relay, "replacement-call");
          expect(replacement.source.input.abortSignal.aborted).toBe(true);
        }
      } finally {
        resume.resolve();
        await settled;
        await replacement?.cleanup();
        chat.source.adapter.projectSessionTerminalPending = false;
        terminalWrite.resolve();
        await terminalCleanup;
        await chat.cleanup();
        registering?.mockRestore();
        creating?.mockRestore();
      }
    },
  );

  it.for(["provider", "close", "close-without-controller"] as const)(
    "keeps a later controller alive after settled registration (%s)",
    async (operation) => {
      const { relay, target, chat } = await createRegistrationFixture();
      if (operation === "close-without-controller") {
        await chat.cleanup();
      }
      const callId =
        operation === "close"
          ? undefined
          : adoptRelayProviderToolCallId(relay, "settled-controller-call");
      const registration = await registerTalkRealtimeRelayAgentRun({ ...target, callId });
      await chat.cleanup();
      const replacement = await createControllerSource(relay, {
        runId: target.runId,
        sessionId: "replacement-chat",
      });
      try {
        if (operation === "provider") {
          cancelTalkRealtimeRelayProviderToolCall(relay, "settled-controller-call");
        } else {
          await closeRelaySession(relay, "completed", { disposition: "abort" });
        }
        expect(replacement.source.input.abortSignal.aborted).toBe(false);
        expect(relay.activeAgentRuns.size).toBe(0);
        expect(relay.activeAgentToolCalls.size).toBe(0);
        if (operation === "provider") {
          adoptRelayProviderToolCallId(relay, "replacement-call");
          const successor = await registerTalkRealtimeRelayAgentRun({
            ...target,
            callId: "replacement-call",
          });
          registration.release();
          expect(successor.isCurrent()).toBe(true);
          cancelTalkRealtimeRelayProviderToolCall(relay, "replacement-call");
          expect(replacement.source.input.abortSignal.aborted).toBe(true);
          successor.release();
        }
      } finally {
        registration.release();
        await replacement.cleanup();
        await chat.cleanup();
      }
    },
  );

  it("retains only completion custody after clean source settlement", async () => {
    const { relay, target, chat } = await createRegistrationFixture();
    const callId = adoptRelayProviderToolCallId(relay, "completed-call")!;
    const registration = await registerTalkRealtimeRelayAgentRun({
      ...target,
      callId,
    });
    let replacement: typeof chat | undefined;
    try {
      expect(registration.isCurrent()).toBe(true);
      await chat.cleanup();
      expect(getRpcSource(target.runId)).toBeUndefined();
      expect(registration.isCurrent()).toBe(false);
      expect(registration.isCurrent("completion")).toBe(true);

      replacement = await createControllerSource(relay, {
        runId: target.runId,
        sessionId: "replacement-chat",
      });
      expect(registration.isCurrent()).toBe(false);
      expect(registration.isCurrent("completion")).toBe(false);
      cancelTalkRealtimeRelayProviderToolCall(relay, "completed-call");
      expect(replacement.source.input.abortSignal.aborted).toBe(false);
    } finally {
      registration.release();
      await replacement?.cleanup();
      await chat.cleanup();
    }
  });

  it("retries a known refused voice write in the database admitted by its creator", async () => {
    const originalEnv = { ...process.env };
    const env = captureEnv(["OPENCLAW_STATE_DIR"]);
    const successor = path.join(process.env.OPENCLAW_STATE_DIR!, "successor-known-failure");
    const config = { agents: { entries: { main: {}, fresh: {} } } };
    const context = createGatewayRequestContext(makeContextParams());
    context.getRuntimeConfig = () => config;
    const created = createTalkRealtimeRelaySession({
      context,
      connId: "conn-known-failure",
      cfg: config,
      provider: createIdleRelayProvider(),
      providerConfig: {},
      instructions: "brief",
      tools: [],
      controlSource: "transcript",
      sessionTarget: await prepareTalkSessionTarget(config, "agent:fresh:main"),
    });
    activeRelaySessions.set(created.relaySessionId, "conn-known-failure");
    const relay = relaySessions.get(created.relaySessionId)!;
    const agentId = relay.sessionTarget.agentId;
    const originalPath = resolveOpenClawAgentSqlitePath({ agentId });
    expect(existsSync(originalPath)).toBe(false);
    let writer: ClientVoiceSessionWriter | undefined;
    const create = voiceSessions.createOrResumeClientVoiceSession;
    const creation = vi
      .spyOn(voiceSessions, "createOrResumeClientVoiceSession")
      .mockImplementation((...args) => {
        writer = args[1];
        return create(...args);
      });
    let refused = false;
    const admit = operationAdmission.createSqliteWorkerOperationAdmission;
    const admission = vi
      .spyOn(operationAdmission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((authorize, attachment) =>
        admit((request, grant) => {
          if (!refused && request.stage === "commit" && writer?.identity.key.startsWith("file:")) {
            refused = true;
            throw new Error("Synthetic voice commit refusal");
          }
          authorize(request, grant);
        }, attachment),
      );
    try {
      expect(await ensureRelayVoiceSession(relay)).toBe(false);
      expect(refused).toBe(true);
      expect(existsSync(originalPath)).toBe(true);
      expect(readVoiceSessionRecord(agentId, relay.id)).toBeUndefined();
      setTestEnvValue("OPENCLAW_STATE_DIR", successor);
      expect(await ensureRelayVoiceSession(relay)).toBe(true);
      expect(readVoiceSessionRecord(agentId, relay.id, { env: originalEnv })?.status).toBe("open");
      expect(existsSync(resolveOpenClawAgentSqlitePath({ agentId }))).toBe(false);
    } finally {
      admission.mockRestore();
      creation.mockRestore();
      env.restore();
      await closeRelaySession(relay, "completed");
      await cleanupSessionStateForTest({ stateDir: successor, rootPath: successor });
    }
  });

  it("refuses a replaced physical source on the already-created fast path", async () => {
    const context = createGatewayRequestContext(makeContextParams());
    context.getRuntimeConfig = () => ({});
    const created = createTalkRealtimeRelaySession({
      context,
      connId: "conn-replaced-source",
      cfg: {},
      provider: createIdleRelayProvider(),
      providerConfig: {},
      instructions: "brief",
      tools: [],
      controlSource: "transcript",
      sessionTarget: await prepareTalkSessionTarget({}, "agent:main:main"),
    });
    activeRelaySessions.set(created.relaySessionId, "conn-replaced-source");
    const relay = relaySessions.get(created.relaySessionId)!;
    expect(await ensureRelayVoiceSession(relay)).toBe(true);
    const sourcePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const displaced = `${sourcePath}.original`;
    await closeOpenClawAgentDatabasesAsync(process.env.OPENCLAW_STATE_DIR!);
    renameSync(sourcePath, displaced);
    copyFileSync(displaced, sourcePath);
    const replacement = readFileSync(sourcePath);
    try {
      expect(await ensureRelayVoiceSession(relay)).toBe(false);
      expect(readFileSync(sourcePath)).toEqual(replacement);
    } finally {
      await closeOpenClawAgentDatabasesAsync(process.env.OPENCLAW_STATE_DIR!);
      unlinkSync(sourcePath);
      renameSync(displaced, sourcePath);
      await closeRelaySession(relay, "completed");
    }
  });

  it.each([false, true])(
    "keeps accepted registration and close on the creating source after a state switch (coalesced=%s)",
    async (coalesced) => {
      await withOpenClawTestState(
        { label: "relay-source-switch", scenario: "minimal" },
        async () => {
          await ensureClientVoiceAgentSessionEntry({
            agentId: "main",
            sessionKey: "agent:main:main",
          });
          const originalEnv = { ...process.env };
          const env = captureEnv(["OPENCLAW_STATE_DIR"]);
          const successor = path.join(process.env.OPENCLAW_STATE_DIR!, "successor");
          const context = createGatewayRequestContext(makeContextParams());
          context.getRuntimeConfig = () => ({});
          const created = createTalkRealtimeRelaySession({
            context,
            connId: "conn-source",
            cfg: {},
            provider: createIdleRelayProvider(),
            providerConfig: {},
            instructions: "brief",
            tools: [],
            controlSource: "transcript",
            sessionTarget: await prepareTalkSessionTarget({}, "agent:main:main"),
          });
          activeRelaySessions.set(created.relaySessionId, "conn-source");
          const relay = relaySessions.get(created.relaySessionId)!;
          const binding = {
            agentId: relay.sessionTarget.agentId,
            sessionKey: relay.sessionTarget.sessionKey,
            voiceSessionId: relay.id,
          };
          setTestEnvValue("OPENCLAW_STATE_DIR", successor);
          await voiceSessions.createOrResumeClientVoiceSession({ ...binding, origin: "relay" });
          env.restore();
          const persistence = prepareClientVoiceSessionClose();
          const acceptedClose = captureClientVoiceSessionSettlement();
          const entered = createDeferred();
          const resume = createDeferred();
          const blocker = runOpenClawAgentWriteAdmission({ agentId: binding.agentId }, async () => {
            entered.resolve();
            await resume.promise;
          });
          await entered.promise;
          const creating = coalesced ? ensureRelayVoiceSession(relay) : undefined;
          let release: (() => void) | undefined;
          const registered = registerTalkRealtimeRelayAgentRun({
            relaySessionId: relay.id,
            connId: relay.connId,
            sessionKey: binding.sessionKey,
            runId: "source-run",
          }).then(
            (registeredRelease) => {
              release = registeredRelease.release;
              return undefined;
            },
            (error: unknown) => error,
          );
          try {
            setTestEnvValue("OPENCLAW_STATE_DIR", successor);
            persistence.beginClose();
            resume.resolve();
            expect(await registered).toBeUndefined();
            await creating;
            expect(
              readVoiceSessionRecord(binding.agentId, relay.id, { env: originalEnv }),
            ).toMatchObject({
              consultRunIds: ["source-run"],
              status: "open",
            });
            expect(
              acceptedClose.run(() =>
                enqueueRelayVoiceTranscript(relay, "user", "accepted speech"),
              ),
            ).toBe(true);
            await relay.voiceTranscriptQueue.flush();
            release?.();
            await acceptedClose.run(() => closeRelaySession(relay, "completed"));
            expect(
              readVoiceSessionRecord(binding.agentId, relay.id, { env: originalEnv }),
            ).toMatchObject({
              consultRunIds: ["source-run"],
              hasUserTranscript: true,
              status: "closed",
            });
            expect(readVoiceSessionRecord(binding.agentId, relay.id)).toMatchObject({
              consultRunIds: [],
              status: "open",
            });
          } finally {
            resume.resolve();
            await blocker;
            await registered;
            release?.();
            env.restore();
            await acceptedClose.run(() => closeRelaySession(relay, "completed"));
            acceptedClose.release();
            await persistence.drain();
            await cleanupSessionStateForTest({ stateDir: successor, rootPath: successor });
          }
        },
      );
    },
  );

  it.for(["current", "caller", "relay", "controller"] as const)(
    "fences delegated voice registration while queued (%s)",
    async (revoked, { signal }) => {
      const context = createGatewayRequestContext(makeContextParams());
      context.getRuntimeConfig = () => ({});
      const session = createTalkRealtimeRelaySession({
        context,
        connId: "conn-1",
        cfg: {},
        provider: createIdleRelayProvider(),
        providerConfig: {},
        instructions: "brief",
        tools: [],
        controlSource: "transcript",
        sessionTarget: await prepareTalkSessionTarget({}, "main"),
      });
      const voiceSessionId = session.relaySessionId;
      activeRelaySessions.set(voiceSessionId, "conn-1");
      const relay = relaySessions.get(voiceSessionId);
      if (!relay) {
        throw new Error("Expected the created relay owner");
      }
      const sessionKey = relay.sessionTarget.sessionKey;
      const chat =
        revoked === "controller"
          ? await createControllerSource(relay, {
              runId: "run-1",
              sessionId: "queued-chat",
            })
          : undefined;
      let replacement: typeof chat;
      const queued = createDeferred();
      const entered = createDeferred();
      const releaseQueue = createDeferred();
      let callerCurrent = true;
      let blocker: Promise<void> | undefined;
      let release: (() => void) | undefined;
      const registerVoice = vi.fn(
        async (
          assertCurrent: () => void,
          physicalSource: ClientVoiceSessionSource,
          onRegistered: (release: () => void) => void,
        ) => {
          blocker = runOpenClawAgentWriteAdmission({ agentId: "main" }, async () => {
            entered.resolve();
            await releaseQueue.promise;
          });
          await entered.promise;
          const pending = voiceSessions.registerClientVoiceConsultRun({
            agentId: "main",
            sessionKey,
            voiceSessionId,
            runId: "run-1",
            assertCurrent,
            physicalSource,
            onRegistered,
          });
          queued.resolve();
          await pending;
        },
      );
      const pending = registerTalkRealtimeRelayAgentRun({
        relaySessionId: voiceSessionId,
        connId: "conn-1",
        sessionKey: relay.sessionTarget.canonicalKey,
        runId: "run-1",
        callId: "call-1",
        assertCurrent: () => {
          if (!callerCurrent) {
            throw new Error("Accepted caller was cancelled");
          }
        },
        registerVoice,
      });
      const settled = pending.then(
        (registered) => {
          release = registered.release;
          return undefined;
        },
        (error: unknown) => error,
      );
      try {
        await withinTest(
          Promise.race([
            queued.promise,
            settled.then(() => {
              throw new Error("Relay completed before registration queued");
            }),
          ]),
          signal,
        );
        if (revoked === "caller") {
          callerCurrent = false;
        } else if (revoked === "relay") {
          relay.toolCalls.markCancelled(["call-1"], "cancelled-turn");
        } else if (revoked === "controller") {
          await chat?.cleanup();
          replacement = await createControllerSource(relay, {
            runId: "run-1",
            sessionId: "replacement-chat",
          });
        }
        releaseQueue.resolve();
        const error = await settled;
        await blocker;
        expect(registerVoice).toHaveBeenCalledOnce();
        expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.consultRunIds).toEqual(
          revoked === "current" ? ["run-1"] : [],
        );
        if (revoked === "current") {
          expect(error).toBeUndefined();
          expect(voiceSessions.resolveClientVoiceRunBinding("run-1")).toBeDefined();
          expect(relay.activeAgentRuns.size).toBe(1);
          release?.();
        } else {
          expect(error).toMatchObject({
            message:
              revoked === "caller"
                ? "Accepted caller was cancelled"
                : revoked === "controller"
                  ? "Realtime relay run registration changed while waiting"
                  : "Realtime provider cancelled the tool call before run registration",
          });
          expect(voiceSessions.resolveClientVoiceRunBinding("run-1")).toBeUndefined();
        }
        expect(relay.activeAgentRuns.size).toBe(0);
        expect(relay.activeAgentToolCalls.size).toBe(0);
        if (replacement) {
          expect(replacement.source.input.abortSignal.aborted).toBe(false);
        }
      } finally {
        releaseQueue.resolve();
        await settled;
        await blocker;
        release?.();
        await replacement?.cleanup();
        await chat?.cleanup();
      }
    },
  );
});
