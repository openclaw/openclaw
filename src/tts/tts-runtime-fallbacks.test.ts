import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  markCommandReplyForDelivery,
  setReplyPayloadMetadata,
} from "../auto-reply/reply-payload.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import { routeReply } from "../auto-reply/reply/route-reply.js";
import * as bundledChannelPlugins from "../channels/plugins/bundled.js";
import * as globals from "../globals.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  createMockSpeechProvider,
  createTtsConfig,
  expectTtsPayloadResult,
  installSpeechProviders,
  maybeApplyTtsToPayload,
  maybeApplyTtsToPayloadCore,
  prefsPathFor,
  requireFirstSynthesisRequest,
  requireRecord,
  resetTtsRuntime,
  setSummarizationEnabled,
  setTtsMaxLength,
  synthesizeMock,
  synthesizeSpeech,
  withTtsPayload,
  type OpenClawConfig,
  type ReplyPayload,
} from "./tts-runtime.test-support.js";

const routedPayloads = vi.hoisted(() => [] as ReplyPayload[]);

function payloadRequest(
  payload: ReplyPayload,
  prefsName: string,
): Parameters<typeof maybeApplyTtsToPayload>[0] {
  return {
    payload,
    cfg: createTtsConfig(prefsName),
    channel: "telegram",
    kind: "final",
  };
}

function slackData(structured: boolean) {
  return structured
    ? {
        slack: {
          blocks: [{ type: "section", text: { type: "mrkdwn", text: "Visible channel card" } }],
        },
      }
    : { slack: { unfurl: false } };
}

vi.mock("../channels/message/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channels/message/runtime.js")>();
  return {
    ...actual,
    sendDurableMessageBatchCore: async ({ payloads }: { payloads: ReplyPayload[] }) => {
      routedPayloads.push(...payloads);
      return { status: "sent", results: [{ messageId: "tts-route-1" }] };
    },
  };
});

function installStructuredReplyTestChannel(loaded: boolean): () => void {
  const previousRegistry = captureActivePluginRegistrySnapshot();
  const channelPlugin = {
    ...createChannelTestPluginBase({ id: "slack" }),
    messaging: {
      hasStructuredReplyPayload: ({ payload }: { payload: ReplyPayload }) => {
        const blocks = (payload.channelData?.slack as { blocks?: unknown } | undefined)?.blocks;
        return Array.isArray(blocks) && blocks.length > 0;
      },
    },
  };
  const originalGetBundledChannelPlugin = bundledChannelPlugins.getBundledChannelPlugin;
  const bundledPluginOverride = loaded
    ? undefined
    : vi
        .spyOn(bundledChannelPlugins, "getBundledChannelPlugin")
        .mockImplementation((channelId) =>
          channelId === channelPlugin.id
            ? channelPlugin
            : originalGetBundledChannelPlugin(channelId),
        );
  const entry = { pluginId: "slack", source: "tts-runtime-fallback-test", plugin: channelPlugin };
  setActivePluginRegistry(createTestRegistry(loaded ? [entry] : []));
  return () => {
    bundledPluginOverride?.mockRestore();
    restoreActivePluginRegistrySnapshot(previousRegistry);
  };
}

async function dispatchSpeechReply(
  reply: ReplyPayload,
  cfg: OpenClawConfig,
  persistAudio: Parameters<typeof maybeApplyTtsToPayloadCore>[1],
): Promise<void> {
  const routingResults: Array<Awaited<ReturnType<typeof routeReply>>> = [];
  const dispatcher = createReplyDispatcher({
    beforeDeliver: (payload, info) =>
      maybeApplyTtsToPayloadCore({ payload, cfg, channel: "slack", kind: info.kind }, persistAudio),
    deliver: async (payload, info) => {
      routingResults.push(
        await routeReply({
          payload,
          channel: "slack",
          to: "channel:C123",
          cfg,
          replyKind: info.kind,
        }),
      );
    },
  });
  expect(dispatcher.sendFinalReply(reply)).toBe(true);
  dispatcher.markComplete();
  await dispatcher.waitForIdle();
  expect(routingResults).toEqual([{ ok: true, delivered: true, messageId: "tts-route-1" }]);
  expect(routedPayloads).toHaveLength(1);
}

describe("TTS runtime provider fallback and delivery behavior", () => {
  afterEach(() => {
    resetTtsRuntime();
    routedPayloads.length = 0;
  });

  it("keeps terminal command replies text-only with automatic TTS enabled", async () => {
    const payload = { text: "The requested command is complete." };
    markCommandReplyForDelivery(payload);
    const result = await maybeApplyTtsToPayloadCore(
      {
        payload,
        cfg: createTtsConfig("openclaw-command-auto-tts"),
        channel: "slack",
        kind: "final",
        inboundAudio: true,
        ttsAuto: "always",
      },
      async () => "/unused.ogg",
    );

    expect(result).toBe(payload);
    expect(synthesizeMock).not.toHaveBeenCalled();
  });

  it("synthesizes persisted TTS facts without logging model directive content", async () => {
    using log = vi.spyOn(globals, "logVerbose").mockImplementation(() => {});
    const payload = setReplyPayloadMetadata(
      { text: "Visible answer" },
      {
        tts: {
          tagged: true,
          text: "Spoken answer",
          directives: [
            { provider: "mock", values: { "synthetic-private-directive": "private-value" } },
          ],
        },
      },
    );

    const result = await maybeApplyTtsToPayload({
      payload,
      cfg: createTtsConfig("tts-persisted-facts", { modelOverrides: { allowProvider: true } }),
      channel: "telegram",
      kind: "final",
      ttsAuto: "tagged",
    });

    expect(requireFirstSynthesisRequest("persisted TTS facts")).toMatchObject({
      text: "Spoken answer",
    });
    expect(result).toMatchObject({
      text: "Visible answer",
      spokenText: "Spoken answer",
    });
    expect(log).toHaveBeenCalledWith("TTS: ignored 1 directive override(s)");
    expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic-private-directive");
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-value");
  });

  it("uses the first speech-supported voiceModel fallback as the default provider", async () => {
    installSpeechProviders([
      createMockSpeechProvider("openai", {
        autoSelectOrder: 1,
        models: ["gpt-4o-mini-tts"],
      }),
      createMockSpeechProvider("elevenlabs", {
        autoSelectOrder: 99,
        models: ["eleven_multilingual_v2"],
      }),
    ]);

    const voiceModel = {
      primary: "openai/gpt-realtime-2",
      fallbacks: ["elevenlabs/eleven_multilingual_v2"],
    };
    const result = await synthesizeSpeech({
      text: "Use first speech-supported voice model.",
      cfg: {
        agents: { defaults: { voiceModel } },
        tts: {
          enabled: true,
          prefsPath: "/tmp/openclaw-speech-core-supported-voice-model-provider-test.json",
        },
      },
    });

    expect(result.success).toBe(true);
    expect(result.provider).toBe("elevenlabs");
    expect(result.providerModel).toBe("eleven_multilingual_v2");
    expect(result.attemptedProviders).toEqual(["elevenlabs"]);
  });

  it("preserves alias-keyed provider config when resolving canonical providers", async () => {
    installSpeechProviders([
      createMockSpeechProvider("xiaomi", {
        aliases: ["mimo"],
        resolveConfig: ({ rawConfig }) => {
          const providers = requireRecord(rawConfig.providers, "raw provider configs");
          return requireRecord(providers.xiaomi ?? providers.mimo, "raw xiaomi provider config");
        },
      }),
    ]);

    const result = await synthesizeSpeech({
      text: "Use alias provider config.",
      cfg: createTtsConfig("tts-alias-provider", {
        provider: "xiaomi",
        providers: { mimo: { apiKey: "fake" } },
      }),
      disableFallback: true,
    });

    expect(result.success).toBe(true);
    const request = requireFirstSynthesisRequest("alias provider synthesis request");
    expect(request.providerConfig).toMatchObject({ apiKey: "fake" });
  });

  it("maps speakerVoice persona provider config to provider-compatible voice fields", async () => {
    const result = await synthesizeSpeech({
      text: "Use the persona speaker.",
      cfg: createTtsConfig("tts-speaker-persona", {
        persona: "narrator",
        personas: { narrator: { providers: { mock: { speakerVoice: "marin" } } } },
      }),
      disableFallback: true,
    });

    expect(result.success).toBe(true);
    expect(result.providerVoice).toBe("marin");
    const request = requireFirstSynthesisRequest("persona speaker voice synthesis request");
    expect(request.providerConfig).toMatchObject({
      speakerVoice: "marin",
      voice: "marin",
      voiceName: "marin",
    });
  });

  it("marks voice-note TTS for channel-side transcoding when provider returns mp3", async () => {
    await expectTtsPayloadResult({
      channel: "feishu",
      prefsName: "tts-feishu-mp3-test",
      text: "This reply should be transcoded by the channel.",
      target: "voice-note",
      audioAsVoice: true,
      mediaExtension: "mp3",
      providerResult: {
        audioBuffer: Buffer.from("mp3"),
        outputFormat: "mp3",
        fileExtension: ".mp3",
        voiceCompatible: false,
      },
    });
  });

  it.each([
    { failure: "provider", loaded: true, structured: false },
    { failure: "storage", loaded: true, structured: true },
    { failure: "cold", loaded: true, structured: true },
    { failure: "cold", loaded: false, structured: false },
  ])(
    "routes hidden speech on $failure failure (loaded: $loaded, structured: $structured)",
    async ({ failure, loaded, structured }) => {
      const cold = failure === "cold";
      const { setSpeechRuntimeAvailabilityGuard } = await import("./runtime-availability.js");
      const restoreRegistry = installStructuredReplyTestChannel(loaded);
      if (cold) {
        setSpeechRuntimeAvailabilityGuard(() => {
          throw new Error("speech runtime configured cold");
        });
      }
      if (failure === "provider") {
        synthesizeMock.mockRejectedValueOnce(new Error("Speech provider unavailable"));
      }
      try {
        const answer = cold ? "Spoken greeting" : "Your important answer is ready.";
        const channelData = slackData(structured);
        await dispatchSpeechReply(
          cold
            ? setReplyPayloadMetadata(
                { text: "", channelData },
                {
                  ttsExplicit: true,
                  tts: { tagged: true, text: answer },
                },
              )
            : { text: "[[tts:text]]" + answer + "[[/tts:text]]", channelData },
          createTtsConfig("tts-router-" + failure + "-" + loaded),
          async () => {
            if (cold) {
              return "unused";
            }
            throw new Error("Media exceeds configured limit");
          },
        );
        expect(routedPayloads[0]).toMatchObject({
          text: structured ? (cold ? "" : undefined) : answer,
          channelData,
        });
        if (cold) {
          expect(synthesizeMock).not.toHaveBeenCalled();
        } else {
          expect((await import("./runtime-api.js")).getLastTtsAttempt()).toMatchObject({
            success: false,
            attemptedProviders: ["mock"],
          });
        }
      } finally {
        setSpeechRuntimeAvailabilityGuard(undefined);
        restoreRegistry();
      }
    },
  );

  it("keeps visible text when synthesis fails without logging the provider's text echo", async () => {
    using log = vi.spyOn(globals, "logVerbose").mockImplementation(() => {});
    synthesizeMock.mockImplementationOnce(async ({ text }: { text: string }) => {
      throw new Error(text);
    });
    const result = await maybeApplyTtsToPayloadCore(
      {
        payload: {
          text: "Visible answer [[tts:text]]Hidden expressive answer[[/tts:text]]",
        },
        cfg: createTtsConfig("openclaw-speech-core-visible-hidden-tts-provider-failure"),
        channel: "telegram",
        kind: "final",
      },
      async () => "/unused.ogg",
    );

    expect(result).toEqual({ text: "Visible answer" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("mock failed (provider_error)"));
    expect(JSON.stringify(log.mock.calls)).not.toContain("Hidden expressive answer");
  });

  it("keeps hidden TTS text private when the reply already contains an attachment", async () => {
    const result = await maybeApplyTtsToPayloadCore(
      payloadRequest(
        {
          text: "[[tts:text]]This must remain audio-only.[[/tts:text]]",
          mediaUrl: "https://example.invalid/already-attached.png",
        },
        "openclaw-speech-core-hidden-tts-existing-attachment",
      ),
      async () => {
        throw new Error("Media storage must not be called");
      },
    );

    expect(result).toEqual({
      text: undefined,
      mediaUrl: "https://example.invalid/already-attached.png",
    });
    expect(synthesizeMock).not.toHaveBeenCalled();
  });

  it.each(["```printf```", "> ```\n> x"])("keeps auto-TTS prose after %s", async (prefix) => {
    const prose = "This explanation is ordinary prose and should be spoken in full.";
    const text = `${prefix}\n\n${prose}`;
    const result = await maybeApplyTtsToPayloadCore(
      payloadRequest({ text }, "fenced-prose"),
      async () => "/synthetic-speech.mp3",
    );

    expect(synthesizeMock).toHaveBeenCalledOnce();
    expect(requireFirstSynthesisRequest("prose speech").text).toContain(prose);
    expect(result).toEqual(expect.objectContaining({ text, mediaUrl: "/synthetic-speech.mp3" }));
  });

  it.each<{ name: string; text: string; audioAsVoice?: true; block?: true }>([
    { name: "code-heavy", text: "```ts\nexport function answer() {\n  return 42;\n}\n```" },
    { name: "short untagged", text: "hello", audioAsVoice: true },
    { name: "empty hidden markdown", text: "[[tts:text]]***[[/tts:text]]", audioAsVoice: true },
    {
      name: "block before final",
      text: "WebChat block stream chunks defer TTS to the final tail.",
      block: true,
    },
  ])("skips automatic synthesis for $name", async ({ name, text, audioAsVoice, block }) => {
    const payload = audioAsVoice ? { text, audioAsVoice } : { text };
    const result = await maybeApplyTtsToPayload({
      ...payloadRequest(payload, "tts-skip-" + name),
      ...(block ? { channel: "webchat", kind: "block" } : {}),
    });
    expect(synthesizeMock).not.toHaveBeenCalled();
    expect(result).toEqual(name === "empty hidden markdown" ? { audioAsVoice: true } : payload);
    if (block) {
      expect((result as { trustedLocalMedia?: boolean }).trustedLocalMedia).toBeUndefined();
    }
  });

  it("synthesizes explicitly tagged short hidden TTS text", async () => {
    await withTtsPayload(
      payloadRequest(
        { text: "[[tts:text]]hello[[/tts:text]]", audioAsVoice: true },
        "openclaw-speech-core-short-hidden-tts-test",
      ),
      (result) => {
        expect(requireFirstSynthesisRequest("hidden TTS request").text).toBe("hello");
        expect(result.mediaUrl).toMatch(/voice---[a-f0-9-]+\.ogg$/);
        expect(result.audioAsVoice).toBe(true);
        expect(result.text).toBeUndefined();
        expect(result.ttsSupplement).toBeUndefined();
      },
    );
  });

  it("truncates long TTS text on a UTF-16 boundary", async () => {
    const prefsName = "openclaw-speech-core-utf16-truncate-test";
    const prefsPath = prefsPathFor(prefsName);
    const cfg = createTtsConfig(prefsName);
    setTtsMaxLength(prefsPath, 11);
    setSummarizationEnabled(prefsPath, false);
    try {
      await withTtsPayload(
        {
          payload: { text: `${"a".repeat(7)}😀tail long enough for TTS` },
          cfg,
          preparedTtsPreferences: { machinePrefsPath: prefsPath },
          channel: "telegram",
          kind: "final",
        },
        (result) => {
          const request = requireFirstSynthesisRequest("utf16 truncated TTS request");
          const spokenText = String(request.text);
          expect(spokenText).toBe(`${"a".repeat(7)}...`);
          expect(result.spokenText).toBe(spokenText);
        },
      );
    } finally {
      rmSync(prefsPath, { force: true });
    }
  });
});
