import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import { assertNoRetainedSessionSharingReads } from "../../../config/sessions/session-accessor.sqlite-diagnostics.test-support.js";
import {
  claimAgentRunDelegatedAuthority,
  clearAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../../../infra/agent-run-registry.js";
import {
  createOrResumeClientVoiceSession,
  registerClientVoiceConsultRun,
} from "../../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../../agent-runtime-approval-authority.js";
import { createDirectChatContext } from "../../server-chat.agent-events.test-helpers.js";
import type { GatewayRequestContext } from "../../server-methods/types.js";
import * as sessionAuthorization from "../../session-sharing-authorization-async.js";
import { cleanupTalkConnection } from "../session-registry.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import type { PreparedTalkSessionTarget } from "../session-target.types.js";
import {
  markTalkVoiceSessionReady,
  prepareTalkVoiceReplacement,
  registerTalkVoiceSession,
  unregisterTalkVoiceSession,
} from "../voice-selection.js";
import { expectFailure, expectSuccess, voiceClient, voiceRpc } from "./voice-rpc.test-support.js";

describe("Talk voice RPC ownership", () => {
  let state: OpenClawTestState;
  let context: GatewayRequestContext;
  let sessionTarget: PreparedTalkSessionTarget;
  let browser: ReturnType<typeof voiceClient>;
  let originalId: string;
  let dispatchCurrent: boolean;
  let changeRequested: ReturnType<typeof createDeferred<void>>;
  const connections = new Set<string>();
  const authorities: AgentRunDelegatedAuthority[] = [];
  const pending: Promise<void>[] = [];
  const broadcast = vi.fn<GatewayRequestContext["broadcastToConnIds"]>();

  function client(connId: string) {
    connections.add(connId);
    return voiceClient(connId);
  }

  async function runtimeClient(bindVoice = true) {
    const runId = `voice-rpc-run-${authorities.length}`;
    registerAgentRunContext(runId, {
      agentId: sessionTarget.agentId,
      sessionKey: sessionTarget.canonicalKey,
    });
    const authority = claimAgentRunDelegatedAuthority({ instanceId: `${runId}-instance`, runId });
    authorities.push(authority);
    if (bindVoice) {
      await registerClientVoiceConsultRun({
        agentId: sessionTarget.agentId,
        sessionKey: sessionTarget.sessionKey,
        voiceSessionId: originalId,
        runId,
      });
    }
    const connId = `agent-runtime-${runId}`;
    return {
      authority,
      connId,
      client: {
        ...client(connId),
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime" as const,
            agentId: sessionTarget.agentId,
            sessionKey: sessionTarget.canonicalKey,
            operationalRunInstance: authority.operationalRunInstance,
            delegatedAuthority: { kind: "local" as const, ...authority },
          },
        },
      },
    };
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

  async function requestedChangeId(completed: Promise<void>) {
    await awaitGateBeforeSettlement(
      changeRequested.promise,
      completed,
      "Voice change settled before requesting a replacement",
    );
    const frame = broadcast.mock.calls.find(([event]) => event === "talk.voice.change");
    const payload = frame?.[1];
    if (
      !payload ||
      typeof payload !== "object" ||
      !("changeId" in payload) ||
      typeof payload.changeId !== "string"
    ) {
      throw new Error("Expected a requested voice change");
    }
    expect(payload).toMatchObject({
      phase: "requested",
      voiceSessionId: originalId,
      sessionKey: sessionTarget.sessionKey,
      voice: "ember",
    });
    expect(frame?.[2]).toEqual(new Set([browser.connId]));
    return payload.changeId;
  }

  function prepareReplacement(changeId: string) {
    const replacement = prepareTalkVoiceReplacement({
      voiceChangeId: changeId,
      connId: browser.connId,
      sessionKey: sessionTarget.sessionKey,
    });
    if (!replacement || !browser.connId) {
      throw new Error("Expected an admitted voice replacement");
    }
    return replacement;
  }

  async function registerSession(
    launch: { provider: string; model?: string; voice: string },
    voiceChangeId?: string,
  ) {
    const voiceSessionId = await createOrResumeClientVoiceSession({
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
        provider: launch.provider,
        model: launch.model,
        voice: launch.voice,
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
    state = await createOpenClawTestState({ label: "talk-voice-rpc", scenario: "minimal" });
    changeRequested = createDeferred();
    const cfg = {};
    setRuntimeConfigSnapshot(cfg);
    broadcast.mockClear();
    broadcast.mockImplementation((event, payload) => {
      if (
        event === "talk.voice.change" &&
        payload &&
        typeof payload === "object" &&
        "phase" in payload &&
        payload.phase === "requested"
      ) {
        changeRequested.resolve();
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
    for (const authority of authorities.splice(0)) {
      releaseAgentRunDelegatedAuthority(authority);
      clearAgentRunContext(authority.operationalRunInstance.runId);
    }
    clientVoiceSessionTesting.reset();
    try {
      assertNoRetainedSessionSharingReads();
    } finally {
      await state.cleanup();
    }
  });

  it("rejects another browser's call even for an admin", async () => {
    expectFailure(
      await invoke(
        "talk.voice.set",
        { voiceSessionId: originalId, voice: "ember" },
        client("other-browser"),
      ),
      "No active voice call",
    );
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

  it("keeps the current voice connected and rejects voices outside the call catalog", async () => {
    const unchanged = await invoke("talk.voice.set", { voice: " COVE " });
    expectSuccess(unchanged, { status: "applied", voiceSessionId: originalId, voice: "cove" });
    const invalid = await invoke("talk.voice.set", { voice: "missing-voice" });
    expectFailure(invalid, "not in this call's catalog");
    expect(broadcast).not.toHaveBeenCalled();
  });

  it.each([
    { method: "talk.voice.get", params: {}, succeeds: true },
    { method: "talk.voice.set", params: { voice: "cove" }, succeeds: true },
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
      expect(respond).toHaveBeenCalledWith(
        scenario.succeeds,
        scenario.succeeds ? expect.any(Object) : undefined,
        scenario.succeeds
          ? undefined
          : expect.objectContaining({
              message: expect.stringContaining("not in this call's catalog"),
            }),
      );
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

  it("cancels replacement startup when the configured chat store moves after dispatch", async () => {
    const changing = start("talk.voice.set", { voice: "ember" });
    const changeId = await requestedChangeId(changing.completed);
    context.getRuntimeConfig = () => ({
      session: { store: state.statePath("moved", "sessions.sqlite") },
    });
    expect(() => prepareReplacement(changeId)).toThrow("storage target changed");
    await changing.completed;
    expectFailure(changing.respond);
  });

  it.each(["canonicalKey", "storePath"] as const)(
    "rejects a replacement prepared with a different %s",
    async (field) => {
      const changing = start("talk.voice.set", { voice: "ember" });
      const replacement = prepareReplacement(await requestedChangeId(changing.completed));
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

  it("requires the original browser's ready acknowledgement for an agent-requested replacement", async () => {
    const runtime = await runtimeClient();
    const changing = start("talk.voice.set", { voice: "ember" }, runtime.client);
    const changeId = await requestedChangeId(changing.completed);
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
    const changing = start("talk.voice.set", { voice: "ember" });
    const changeId = await requestedChangeId(changing.completed);
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

  it.each(["run", "gateway"])(
    "rejects replacement allocation when %s authority retires after dispatch",
    async (owner) => {
      const runtime = await runtimeClient();
      const changing = start("talk.voice.set", { voice: "ember" }, runtime.client);
      const changeId = await requestedChangeId(changing.completed);
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
    },
  );

  it.each(["client-failure", "replacement-close", "requester-disconnect"])(
    "does not report voice selection success after %s",
    async (ending) => {
      const runtime = await runtimeClient();
      const changing = start("talk.voice.set", { voice: "ember" }, runtime.client);
      const changeId = await requestedChangeId(changing.completed);
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
