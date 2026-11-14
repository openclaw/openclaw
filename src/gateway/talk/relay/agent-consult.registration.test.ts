import { AsyncLocalStorage } from "node:async_hooks";
import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../../test/helpers/promise.js";
import * as workspace from "../../../agents/workspace.js";
import * as operationAdmission from "../../../infra/sqlite-worker-operation-admission.js";
import { trackSessionControllerSourceWork } from "../../../sessions/session-controller.mailbox.js";
import {
  getRpcSource,
  registerRpcSource,
  requestRpcSourceCancellation,
  retireRpcSource,
} from "../../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../../sessions/session-lifecycle-admission.test-support.js";
import { closeOpenClawAgentDatabasesAsync } from "../../../state/openclaw-agent-db-lifecycle.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "../../../state/openclaw-agent-write-admission.js";
import {
  captureClientVoiceSessionSettlement,
  prepareClientVoiceSessionClose,
} from "../../../talk/client-voice-session-lifecycle.js";
import { readVoiceSessionRecord } from "../../../talk/client-voice-session-store.js";
import {
  ensureClientVoiceAgentSessionEntry,
  type ClientVoiceSessionWriter,
} from "../../../talk/client-voice-session-write.js";
import * as voiceSessions from "../../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import type { RealtimeVoiceBridgeCreateRequest } from "../../../talk/provider-types.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import { claimRpcSourceForTest, createRpcSourceForTest } from "../../test-helpers.rpc-source.js";
import type { GatewayControlOwner } from "../client-agent-consult.types.js";
import * as toolAuthority from "../client-tool-authority.js";
import { useRelayFixtures } from "./fixture.test-support.js";
import { createIdleRelayProvider, makeRelayTransport } from "./index.test-support.js";
import {
  cancelTalkRealtimeRelayProviderToolCall,
  closeRelaySession,
  registerTalkRealtimeRelayAgentRun as registerRun,
} from "./operations.js";
import { clearRelayAgentToolCall } from "./provider-results.js";
import { adoptRelayProviderToolCallId, type RelaySession } from "./state.js";
import { enqueueRelayVoiceTranscript, ensureRelayVoiceSession } from "./voice.js";

const resolveBinding = voiceSessions.resolveClientVoiceRunBinding;
const createRelay = useRelayFixtures();

function afterResult<A extends unknown[], R>(
  run: (...args: A) => Promise<R>,
  wait: () => Promise<void>,
) {
  return async (...args: A) => {
    const result = await run(...args);
    await wait();
    return result;
  };
}

function expectRegistrations(relay: RelaySession, runs: number, calls: number) {
  expect([relay.activeAgentRuns.size, relay.activeAgentToolCalls.size]).toEqual([runs, calls]);
}

async function createControllerSource(relay: RelaySession, runId: string, sessionId: string) {
  const source = createRpcSourceForTest(
    { requester: { connectionId: relay.connId }, kind: "chat-send" },
    {
      runId,
      sessionId,
      sessionKey: relay.sessionTarget.canonicalKey,
      agentId: relay.sessionTarget.agentId,
      storeScope: relay.sessionTarget.storePath,
    },
  );
  const release = await claimRpcSourceForTest(source);
  registerRpcSource(runId, source);
  return {
    source,
    async cleanup() {
      release();
      retireRpcSource(runId, source);
      await source.input.settlement.promise;
    },
  };
}

const createRegistrationFixture = async () => {
  const { relay } = await createRelay({ connId: "registration-owner" });
  const target = {
    relaySessionId: relay.id,
    connId: relay.connId,
    sessionKey: relay.sessionTarget.canonicalKey,
    runId: "registration-run",
  };
  const chat = await createControllerSource(relay, target.runId, "registration-session");
  return { relay, target, chat };
};

it.for([
  { phase: "workspace", owned: true },
  { phase: "tool context", owned: true },
  { phase: "tool context", owned: false },
] as const)(
  "settles native relay startup failure ($phase, owned=$owned)",
  async ({ phase, owned }, { signal }) => {
    let providerScope: ReturnType<typeof AsyncLocalStorage.snapshot> | undefined;
    const createBridge = vi.fn((_request: RealtimeVoiceBridgeCreateRequest) => {
      providerScope = AsyncLocalStorage.snapshot();
      return makeRelayTransport();
    });
    const { relay } = await createRelay({
      controlSource: "delegation",
      provider: createIdleRelayProvider(createBridge),
    });
    const runner: GatewayControlOwner["runAgentConsult"] | undefined =
      createBridge.mock.calls[0]?.[0].runAgentConsult;
    if (!runner?.adoptCompletionClaims || !runner.claimFailureAppend || !providerScope) {
      throw new Error("Expected the provider's lifecycle-bound relay consult");
    }
    if (owned) {
      runner.adoptCompletionClaims();
    }
    const rpcBefore = [...rpcSourceTesting.entries()].map(([runId]) => runId);
    let admittedRunIds: string[] = [];
    const failure = new Error(`Synthetic relay ${phase} failure`);
    const failPreparation = () => {
      admittedRunIds = [...relay.activeAgentRuns.keys()];
      throw failure;
    };
    // Fail at the actual preparation boundary; registration and its resource owners stay real.
    const preparation =
      phase === "workspace"
        ? vi
            .spyOn(workspace, "ensureAgentWorkspace")
            .mockImplementationOnce(async () => failPreparation())
        : vi
            .spyOn(toolAuthority, "prepareTalkClientToolContext")
            .mockImplementationOnce(failPreparation);
    onTestFinished(() => {
      preparation.mockRestore();
      runner.claimFailureAppend?.();
    });

    await expect(
      withinTest(
        providerScope(() => runner({ prompt: "Prepare the delegated task" })),
        signal,
      ),
    ).rejects.toBe(failure);
    expect(preparation).toHaveBeenCalledOnce();
    if (phase === "tool context") {
      expect(admittedRunIds).toHaveLength(1);
    }
    const claims = owned ? [runner.claimFailureAppend(), runner.claimFailureAppend()] : [];
    expectRegistrations(relay, 0, 0);
    expect([...rpcSourceTesting.entries()].map(([runId]) => runId)).toEqual(rpcBefore);
    for (const runId of admittedRunIds) {
      expect(resolveBinding(runId)).toBeUndefined();
    }
    expect(claims).toEqual(owned ? [true, false] : []);
  },
);

it.for(["release", "failure"] as const)(
  "preserves a newer registration with identical IDs after old %s",
  async (phase, { signal }) => {
    const { relay, target, chat } = await createRegistrationFixture();
    const callId = adoptRelayProviderToolCallId(relay, "registration-call")!;
    const held = createDeferred();
    const resume = createDeferred();
    let rejectOld = false;
    const old = registerRun({
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
      const current = await registerRun({ ...target, callId });
      rejectOld = phase === "failure";
      resume.resolve();
      const result = await settled;
      if ("release" in result) {
        result.release.release();
      } else {
        expect(result.error).toBeInstanceOf(Error);
      }
      expectRegistrations(relay, 1, 1);
      expect(resolveBinding(target.runId)).toBeDefined();
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
    let current: Awaited<ReturnType<typeof registerRun>> | undefined;
    const register = voiceSessions.registerClientVoiceConsultRun;
    const registering = vi
      .spyOn(voiceSessions, "registerClientVoiceConsultRun")
      .mockImplementationOnce(
        afterResult(register, async () => {
          held.resolve();
          await resume.promise;
        }),
      );
    const pending = registerRun({ ...target, callId });
    const settled = pending.catch((error: unknown) => error);
    try {
      await withinTest(held.promise, signal);
      await expect(
        registerRun({
          ...target,
          callId,
          registerVoice: async () => {
            throw new Error("replacement registration refused");
          },
        }),
      ).rejects.toThrow("replacement registration refused");
      expectRegistrations(relay, 0, 0);
      if (successor !== "none") {
        await chat.cleanup();
        activeChat = await createControllerSource(relay, target.runId, "successor-session");
        current = await registerRun({ ...target, callId });
        expect(resolveBinding(target.runId)).toBeDefined();
        if (successor === "detached") {
          clearRelayAgentToolCall(relay, callId);
          expect(relay.activeAgentRuns.size).toBe(0);
        }
      }
      const binding = resolveBinding(target.runId);
      resume.resolve();
      expect(await settled).toMatchObject({
        message: "Realtime relay run registration changed while waiting",
      });
      if (successor === "none") {
        expect(resolveBinding(target.runId)).toBeUndefined();
      } else {
        expect(resolveBinding(target.runId)).toBe(binding);
        expect(activeChat.source.input.abortSignal.aborted).toBe(false);
        if (successor === "live") {
          expect(current?.isCurrent()).toBe(true);
          current?.release();
          expect(resolveBinding(target.runId)).toBeUndefined();
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

it.each(["calls", "standalone", "call"] as const)(
  "retains shared voice ownership when %s releases first",
  async (first) => {
    const { relay, target, chat } = await createRegistrationFixture();
    const firstCall =
      first === "calls" ? adoptRelayProviderToolCallId(relay, "call-1")! : undefined;
    const firstRegistration = await registerRun({ ...target, callId: firstCall });
    const secondCall =
      first === "calls" ? adoptRelayProviderToolCallId(relay, "call-2")! : "shared-call";
    const secondRegistration = await registerRun({ ...target, callId: secondCall });
    try {
      if (first === "calls") {
        clearRelayAgentToolCall(relay, firstCall!);
      } else {
        (first === "standalone" ? firstRegistration : secondRegistration).release();
      }
      expect(relay.activeAgentRuns.size).toBe(1);
      expect(resolveBinding(target.runId)).toBeDefined();
      if (first === "calls") {
        expect(relay.activeAgentToolCalls.has(secondCall)).toBe(true);
        cancelTalkRealtimeRelayProviderToolCall(relay, secondCall);
        expect(chat.source.input.abortSignal.aborted).toBe(true);
      } else {
        (first === "standalone" ? secondRegistration : firstRegistration).release();
        expect(resolveBinding(target.runId)).toBeUndefined();
      }
      expect(relay.activeAgentRuns.size).toBe(0);
    } finally {
      firstRegistration.release();
      secondRegistration.release();
      await chat.cleanup();
    }
  },
);

it.for(["creation", "registration", "failure", "aborted", "cleanup"] as const)(
  "preserves controller source ownership across the %s wait",
  async (phase, { signal }) => {
    const { relay, target, chat } = await createRegistrationFixture();
    const callId = adoptRelayProviderToolCallId(relay, "controller-call")!;
    const published = ["registration", "aborted", "cleanup"].includes(phase);
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
            .mockImplementationOnce(afterResult(create, waitForReplacement))
        : undefined;
    const register = voiceSessions.registerClientVoiceConsultRun;
    const registering = published
      ? vi
          .spyOn(voiceSessions, "registerClientVoiceConsultRun")
          .mockImplementationOnce(afterResult(register, waitForReplacement))
      : undefined;
    const pending = registerRun({
      ...target,
      callId,
      registerVoice:
        phase === "failure"
          ? async () => {
              await waitForReplacement();
              throw new Error("registration refused");
            }
          : undefined,
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
        replacement = await createControllerSource(relay, target.runId, "replacement-chat");
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
      expectRegistrations(relay, 0, 0);
      expect(resolveBinding(target.runId)).toBeUndefined();
      expect(clientVoiceSessionTesting.readRecord("main", relay.id)?.consultRunIds).toEqual(
        published ? [target.runId] : [],
      );
      if (replacement) {
        adoptRelayProviderToolCallId(relay, "replacement-call");
        await registerRun({ ...target, callId: "replacement-call" });
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
  "retires completion custody without cancelling a later controller (%s)",
  async (operation) => {
    const { relay, target, chat } = await createRegistrationFixture();
    if (operation === "close-without-controller") {
      await chat.cleanup();
    }
    const callId =
      operation === "close"
        ? undefined
        : adoptRelayProviderToolCallId(relay, "settled-controller-call");
    const registration = await registerRun({ ...target, callId });
    if (operation === "provider") {
      expect(registration.isCurrent()).toBe(true);
    }
    await chat.cleanup();
    if (operation === "provider") {
      expect(getRpcSource(target.runId)).toBeUndefined();
      expect(registration.isCurrent()).toBe(false);
      expect(registration.isCurrent("completion")).toBe(true);
    }
    const replacement = await createControllerSource(relay, target.runId, "replacement-chat");
    try {
      if (operation === "provider") {
        expect(registration.isCurrent()).toBe(false);
        expect(registration.isCurrent("completion")).toBe(false);
        cancelTalkRealtimeRelayProviderToolCall(relay, "settled-controller-call");
      } else {
        await closeRelaySession(relay, "completed", { disposition: "abort" });
      }
      expect(replacement.source.input.abortSignal.aborted).toBe(false);
      expectRegistrations(relay, 0, 0);
      if (operation === "provider") {
        adoptRelayProviderToolCallId(relay, "replacement-call");
        const successor = await registerRun({
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

it("retries a known refused voice write in the database admitted by its creator", async () => {
  const originalEnv = { ...process.env };
  const env = captureEnv(["OPENCLAW_STATE_DIR"]);
  const successor = path.join(process.env.OPENCLAW_STATE_DIR!, "successor-known-failure");
  const config = { agents: { entries: { main: {}, fresh: {} } } };
  const { relay } = await createRelay({
    connId: "conn-known-failure",
    cfg: config,
    key: "agent:fresh:main",
  });
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
  const { relay } = await createRelay({ connId: "conn-replaced-source" });
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
  (coalesced) =>
    withOpenClawTestState({ label: "relay-source-switch", scenario: "minimal" }, async () => {
      await ensureClientVoiceAgentSessionEntry({
        agentId: "main",
        sessionKey: "agent:main:main",
      });
      const originalEnv = { ...process.env };
      const env = captureEnv(["OPENCLAW_STATE_DIR"]);
      const successor = path.join(process.env.OPENCLAW_STATE_DIR!, "successor");
      const { relay } = await createRelay({ connId: "conn-source" });
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
      const registered = registerRun({
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
          acceptedClose.run(() => enqueueRelayVoiceTranscript(relay, "user", "accepted speech")),
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
    }),
);

it.for(["current", "caller", "relay", "controller"] as const)(
  "fences delegated voice registration while queued (%s)",
  async (revoked, { signal }) => {
    const { relay } = await createRelay({ key: "main" });
    const voiceSessionId = relay.id;
    const sessionKey = relay.sessionTarget.sessionKey;
    const chat =
      revoked === "controller"
        ? await createControllerSource(relay, "run-1", "queued-chat")
        : undefined;
    let replacement: typeof chat;
    const queued = createDeferred();
    const entered = createDeferred();
    const releaseQueue = createDeferred();
    let callerCurrent = true;
    let blocker: Promise<void> | undefined;
    let release: (() => void) | undefined;
    const registerVoice = vi.fn<NonNullable<Parameters<typeof registerRun>[0]["registerVoice"]>>(
      async (assertCurrent, physicalSource, onRegistered) => {
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
    const pending = registerRun({
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
        awaitGateBeforeSettlement(
          queued.promise,
          settled,
          "Relay completed before registration queued",
        ),
        signal,
      );
      if (revoked === "caller") {
        callerCurrent = false;
      } else if (revoked === "relay") {
        relay.toolCalls.markCancelled(["call-1"], "cancelled-turn");
      } else if (revoked === "controller") {
        await chat?.cleanup();
        replacement = await createControllerSource(relay, "run-1", "replacement-chat");
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
        expect(resolveBinding("run-1")).toBeDefined();
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
        expect(resolveBinding("run-1")).toBeUndefined();
      }
      expectRegistrations(relay, 0, 0);
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
