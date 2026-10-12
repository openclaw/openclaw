import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimAgentRunDelegatedAuthority,
  clearAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../../../infra/agent-run-registry.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  registerRealtimeVoiceSelection,
  type RealtimeVoiceSelectionRequest,
} from "../../../talk/voice-selection-control.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../../agent-runtime-approval-authority.js";
import { createDirectChatContext } from "../../server-chat.agent-events.test-helpers.js";
import type { GatewayClient, RespondFn } from "../../server-methods/types.js";
import { talkVoiceHandlers } from "./voice.js";

describe("channel-owned voice selection RPC", () => {
  let state: OpenClawTestState;
  const agentId = "main";
  const sessionKey = "agent:main:discord:channel:voice-room";
  const authorities: AgentRunDelegatedAuthority[] = [];
  const cleanup: Array<() => void> = [];
  const pending: Promise<void>[] = [];
  const broadcast = vi.fn();

  function managedCall(change?: (request: RealtimeVoiceSelectionRequest) => Promise<void>) {
    const runId = `channel-voice-run-${authorities.length}`;
    registerAgentRunContext(runId, { agentId, sessionKey });
    const authority = claimAgentRunDelegatedAuthority({ instanceId: `${runId}-instance`, runId });
    authorities.push(authority);
    const client: GatewayClient = {
      connId: `runtime-${runId}`,
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "gateway-client", version: "test", platform: "test", mode: "backend" },
        role: "operator",
        scopes: ["operator.admin"],
      },
      internal: {
        agentRuntimeIdentity: {
          kind: "agentRuntime",
          agentId,
          sessionKey,
          operationalRunInstance: authority.operationalRunInstance,
          delegatedAuthority: { kind: "local", ...authority },
        },
      },
    };
    let voice = "marin";
    let speakerCurrent = true;
    const apply = vi.fn(async (next: string, request: RealtimeVoiceSelectionRequest) => {
      await change?.(request);
      request.assertCurrent();
      voice = next;
    });
    const handle = registerRealtimeVoiceSelection({
      voiceSessionId: "discord-room",
      agentId,
      sessionKey,
      read: () => ({ provider: "openai", voice, voices: ["marin", "cedar"], canChange: true }),
      changeVoice: apply,
      assertCurrent: () => {},
    });
    const release = handle.bindRun({
      runId,
      assertCurrent: () => {
        if (!speakerCurrent) {
          throw new Error("Speaker authorization changed");
        }
      },
    });
    cleanup.push(release, handle.unregister);
    return {
      client,
      authority,
      apply,
      handle,
      release,
      revokeSpeaker: () => {
        speakerCurrent = false;
      },
      currentVoice: () => voice,
    };
  }

  function start(method: string, params: Record<string, unknown>, client: GatewayClient) {
    const handler = talkVoiceHandlers[method];
    if (!handler) {
      throw new Error(`Missing Talk voice handler: ${method}`);
    }
    const respond = vi.fn<RespondFn>();
    const context = createDirectChatContext({
      broadcastToConnIds: broadcast,
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    });
    const completed = Promise.resolve(
      handler({
        req: { type: "req", id: `request-${pending.length}`, method, params },
        params,
        client,
        respond,
        context,
        isWebchatConnect: () => false,
      }),
    );
    pending.push(completed);
    return { respond, completed };
  }

  async function invoke(method: string, params: Record<string, unknown>, client: GatewayClient) {
    const request = start(method, params, client);
    await request.completed;
    return request.respond;
  }

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "channel-voice-rpc", scenario: "minimal" });
    broadcast.mockClear();
  });
  afterEach(async () => {
    for (const dispose of cleanup.splice(0)) {
      dispose();
    }
    await Promise.allSettled(pending.splice(0));
    for (const authority of authorities.splice(0)) {
      releaseAgentRunDelegatedAuthority(authority);
      clearAgentRunContext(authority.operationalRunInstance.runId);
    }
    await state.cleanup();
  });

  it("lists and changes the bound channel call without a browser handoff", async () => {
    const call = managedCall();
    expect(await invoke("talk.voice.get", {}, call.client)).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        voiceSessionId: "discord-room",
        voice: "marin",
        voices: ["marin", "cedar"],
      }),
      undefined,
    );
    expect(await invoke("talk.voice.set", { voice: "Cedar" }, call.client)).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        voiceSessionId: "discord-room",
        voice: "cedar",
        status: "applied",
      }),
      undefined,
    );
    expect(call.currentVoice()).toBe("cedar");
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("rejects foreign targets and unsupported voices before reconnecting", async () => {
    const call = managedCall();
    for (const params of [
      { voice: "unknown" },
      { voice: "cedar", voiceSessionId: "another-room" },
    ]) {
      expect(await invoke("talk.voice.set", params, call.client)).toHaveBeenCalledWith(
        false,
        undefined,
        expect.any(Object),
      );
    }
    expect(call.apply).not.toHaveBeenCalled();
    expect(call.currentVoice()).toBe("marin");
  });

  it.each(["run", "binding", "call", "speaker"])(
    "rechecks %s ownership after replacement preparation",
    async (retired) => {
      const ready = createDeferredCore();
      const call = managedCall(async () => await ready.promise);
      const changing = start("talk.voice.set", { voice: "cedar" }, call.client);
      expect(call.apply).toHaveBeenCalledOnce();
      expect(changing.respond).not.toHaveBeenCalled();
      expect(await invoke("talk.voice.set", { voice: "cedar" }, call.client)).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining("already in progress") }),
      );
      if (retired === "run") {
        releaseAgentRunDelegatedAuthority(call.authority);
      } else if (retired === "binding") {
        call.release();
      } else if (retired === "call") {
        call.handle.unregister();
      } else {
        call.revokeSpeaker();
      }
      ready.resolve();
      await changing.completed;
      expect(changing.respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
      expect(call.currentVoice()).toBe("marin");
    },
  );
});
