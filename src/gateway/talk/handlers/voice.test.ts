import fs from "node:fs";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import {
  readSessionTranscriptMessageEvents,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { assertNoRetainedSessionSharingReads } from "../../../config/sessions/session-accessor.sqlite-diagnostics.test-support.js";
import type { OpenClawConfig } from "../../../config/types.js";
import { releaseAgentRunDelegatedAuthority } from "../../../infra/agent-run-registry.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { prepareClientVoiceSessionClose } from "../../../talk/client-voice-session-lifecycle.js";
import * as clientVoiceSession from "../../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import type { RealtimeVoiceBridgeCreateRequest } from "../../../talk/provider-types.js";
import { makeBridge, makeVoiceProvider } from "../../../talk/session-runtime.test-support.js";
import { withEnv } from "../../../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../../agent-runtime-approval-authority.js";
import { createDirectChatContext } from "../../server-chat.agent-events.test-helpers.js";
import type { GatewayRequestContext } from "../../server-methods/types.js";
import * as sessionAuthorization from "../../session-sharing-authorization-async.js";
import {
  closeRelaySession,
  ensureTalkRealtimeRelayVoiceSession,
  sendTalkRealtimeRelayAudio,
  stopTalkRealtimeRelaySession,
} from "../relay/operations.js";
import { createTalkRealtimeRelaySession } from "../relay/session-create.js";
import { drainingRelaySessions, relaySessions } from "../relay/state.js";
import { cleanupTalkConnection } from "../session-registry.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import type { PreparedTalkSessionTarget } from "../session-target.types.js";
import {
  markTalkVoiceSessionReady,
  prepareTalkVoiceReplacement,
  registerTalkVoiceSession,
  unregisterTalkVoiceSession,
} from "../voice-selection.js";
import {
  expectFailure,
  expectSuccess,
  voiceClient,
  voiceRpc,
  voiceRuntimes,
} from "./voice-rpc.test-support.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "talk-voice", scenario: "minimal" });
});
afterEach(() => state.cleanup());

describe("Talk voice RPC ownership", () => {
  let context: GatewayRequestContext;
  let sessionTarget: PreparedTalkSessionTarget;
  let browser: ReturnType<typeof voiceClient>;
  let originalId: string;
  let dispatchCurrent: boolean;
  let changeRequested: ReturnType<
    typeof createDeferred<Parameters<GatewayRequestContext["broadcastToConnIds"]>>
  >;
  const connections = new Set<string>();
  const runtimes = voiceRuntimes();
  const pending: Promise<void>[] = [];
  const broadcast = vi.fn<GatewayRequestContext["broadcastToConnIds"]>();

  function client(connId: string) {
    connections.add(connId);
    return voiceClient(connId);
  }

  async function runtimeClient(bindVoice = true) {
    const runtime = runtimes.create(sessionTarget.agentId, sessionTarget.canonicalKey);
    connections.add(runtime.connId);
    if (bindVoice) {
      await clientVoiceSession.registerClientVoiceConsultRun({
        agentId: sessionTarget.agentId,
        sessionKey: sessionTarget.sessionKey,
        voiceSessionId: originalId,
        runId: runtime.runId,
      });
    }
    return runtime;
  }

  const { start, invoke } = voiceRpc(pending, () => ({
    client: browser,
    context,
    sessionMutationCommitGuard: () => {
      if (!dispatchCurrent) {
        throw new Error("Gateway dispatch retired");
      }
    },
  }));

  async function beginChange(requester = browser) {
    const changing = start("talk.voice.set", { voice: "ember" }, requester);
    const frame = await awaitGateBeforeSettlement(
      changeRequested.promise,
      changing.completed,
      "Voice change settled before requesting a replacement",
    );
    const payload = asOptionalRecord(frame[1]);
    if (typeof payload?.changeId !== "string") {
      throw new Error("Expected a requested voice change");
    }
    expect(payload).toMatchObject({
      phase: "requested",
      voiceSessionId: originalId,
      sessionKey: sessionTarget.sessionKey,
      voice: "ember",
    });
    expect(frame[2]).toEqual(new Set([browser.connId]));
    return { ...changing, changeId: payload.changeId };
  }

  function prepareReplacement(changeId: string) {
    const replacement = prepareTalkVoiceReplacement({
      voiceChangeId: changeId,
      connId: browser.connId,
      sessionKey: sessionTarget.sessionKey,
    });
    if (!replacement) {
      throw new Error("Expected an admitted voice replacement");
    }
    return replacement;
  }

  async function registerSession(
    launch: { provider: string; model?: string; voice: string },
    voiceChangeId?: string,
  ) {
    const voiceSessionId = await clientVoiceSession.createOrResumeClientVoiceSession({
      agentId: sessionTarget.agentId,
      sessionKey: sessionTarget.sessionKey,
      provider: launch.provider,
      origin: "client",
    });
    registerTalkVoiceSession({
      voiceSessionId,
      connId: browser.connId,
      sessionTarget,
      selection: {
        ...launch,
        voices: ["cove", "ember"],
        canChange: true,
      },
      launch: { provider: launch.provider, model: launch.model },
      voiceChangeId,
      providerReady: !voiceChangeId,
    });
    return voiceSessionId;
  }

  async function replace(changeId: string, retireOriginal = true) {
    const { launch } = prepareReplacement(changeId);
    if (retireOriginal) {
      unregisterTalkVoiceSession(originalId, browser.connId, sessionTarget.agentId);
    }
    return registerSession(launch, changeId);
  }

  beforeEach(async () => {
    changeRequested = createDeferred();
    const cfg = {};
    setRuntimeConfigSnapshot(cfg);
    broadcast.mockClear();
    broadcast.mockImplementation((...frame) => {
      if (frame[0] === "talk.voice.change") {
        changeRequested.resolve(frame);
      }
    });
    dispatchCurrent = true;
    context = createDirectChatContext({
      getRuntimeConfig: () => cfg,
      broadcastToConnIds: broadcast,
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    });
    // Calls retain the supplied alias; the backing runtime uses its canonical key.
    sessionTarget = await prepareTalkSessionTarget(cfg, "main");
    browser = client("voice-browser");
    originalId = await registerSession({
      provider: "openai",
      model: "gpt-live-1-codex",
      voice: "cove",
    });
  });

  afterEach(async () => {
    for (const connId of connections) {
      cleanupTalkConnection(connId, context.logGateway);
    }
    connections.clear();
    await Promise.allSettled(pending.splice(0));
    runtimes.cleanup();
    clientVoiceSessionTesting.reset();
    assertNoRetainedSessionSharingReads();
  });

  it("rejects another browser's call even for an admin", async () => {
    const params = { voiceSessionId: originalId, voice: "ember" };
    const respond = await invoke("talk.voice.set", params, client("other-browser"));
    expectFailure(respond, "No active voice call");
    expect(broadcast).not.toHaveBeenCalled();
  });

  it.each(["unbound", "retired", "missing-validator"])(
    "rejects an agent with %s authority before requesting a replacement",
    async (condition) => {
      const runtime = await runtimeClient(condition !== "unbound");
      if (condition === "retired") {
        releaseAgentRunDelegatedAuthority(runtime.authority);
      } else if (condition === "missing-validator") {
        context.validateAgentRuntimeApprovalAuthority = undefined;
      }
      const respond = await invoke("talk.voice.set", { voice: "ember" }, runtime.client);
      expectFailure(respond, "no longer owns");
      expect(broadcast).not.toHaveBeenCalled();
    },
  );

  it.each([
    { method: "talk.voice.get", params: {}, succeeds: true },
    { method: "talk.voice.set", params: { voice: " COVE " }, succeeds: true },
    { method: "talk.voice.set", params: { voice: "missing-voice" }, succeeds: false },
  ])("releases session authorization after $method with $params", async (scenario) => {
    browser.connect.scopes = ["operator.read", "operator.write"];
    const resolve = sessionAuthorization.resolveSessionMutationAuthorizationAsync;
    const release = vi.fn<() => void>();
    const spy = vi
      .spyOn(sessionAuthorization, "resolveSessionMutationAuthorizationAsync")
      .mockImplementation(async (request) => {
        const result = await resolve(request);
        if (!result.authorization?.release) {
          throw new Error("Expected a retained session authorization");
        }
        release.mockImplementation(result.authorization.release);
        return { ...result, authorization: { ...result.authorization, release } };
      });
    try {
      const respond = await invoke(scenario.method, scenario.params);
      if (scenario.succeeds) {
        expectSuccess(respond, {
          voiceSessionId: originalId,
          voice: "cove",
          ...(scenario.method === "talk.voice.set" ? { status: "applied" } : {}),
        });
      } else {
        expectFailure(respond, "not in this call's catalog");
      }
      expect(broadcast).not.toHaveBeenCalled();
      expect(spy).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it("resolves an agent's exact binding and rejects a forged call target", async () => {
    const runtime = await runtimeClient();
    expectSuccess(await invoke("talk.voice.get", {}, runtime.client), {
      voiceSessionId: originalId,
      sessionKey: "main",
      voice: "cove",
    });
    const respond = await invoke(
      "talk.voice.set",
      { voiceSessionId: "another-call", sessionKey: "agent:other:private", voice: "ember" },
      runtime.client,
    );
    expectFailure(respond, "its own call");
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("rejects voice changes after the original chat storage moves", async () => {
    context.getRuntimeConfig = () => ({
      session: { store: state.statePath("moved", "sessions.sqlite") },
    });
    expectFailure(await invoke("talk.voice.set", { voice: "cove" }), "storage target changed");
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("cancels replacement startup after the chat store moves", async () => {
    const changing = await beginChange();
    context.getRuntimeConfig = () => ({
      session: { store: state.statePath("moved", "sessions.sqlite") },
    });
    expect(() => prepareReplacement(changing.changeId)).toThrow("storage target changed");
    await changing.completed;
    expectFailure(changing.respond);
  });

  it.each(["canonicalKey", "storePath"] as const)(
    "rejects a replacement prepared with a different %s",
    async (field) => {
      const changing = await beginChange();
      const replacement = prepareReplacement(changing.changeId);
      expect(() =>
        replacement.assertCurrent({
          ...sessionTarget,
          [field]:
            field === "canonicalKey"
              ? "agent:main:other"
              : state.statePath("other", "sessions.sqlite"),
        }),
      ).toThrow("original chat");
      await changing.completed;
      expectFailure(changing.respond);
    },
  );

  it("requires the original browser to acknowledge an agent-requested replacement", async () => {
    const runtime = await runtimeClient();
    const changing = await beginChange(runtime.client);
    const { changeId } = changing;
    const replacementId = await replace(changeId);
    markTalkVoiceSessionReady(replacementId, browser.connId, sessionTarget.agentId);
    expect(changing.respond).not.toHaveBeenCalled();
    const completion = { changeId, voiceSessionId: replacementId, outcome: "ready" };
    for (const caller of [client("other-browser"), runtime.client]) {
      const rejected = await invoke("talk.voice.complete", completion, caller);
      expectFailure(rejected);
      expect(changing.respond).not.toHaveBeenCalled();
    }
    expect(await invoke("talk.voice.complete", completion)).toHaveBeenCalledWith(
      true,
      { ok: true },
      undefined,
    );
    await changing.completed;
    expectSuccess(changing.respond, {
      status: "applied",
      voiceSessionId: replacementId,
      voice: "ember",
    });
  });

  it("keeps the handoff pending until the original call retires", async () => {
    const changing = await beginChange();
    const { changeId } = changing;
    const replacementId = await replace(changeId, false);
    markTalkVoiceSessionReady(replacementId, browser.connId, sessionTarget.agentId);
    const ready = start("talk.voice.complete", {
      changeId,
      voiceSessionId: replacementId,
      outcome: "ready",
    });
    await Promise.resolve();
    expect(changing.respond).not.toHaveBeenCalled();
    expect(ready.respond).not.toHaveBeenCalled();
    const overlapping = await invoke("talk.voice.set", {
      voiceSessionId: replacementId,
      voice: "cove",
    });
    expectFailure(overlapping, "already in progress");
    unregisterTalkVoiceSession(originalId, browser.connId, sessionTarget.agentId);
    await Promise.all([changing.completed, ready.completed]);
    expectSuccess(changing.respond, { voiceSessionId: replacementId, status: "applied" });
  });

  it.each(["run", "gateway"])("rejects replacements after %s authority retires", async (owner) => {
    const runtime = await runtimeClient();
    const changing = await beginChange(runtime.client);
    const { changeId } = changing;
    if (owner === "run") {
      releaseAgentRunDelegatedAuthority(runtime.authority);
    } else {
      dispatchCurrent = false;
    }
    const failure = owner === "run" ? "no longer owns" : "Gateway dispatch retired";
    expect(() => prepareReplacement(changeId)).toThrow(failure);
    await changing.completed;
    expectFailure(changing.respond, failure);
    expect(broadcast).toHaveBeenLastCalledWith(
      "talk.voice.change",
      expect.objectContaining({ changeId, phase: "cancelled" }),
      new Set([browser.connId]),
    );
  });

  it.each(["client-failure", "replacement-close", "requester-disconnect"])(
    "does not report voice selection success after %s",
    async (ending) => {
      const runtime = await runtimeClient();
      const changing = await beginChange(runtime.client);
      const { changeId } = changing;
      const replacementId = await replace(changeId);
      if (ending === "client-failure") {
        await invoke("talk.voice.complete", {
          changeId,
          outcome: "failed",
          error: "Microphone unavailable",
        });
      } else if (ending === "replacement-close") {
        unregisterTalkVoiceSession(replacementId, browser.connId, sessionTarget.agentId);
      } else {
        cleanupTalkConnection(runtime.connId, context.logGateway);
      }
      await changing.completed;
      expectFailure(changing.respond);
      markTalkVoiceSessionReady(replacementId, browser.connId, sessionTarget.agentId);
      const late = await invoke("talk.voice.complete", {
        changeId,
        voiceSessionId: replacementId,
        outcome: "ready",
      });
      expectFailure(late);
      expect(changing.respond).toHaveBeenCalledOnce();
    },
  );
});

describe("realtime relay close persistence", () => {
  let active: Parameters<typeof stopTalkRealtimeRelaySession>[0] | undefined;
  let finalization: ReturnType<typeof createDeferred<void>> | undefined;
  let successorStateDir: string | undefined;
  let persistence: ReturnType<typeof prepareClientVoiceSessionClose> | undefined;
  afterEach(async () => {
    finalization?.resolve();
    finalization = undefined;
    if (active) {
      await stopTalkRealtimeRelaySession(active);
      active = undefined;
    }
    await Promise.allSettled(
      [...drainingRelaySessions].map(
        (session) => session.closing?.completion ?? session.voiceSessionClose ?? Promise.resolve(),
      ),
    );
    vi.restoreAllMocks();
    await persistence?.drain();
    persistence = undefined;
    clientVoiceSessionTesting.reset();
    if (successorStateDir) {
      await cleanupSessionStateForTest({ stateDir: successorStateDir });
      successorStateDir = undefined;
    }
  });
  it.each([
    {},
    { fails: true },
    { providerAsync: false },
    { providerAsync: false, fails: true },
    { changeState: true },
    { changeState: true, createRecord: false },
    { changeState: true, createRecord: false, cold: true },
    { changeState: true, permitFails: true },
    { changeState: true, createRecord: false, cold: true, sourceFails: true },
    { changeState: true, createRecord: false, cold: true, silent: true },
  ])(
    "settles realtime relay close with overrides %j",
    async ({
      providerAsync = true,
      fails = false,
      changeState = false,
      createRecord = true,
      cold = false,
      silent = false,
      sourceFails = false,
      permitFails = false,
    }) => {
      const completion = createDeferred();
      finalization = completion;
      const storePath = state.statePath("finalize-sessions.sqlite");
      const sessionKey = "agent:main:main";
      const agentDbPath = (env = process.env) =>
        resolveOpenClawAgentSqlitePath({ agentId: "main", env });
      const cfg: OpenClawConfig = { session: { store: storePath } };
      setRuntimeConfigSnapshot(cfg);
      await replaceSessionEntry(
        { agentId: "main", sessionKey, storePath },
        { sessionId: "relay-finalize", updatedAt: Date.now() },
      );
      if (!createRecord && !cold) {
        // Gateway admission can create the agent database before the first voice record.
        await replaceSessionEntry(
          { agentId: "main", sessionKey: "agent:main:host" },
          { sessionId: "admitted-host", updatedAt: Date.now() },
        );
      }
      const failure = new Error("provider cleanup failed");
      let request: RealtimeVoiceBridgeCreateRequest | undefined;
      const transcripts = [
        ["user", "check my task"],
        ["assistant", "final words"],
      ] as const;
      const finalTranscripts = () =>
        transcripts.forEach(([role, text]) => request?.onTranscript?.(role, text, true));
      const close = vi.fn(() => {
        if (providerAsync) {
          return completion.promise;
        }
        finalTranscripts();
        if (fails) {
          throw failure;
        }
        return undefined;
      });
      if (!providerAsync) {
        const appendTranscript = clientVoiceSession.appendRelayVoiceTranscript;
        vi.spyOn(clientVoiceSession, "appendRelayVoiceTranscript").mockImplementation(
          async (...args) => {
            await completion.promise;
            return appendTranscript(...args);
          },
        );
      }
      const broadcastToConnIds = vi.fn();
      const warn = vi.fn();
      const session = createTalkRealtimeRelaySession({
        context: {
          broadcastToConnIds,
          getRuntimeConfig: () => cfg,
          logGateway: { warn },
        } as never,
        connId: "conn-finalize",
        cfg,
        controlSource: "transcript",
        sessionTarget: await prepareTalkSessionTarget(cfg, sessionKey),
        provider: makeVoiceProvider((callbacks) => {
          request = callbacks;
          return makeBridge({ close });
        }),
        providerConfig: {},
        instructions: "brief",
        tools: [],
        forceAgentConsultOnFinalTranscript: true,
      });
      request?.onReady?.();
      const target = { relaySessionId: session.relaySessionId, connId: "conn-finalize" };
      const recordStatus = () =>
        clientVoiceSessionTesting.readRecord("main", session.relaySessionId)?.status;
      active = target;
      if (createRecord) {
        await ensureTalkRealtimeRelayVoiceSession({ ...target, sessionKey });
      }
      if (cold) {
        expect(fs.existsSync(agentDbPath())).toBe(false);
      }
      if (sourceFails) {
        fs.mkdirSync(agentDbPath(), { recursive: true });
      }
      const owned = relaySessions.get(session.relaySessionId);
      if (!owned) {
        throw new Error("Expected registered relay session");
      }
      active = undefined;
      if (permitFails) {
        persistence = prepareClientVoiceSessionClose();
        persistence.beginClose();
      }
      const closing = stopTalkRealtimeRelaySession(target);
      expect(closeRelaySession(owned, "completed")).toBe(closing);
      const settled = vi.fn();
      void Promise.resolve(closing).then(settled, settled);
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
      expect(() => sendTalkRealtimeRelayAudio({ ...target, audioBase64: "AQI=" })).toThrow(
        "Unknown realtime relay session",
      );
      if (providerAsync) {
        if (changeState) {
          successorStateDir = state.statePath("successor");
        }
        withEnv({ OPENCLAW_STATE_DIR: successorStateDir ?? process.env.OPENCLAW_STATE_DIR }, () => {
          if (!silent) {
            finalTranscripts();
          }
        });
      }
      if (!sourceFails && !silent) {
        if (!permitFails) {
          await owned.voiceSessionCreation;
        }
        expect(recordStatus()).toBe("open");
      }
      const emitted = () => broadcastToConnIds.mock.calls.map(([, payload]) => payload);
      expect(emitted().some((payload) => payload.type === "close")).toBe(!providerAsync);
      expect(emitted().some((payload) => payload.type === "toolCall")).toBe(false);
      if (providerAsync) {
        if (!fails) {
          request?.onClose?.("error");
        }
        request?.onClose?.("completed");
      }
      if (fails && providerAsync && !sourceFails && !permitFails) {
        completion.reject(failure);
      } else {
        completion.resolve();
      }
      if (sourceFails || permitFails) {
        await expect(closing).rejects.toThrow(sourceFails ? "regular file" : "admission is closed");
      } else if (fails) {
        await expect(closing).rejects.toBe(failure);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(failure.message));
      } else {
        await closing;
      }
      expect(close).toHaveBeenCalledOnce();
      if (!sourceFails) {
        expect(recordStatus()).toBe(permitFails ? "open" : "closed");
      }
      expect(emitted().filter((payload) => payload.type === "close")).toEqual([
        expect.objectContaining({ reason: providerAsync || fails ? "error" : "completed" }),
      ]);
      request?.onTranscript?.("assistant", "stale words", true);
      const messages = readSessionTranscriptMessageEvents({
        agentId: "main",
        sessionId: "relay-finalize",
        storePath,
      });
      expect(messages.map(({ event }) => event)).toEqual(
        silent || sourceFails || permitFails
          ? []
          : transcripts.map(([role, text]) =>
              expect.objectContaining({
                message: expect.objectContaining({ role, content: [{ type: "text", text }] }),
              }),
            ),
      );
      if (successorStateDir) {
        expect(
          fs.existsSync(agentDbPath({ ...state.env, OPENCLAW_STATE_DIR: successorStateDir })),
        ).toBe(false);
      }
    },
  );
});
