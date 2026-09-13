import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimAgentRunDelegatedAuthority,
  clearAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import {
  createOrResumeClientVoiceSession,
  registerClientVoiceConsultRun,
} from "../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../talk/client-voice-session.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-identity-token.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { cleanupTalkConnection } from "../talk-session-registry.js";
import { prepareTalkSessionTarget } from "../talk-session-target.js";
import type { PreparedTalkSessionTarget } from "../talk-session-target.types.js";
import {
  markTalkVoiceSessionReady,
  prepareTalkVoiceReplacement,
  registerTalkVoiceSession,
  unregisterTalkVoiceSession,
} from "../talk-voice-selection.js";
import { talkVoiceHandlers } from "./talk-voice.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

describe("Talk voice RPC ownership", () => {
  let state: OpenClawTestState;
  let context: GatewayRequestContext;
  let sessionTarget: PreparedTalkSessionTarget;
  let browser: GatewayClient;
  let originalId: string;
  let dispatchCurrent: boolean;
  const connections = new Set<string>();
  const authorities: AgentRunDelegatedAuthority[] = [];
  const pending: Promise<void>[] = [];
  const broadcast = vi.fn<GatewayRequestContext["broadcastToConnIds"]>();

  function client(connId: string): GatewayClient {
    connections.add(connId);
    return {
      connId,
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "gateway-client", version: "test", platform: "test", mode: "backend" },
        role: "operator",
        scopes: ["operator.admin"],
      },
    };
  }

  function runtimeClient(bindVoice = true) {
    const runId = `voice-rpc-run-${authorities.length}`;
    registerAgentRunContext(runId, {
      agentId: sessionTarget.agentId,
      sessionKey: sessionTarget.canonicalKey,
    });
    const authority = claimAgentRunDelegatedAuthority({ instanceId: `${runId}-instance`, runId });
    authorities.push(authority);
    if (bindVoice) {
      registerClientVoiceConsultRun({
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

  function start(method: string, params: Record<string, unknown>, caller = browser) {
    const handler = talkVoiceHandlers[method];
    if (!handler) {
      throw new Error(`Missing Talk voice handler: ${method}`);
    }
    const respond = vi.fn<RespondFn>();
    const completed = Promise.resolve(
      handler({
        req: { type: "req", id: `request-${pending.length}`, method, params },
        params,
        client: caller,
        respond,
        context,
        isWebchatConnect: () => false,
        sessionMutationCommitGuard: () => {
          if (!dispatchCurrent) {
            throw new Error("Gateway dispatch retired");
          }
        },
      }),
    );
    pending.push(completed);
    return { respond, completed };
  }

  async function invoke(method: string, params: Record<string, unknown>, caller = browser) {
    const request = start(method, params, caller);
    await request.completed;
    return request.respond;
  }

  function requestedChangeId() {
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

  function replace(changeId: string, retireOriginal = true) {
    const launch = prepareTalkVoiceReplacement({
      voiceChangeId: changeId,
      connId: browser.connId,
      sessionKey: sessionTarget.sessionKey,
    });
    if (!launch || !browser.connId) {
      throw new Error("Expected an admitted voice replacement");
    }
    if (retireOriginal) {
      unregisterTalkVoiceSession(originalId, browser.connId, sessionTarget.agentId);
    }
    const voiceSessionId = createOrResumeClientVoiceSession({
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
      voiceChangeId: changeId,
      providerReady: false,
    });
    return voiceSessionId;
  }

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "talk-voice-rpc", scenario: "minimal" });
    broadcast.mockClear();
    dispatchCurrent = true;
    context = createDirectChatContext({
      broadcastToConnIds: broadcast,
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    });
    // Calls retain the supplied alias; the backing runtime uses its canonical key.
    sessionTarget = prepareTalkSessionTarget({}, "main");
    browser = client("voice-browser");
    originalId = createOrResumeClientVoiceSession({
      agentId: sessionTarget.agentId,
      sessionKey: sessionTarget.sessionKey,
      provider: "openai",
      origin: "client",
    });
    registerTalkVoiceSession({
      voiceSessionId: originalId,
      connId: "voice-browser",
      sessionTarget,
      selection: {
        provider: "openai",
        model: "gpt-live-1-codex",
        voice: "cove",
        voices: ["cove", "ember"],
        canChange: true,
      },
      launch: { provider: "openai", model: "gpt-live-1-codex" },
      providerReady: true,
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
    await state.cleanup();
  });

  it.each(["talk.voice.get", "talk.voice.set"])(
    "rejects another browser's call through %s even for an admin",
    async (method) => {
      const respond = await invoke(
        method,
        { voiceSessionId: originalId, ...(method === "talk.voice.set" ? { voice: "ember" } : {}) },
        client("other-browser"),
      );
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining("No active voice call") }),
      );
      expect(broadcast).not.toHaveBeenCalled();
    },
  );

  it.each(["unbound", "retired", "missing-validator"])(
    "rejects an agent with %s authority before requesting a replacement",
    async (condition) => {
      const runtime = runtimeClient(condition !== "unbound");
      if (condition === "retired") {
        releaseAgentRunDelegatedAuthority(runtime.authority);
      } else if (condition === "missing-validator") {
        context.validateAgentRuntimeApprovalAuthority = undefined;
      }
      const respond = await invoke("talk.voice.set", { voice: "ember" }, runtime.client);
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining("no longer owns") }),
      );
      expect(broadcast).not.toHaveBeenCalled();
    },
  );

  it("keeps the current voice connected and rejects voices outside the call catalog", async () => {
    const unchanged = await invoke("talk.voice.set", { voice: " COVE " });
    expect(unchanged).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "applied", voiceSessionId: originalId, voice: "cove" }),
      undefined,
    );
    const invalid = await invoke("talk.voice.set", { voice: "missing-voice" });
    expect(invalid).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("not in this call's catalog") }),
    );
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("resolves an agent's exact binding and rejects a forged call target", async () => {
    const runtime = runtimeClient();
    expect(await invoke("talk.voice.get", {}, runtime.client)).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ voiceSessionId: originalId, sessionKey: "main", voice: "cove" }),
      undefined,
    );
    const respond = await invoke(
      "talk.voice.set",
      { voiceSessionId: "another-call", sessionKey: "agent:other:private", voice: "ember" },
      runtime.client,
    );
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("its own call") }),
    );
    expect(broadcast).not.toHaveBeenCalled();
  });

  it.each(["talk.voice.get", "talk.voice.set"])(
    "rejects %s after the original chat storage moves",
    async (method) => {
      context.getRuntimeConfig = () => ({
        session: { store: state.statePath("moved", "sessions.sqlite") },
      });
      const respond = await invoke(method, method.endsWith("set") ? { voice: "cove" } : {});
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining("storage target changed") }),
      );
      expect(broadcast).not.toHaveBeenCalled();
    },
  );

  it("cancels replacement startup when the configured chat store moves after dispatch", async () => {
    const changing = start("talk.voice.set", { voice: "ember" });
    const changeId = requestedChangeId();
    context.getRuntimeConfig = () => ({
      session: { store: state.statePath("moved", "sessions.sqlite") },
    });
    expect(() =>
      prepareTalkVoiceReplacement({
        voiceChangeId: changeId,
        connId: browser.connId,
        sessionKey: sessionTarget.sessionKey,
      }),
    ).toThrow("storage target changed");
    await changing.completed;
    expect(changing.respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
  });

  it.each(["canonicalKey", "storePath"] as const)(
    "rejects a replacement prepared with a different %s",
    async (field) => {
      const changing = start("talk.voice.set", { voice: "ember" });
      const replacement = prepareTalkVoiceReplacement({
        voiceChangeId: requestedChangeId(),
        connId: browser.connId,
        sessionKey: sessionTarget.sessionKey,
      });
      if (!replacement) {
        throw new Error("Expected an admitted voice replacement");
      }
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
      expect(changing.respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
    },
  );

  it("requires the original browser's ready acknowledgement for an agent-requested replacement", async () => {
    const runtime = runtimeClient();
    const changing = start("talk.voice.set", { voice: "ember" }, runtime.client);
    const changeId = requestedChangeId();
    const replacementId = replace(changeId);
    markTalkVoiceSessionReady(replacementId, browser.connId, sessionTarget.agentId);
    expect(changing.respond).not.toHaveBeenCalled();
    const completion = { changeId, voiceSessionId: replacementId, outcome: "ready" };
    for (const caller of [client("other-browser"), runtime.client]) {
      const rejected = await invoke("talk.voice.complete", completion, caller);
      expect(rejected).toHaveBeenCalledWith(false, undefined, expect.any(Object));
      expect(changing.respond).not.toHaveBeenCalled();
    }
    expect(await invoke("talk.voice.complete", completion)).toHaveBeenCalledWith(
      true,
      { ok: true },
      undefined,
    );
    await changing.completed;
    expect(changing.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "applied", voiceSessionId: replacementId, voice: "ember" }),
      undefined,
    );
  });

  it("keeps the handoff pending until the original call retires", async () => {
    const changing = start("talk.voice.set", { voice: "ember" });
    const changeId = requestedChangeId();
    const replacementId = replace(changeId, false);
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
    expect(overlapping).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("already in progress") }),
    );
    unregisterTalkVoiceSession(originalId, browser.connId, sessionTarget.agentId);
    await Promise.all([changing.completed, ready.completed]);
    expect(changing.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ voiceSessionId: replacementId, status: "applied" }),
      undefined,
    );
  });

  it.each(["run", "gateway"])(
    "rejects replacement allocation when %s authority retires after dispatch",
    async (owner) => {
      const runtime = runtimeClient();
      const changing = start("talk.voice.set", { voice: "ember" }, runtime.client);
      const changeId = requestedChangeId();
      if (owner === "run") {
        releaseAgentRunDelegatedAuthority(runtime.authority);
      } else {
        dispatchCurrent = false;
      }
      const failure = owner === "run" ? "no longer owns" : "Gateway dispatch retired";
      expect(() =>
        prepareTalkVoiceReplacement({
          voiceChangeId: changeId,
          connId: browser.connId,
          sessionKey: sessionTarget.sessionKey,
        }),
      ).toThrow(failure);
      await changing.completed;
      expect(changing.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining(failure) }),
      );
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
      const runtime = runtimeClient();
      const changing = start("talk.voice.set", { voice: "ember" }, runtime.client);
      const changeId = requestedChangeId();
      const replacementId = replace(changeId);
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
      expect(changing.respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
      markTalkVoiceSessionReady(replacementId, browser.connId, sessionTarget.agentId);
      const late = await invoke("talk.voice.complete", {
        changeId,
        voiceSessionId: replacementId,
        outcome: "ready",
      });
      expect(late).toHaveBeenCalledWith(false, undefined, expect.any(Object));
      expect(changing.respond).toHaveBeenCalledOnce();
    },
  );
});
