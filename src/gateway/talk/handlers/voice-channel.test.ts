import { AsyncResource } from "node:async_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../../test/helpers/promise.js";
import { releaseAgentRunDelegatedAuthority } from "../../../infra/agent-run-registry.js";
import { createPluginRuntimeStore } from "../../../plugin-sdk/runtime-store.js";
import { PluginInstance } from "../../../plugins/plugin-instance.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { registerRealtimeVoiceSelection } from "../../../talk/voice-selection-control.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../../agent-runtime-approval-authority.js";
import { createDirectChatContext } from "../../server-chat.agent-events.test-helpers.js";
import { expectFailure, expectSuccess, voiceRpc, voiceRuntimes } from "./voice-rpc.test-support.js";
// Managed admin calls use in-memory authority and do not need a session store.
describe("channel-owned voice selection RPC", () => {
  const agentId = "main";
  const sessionKey = "agent:main:discord:channel:voice-room";
  const runtimes = voiceRuntimes();
  const cleanup: Array<() => void> = [];
  const pending: Promise<void>[] = [];
  const broadcast = vi.fn();

  function managedCall(change?: () => Promise<void>) {
    const runtime = runtimes.create(agentId, sessionKey);
    let voice = "marin";
    const speaker = new AbortController();
    const handle = registerRealtimeVoiceSelection({
      voiceSessionId: "discord-room",
      agentId,
      sessionKey,
      read: () => ({ provider: "openai", voice, voices: ["marin", "cedar"], canChange: true }),
      changeVoice: async (next, request) => {
        await change?.();
        request.assertCurrent();
        voice = next;
      },
      assertCurrent: () => {},
    });
    const release = handle.bindRun({
      runId: runtime.runId,
      assertCurrent: () => speaker.signal.throwIfAborted(),
    });
    cleanup.push(release, handle.unregister);
    return {
      ...runtime,
      retire: {
        run: () => releaseAgentRunDelegatedAuthority(runtime.authority),
        binding: release,
        call: handle.unregister,
        speaker: () => speaker.abort(new Error("Speaker authorization changed")),
      },
      currentVoice: () => voice,
    };
  }

  const { start, invoke } = voiceRpc(pending, () => ({
    client: null,
    context: createDirectChatContext({
      getRuntimeConfig: () => ({}),
      broadcastToConnIds: broadcast,
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    }),
  }));

  afterEach(async () => {
    cleanup.splice(0).forEach((dispose) => dispose());
    await Promise.allSettled(pending.splice(0));
    runtimes.cleanup();
    broadcast.mockClear();
  });

  it("lists and changes the channel voice while retaining its plugin runtime for later consults", async () => {
    const discordInstance = new PluginInstance("discord");
    const talkVoiceInstance = new PluginInstance("talk-voice");
    const runtimeStore = createPluginRuntimeStore<string>({
      pluginId: "discord",
      errorMessage: "Discord runtime not initialized",
    });
    let consult: (() => string) | undefined;
    try {
      discordInstance.run(() => runtimeStore.setRuntime("discord-runtime"));
      const call = discordInstance.run(() =>
        managedCall(async () => {
          consult = new AsyncResource("discord-replacement-consult").bind(() =>
            runtimeStore.getRuntime(),
          );
        }),
      );
      expectSuccess(await invoke("talk.voice.get", {}, call.client), {
        voiceSessionId: "discord-room",
        voice: "marin",
        voices: ["marin", "cedar"],
      });
      for (const params of [
        { voice: "unknown" },
        { voice: "cedar", voiceSessionId: "another-room" },
      ]) {
        expectFailure(await invoke("talk.voice.set", params, call.client));
      }
      expect(consult).toBeUndefined();
      expect(call.currentVoice()).toBe("marin");
      expectSuccess(
        await talkVoiceInstance.run(() =>
          invoke("talk.voice.set", { voice: "Cedar" }, call.client),
        ),
        { voiceSessionId: "discord-room", voice: "cedar", status: "applied" },
      );
      expect(broadcast).not.toHaveBeenCalled();
      expect(consult?.()).toBe("discord-runtime");
    } finally {
      await Promise.all([discordInstance.dispose(), talkVoiceInstance.dispose()]);
    }
  });

  it.for(["run", "binding", "call", "speaker"] as const)(
    "rechecks %s ownership after replacement preparation",
    async (retired, { signal }) => {
      const entered = createDeferredCore();
      const ready = createDeferredCore();
      const call = managedCall(async () => {
        entered.resolve();
        await ready.promise;
      });
      const changing = start("talk.voice.set", { voice: "cedar" }, call.client);
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            entered.promise,
            changing.completed,
            "Voice replacement did not reach preparation",
          ),
          signal,
        );
        expect(changing.respond).not.toHaveBeenCalled();
        expectFailure(
          await invoke("talk.voice.set", { voice: "cedar" }, call.client),
          "already in progress",
        );
        call.retire[retired]();
      } finally {
        ready.resolve();
      }
      await changing.completed;
      expectFailure(changing.respond);
      expect(call.currentVoice()).toBe("marin");
    },
  );
});
