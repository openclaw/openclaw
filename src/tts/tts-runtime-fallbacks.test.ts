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
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import { discoverConfigSecretTargetsByIds } from "../secrets/target-registry.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  MAX_TIMER_TIMEOUT_MS,
  createMockSpeechProvider,
  createTtsConfig,
  getTtsPersona,
  getTtsProviderAsync,
  installSpeechProviders,
  isTtsProviderConfiguredAsync,
  maybeApplyTtsToPayload,
  maybeApplyTtsToPayloadCore,
  prefsPathFor,
  prepareSynthesisMock,
  requireAttempt,
  requireFirstSynthesisRequest,
  requireRecord,
  resetTtsRuntime,
  resolveTtsConfig,
  setSummarizationEnabled,
  setTtsMachinePrefsPathResolver,
  setTtsMaxLength,
  synthesizeMock,
  synthesizeSpeech,
  textToSpeechStream,
  textToSpeechTelephony,
  withTtsPayload,
  type OpenClawConfig,
  type ReplyPayload,
  type SpeechSynthesisRequest,
  type SpeechTelephonySynthesisRequest,
  type TtsConfig,
} from "./tts-runtime.test-support.js";

function speak(
  cfg: OpenClawConfig,
  options: Omit<Parameters<typeof synthesizeSpeech>[0], "cfg" | "text"> = {},
) {
  return synthesizeSpeech({ text: "Read this fixture.", cfg, ...options });
}

const routedPayloads = vi.hoisted(() => [] as ReplyPayload[]);
afterEach(() => {
  resetTtsRuntime();
  clearSecretsRuntimeSnapshot();
  routedPayloads.length = 0;
});

function payloadRequest(
  payload: ReplyPayload,
  prefsName = "runtime-payload",
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
      ...payloadRequest(payload),
      cfg: createTtsConfig("tts-persisted-facts", { modelOverrides: { allowProvider: true } }),
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
    const result = await speak(
      {
        agents: { defaults: { voiceModel } },
        tts: { enabled: true },
      },
      { prefsPath: "/tmp/openclaw-speech-core-supported-voice-model-provider-test.json" },
    );

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

    const result = await speak(
      createTtsConfig("tts-alias-provider", {
        provider: "xiaomi",
        providers: { mimo: { apiKey: "fake" } },
      }),
      { disableFallback: true },
    );

    expect(result.success).toBe(true);
    expect(requireFirstSynthesisRequest("alias").providerConfig).toMatchObject({ apiKey: "fake" });
  });

  it("maps speakerVoice persona provider config to provider-compatible voice fields", async () => {
    const result = await speak(
      createTtsConfig("tts-speaker-persona", {
        persona: "narrator",
        personas: { narrator: { providers: { mock: { speakerVoice: "marin" } } } },
      }),
      { disableFallback: true },
    );

    expect(result).toMatchObject({ success: true, providerVoice: "marin" });
    expect(requireFirstSynthesisRequest("persona speaker").providerConfig).toMatchObject({
      speakerVoice: "marin",
      voice: "marin",
      voiceName: "marin",
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
      payloadRequest({ text: "Visible answer [[tts:text]]Hidden expressive answer[[/tts:text]]" }),
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
        expect([result.text, result.ttsSupplement]).toEqual([undefined, undefined]);
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

function modelConfig(
  voiceModel: { primary: string; fallbacks?: string[]; timeoutMs?: number },
  tts: TtsConfig = {},
): OpenClawConfig {
  return { agents: { defaults: { voiceModel } }, tts: { enabled: true, ...tts } };
}
function streamResult(release?: () => Promise<void>) {
  return {
    audioStream: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
    fileExtension: ".pcm",
    outputFormat: "pcm",
    voiceCompatible: false,
    ...(release ? { release } : {}),
  };
}

describe("TTS runtime voice model and streaming behavior", () => {
  it("caps oversized voice model TTS timeouts before synthesis", async () => {
    installSpeechProviders([createMockSpeechProvider("mock", { models: ["mock-tts"] })]);
    const result = await speak(
      modelConfig(
        { primary: "mock/mock-tts", timeoutMs: Number.MAX_SAFE_INTEGER },
        { provider: "mock" },
      ),
      { disableFallback: true },
    );
    expect(result.success).toBe(true);
    expect(requireFirstSynthesisRequest("capped timeout").timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it.each([
    ["voiceModel default", "openai", undefined, "gpt-4o-mini-tts"],
    ["explicit model alias", "openrouter", "explicit-model", "default-model"],
  ] as const)("uses %s ahead of provider defaults", async (_name, id, explicit, model) => {
    const selected = createMockSpeechProvider(id, {
      autoSelectOrder: 10,
      models: explicit ? [explicit, model] : [model],
      resolveConfig: ({ rawConfig }) => ({
        ...(explicit ? {} : { model: "provider-default-model", modelId: "provider-default-model" }),
        ...requireRecord(requireRecord(rawConfig.providers, "providers")[id], "provider config"),
      }),
    });
    installSpeechProviders(explicit ? [selected] : [createMockSpeechProvider(), selected]);
    const result = await speak(
      modelConfig(
        { primary: id + "/" + model, ...(explicit ? {} : { timeoutMs: 12_345 }) },
        explicit ? { provider: id, providers: { [id]: { modelId: explicit } } } : {},
      ),
      { disableFallback: true, prefsPath: "/tmp/openclaw-speech-model-" + id + ".json" },
    );
    expect(result.success).toBe(true);
    const request = requireFirstSynthesisRequest("model selection");
    const providerConfig = requireRecord(request.providerConfig, "provider config");
    expect(providerConfig).toMatchObject({ modelId: explicit ?? model });
    if (explicit) {
      expect(providerConfig.model).toBeUndefined();
    } else {
      expect(result).toMatchObject({ provider: id, providerModel: model });
      expect(providerConfig.model).toBe(model);
      expect(request.timeoutMs).toBe(12_345);
    }
  });

  it.each([false, true])(
    "tries voiceModel fallbacks before auto selection (same provider: %s)",
    async (same) => {
      const synthesize = vi.fn(async (request: SpeechSynthesisRequest) => {
        if (request.providerConfig.model === "bad-tts") {
          throw new Error("unavailable model");
        }
        return {
          audioBuffer: Buffer.from("voice"),
          fileExtension: ".ogg",
          outputFormat: "ogg",
          voiceCompatible: request.target === "voice-note",
        };
      });
      const primary = same ? "bad-tts" : "gpt-4o-mini-tts";
      const fallbackId = same ? "openai" : "elevenlabs";
      const fallbackModel = same ? "good-tts" : "eleven_multilingual_v2";
      const selected = createMockSpeechProvider("openai", {
        autoSelectOrder: 10,
        models: same ? [primary, fallbackModel] : [primary],
        ...(same ? { synthesize } : { isConfigured: () => false }),
      });
      installSpeechProviders(
        same
          ? [selected]
          : [
              createMockSpeechProvider(),
              selected,
              createMockSpeechProvider(fallbackId, {
                autoSelectOrder: 99,
                models: [fallbackModel],
              }),
            ],
      );
      const result = await speak(
        modelConfig({
          primary: "openai/" + primary,
          fallbacks: [fallbackId + "/" + fallbackModel],
        }),
        { prefsPath: "/tmp/openclaw-speech-model-fallback-" + same + ".json" },
      );
      expect(result).toMatchObject({
        success: true,
        provider: fallbackId,
        providerModel: fallbackModel,
      });
      if (same) {
        expect(result.attemptedProviders).toEqual(["openai", "openai"]);
        expect(synthesize.mock.calls.map(([request]) => request.providerConfig.model)).toEqual([
          "bad-tts",
          "good-tts",
        ]);
      } else {
        expect(result.fallbackFrom).toBe("openai");
      }
    },
  );

  it.each([false, true])(
    "falls back from a non-streaming provider or timeout (timeout: %s)",
    async (timeout) => {
      const release = vi.fn(async () => {});
      const fallback = vi.fn(async () => streamResult(timeout ? undefined : release));
      const primary = timeout ? "primary" : "buffered";
      const fallbackId = timeout ? "fallback" : "streaming";
      const timedOut = async () => {
        // This is the real transport error shape, not AbortError.
        const error = new Error("request timed out");
        error.name = "TimeoutError";
        throw error;
      };
      installSpeechProviders([
        createMockSpeechProvider(primary, {
          autoSelectOrder: 1,
          ...(timeout ? { streamSynthesize: timedOut } : {}),
        }),
        createMockSpeechProvider(fallbackId, { autoSelectOrder: 2, streamSynthesize: fallback }),
      ]);
      const result = await textToSpeechStream({
        text: "## Keep [streaming Markdown](https://example.com) raw!!!!!",
        cfg: { tts: { enabled: true, provider: primary } },
        prefsPath: "/tmp/openclaw-speech-stream-" + timeout + ".json",
      });
      expect(result).toMatchObject({ success: true, provider: fallbackId, fallbackFrom: primary });
      expect(requireAttempt(result.attempts, 0)).toMatchObject(
        timeout
          ? {
              provider: primary,
              outcome: "failed",
              reasonCode: "timeout",
              error: "primary: request timed out",
            }
          : {
              provider: primary,
              outcome: "skipped",
              reasonCode: "unsupported_for_streaming",
              personaBinding: "none",
              error: "buffered does not support streaming TTS",
            },
      );
      expect(requireAttempt(result.attempts, 1)).toMatchObject({
        provider: fallbackId,
        outcome: "success",
        reasonCode: "success",
      });
      if (timeout) {
        expect(fallback).toHaveBeenCalledWith(
          expect.objectContaining({ text: "Keep streaming Markdown raw!" }),
        );
      } else {
        expect(result).toMatchObject({
          attemptedProviders: ["buffered", "streaming"],
          outputFormat: "pcm",
          fileExtension: ".pcm",
          target: "audio-file",
        });
        expect(requireAttempt(result.attempts, 0)).not.toHaveProperty("latencyMs");
        expect(fallback).toHaveBeenCalledOnce();
      }
      await result.release?.();
      if (!timeout) {
        expect(release).toHaveBeenCalledOnce();
      }
    },
  );
});

function personaConfig(
  persona: NonNullable<TtsConfig["personas"]>[string],
  overrides: TtsConfig = {},
): OpenClawConfig {
  return {
    tts: {
      enabled: true,
      provider: "mock",
      persona: "alfred",
      personas: { alfred: persona },
      ...overrides,
    },
  };
}

describe("TTS runtime persona behavior", () => {
  it("passes directive overrides to telephony synthesis providers", async () => {
    const synthesizeTelephonyMock = vi.fn(async (_request: SpeechTelephonySynthesisRequest) => ({
      audioBuffer: Buffer.from("voice"),
      outputFormat: "pcm",
      sampleRate: 24_000,
    }));
    installSpeechProviders([
      createMockSpeechProvider("mock", {
        synthesizeTelephony: synthesizeTelephonyMock,
      }),
    ]);

    const text = "## Keep [telephony Markdown](https://example.com) raw!!!!!";
    const result = await textToSpeechTelephony({
      text,
      cfg: {
        tts: {
          enabled: true,
          provider: "mock",
          providers: { mock: { modelId: "telephony-model", voiceId: "default-voice" } },
        },
      },
      overrides: {
        providerOverrides: {
          mock: { speakerVoice: "directed-voice", speed: 1.5 },
        },
      },
    });

    expect(result).toMatchObject({
      success: true,
      providerModel: "telephony-model",
      providerVoice: "directed-voice",
    });
    expect(synthesizeTelephonyMock).toHaveBeenCalledOnce();
    const telephonyRequest = synthesizeTelephonyMock.mock.calls[0]?.[0];
    expect(telephonyRequest?.providerOverrides).toEqual({
      speakerVoice: "directed-voice",
      speed: 1.5,
    });
    expect(telephonyRequest?.text).toBe(text);
    expect(telephonyRequest).not.toHaveProperty("target");
  });

  it("selects persona preferred provider before config fallback", async () => {
    const cfg = personaConfig({ provider: "mock" }, { provider: "other" });
    const config = resolveTtsConfig(cfg);
    const prefsPath = "/tmp/openclaw-speech-core-persona-provider.json";

    expect(getTtsPersona(config, prefsPath)?.id).toBe("alfred");
    expect(await getTtsProviderAsync(config, prefsPath)).toBe("mock");
  });

  it("treats provider configuration errors as unconfigured", async () => {
    installSpeechProviders([
      createMockSpeechProvider("broken", {
        resolveConfig: () => {
          throw new Error("invalid provider URL");
        },
      }),
    ]);
    const prefsPath = "/tmp/openclaw-speech-core-invalid-provider.json";
    setTtsMachinePrefsPathResolver(() => prefsPath);
    const cfg: OpenClawConfig = { tts: { providers: { broken: {} } } };
    const config = resolveTtsConfig(cfg);

    expect(await isTtsProviderConfiguredAsync(config, "broken", cfg)).toBe(false);
    expect(await getTtsProviderAsync(config, prefsPath)).toBe("");
  });

  it("uses async availability for synthesis without invoking the legacy probe", async () => {
    const isConfigured = vi.fn(() => {
      throw new Error("sync availability must not run");
    });
    installSpeechProviders([
      createMockSpeechProvider("mock", {
        isConfigured,
        isConfiguredAsync: async () => true,
      }),
    ]);

    const result = await speak({ tts: { provider: "mock" } });

    expect(result.success).toBe(true);
    expect(synthesizeMock).toHaveBeenCalledOnce();
    expect(isConfigured).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "resolves persona secrets without credential fallback (available: %s)",
    async (available) => {
      await withOpenClawTestState({ label: "tts-persona-secrets" }, async (state) => {
        if (!available) {
          await import("./tts.js");
        }
        const ref = {
          source: "env",
          provider: "default",
          id: available ? "TEST_TTS_PERSONA_KEY" : "TEST_TTS_MISSING_PERSONA_KEY",
        } as const;
        const expectedKey = "persona-fixture-key";
        const persona = available ? "reader.uk" : "reader";
        const personas = {
          [persona]: {
            ...(available ? { provider: "mock" } : {}),
            providers: { mock: { ...(available ? { voice: "persona-voice" } : {}), apiKey: ref } },
          },
        };
        const tts: TtsConfig = {
          provider: "mock",
          persona,
          providers: {
            mock: available
              ? {
                  apiKey: { source: "env", provider: "default", id: "TEST_TTS_BASE_KEY" },
                  model: "base-model",
                }
              : { apiKey: "other-fixture-key" },
          },
        };
        if (available) {
          tts.auto = "off";
        } else {
          tts.personas = personas;
        }
        const cfg: OpenClawConfig = {
          plugins: { enabled: false },
          tts,
          ...(available ? { agents: { entries: { reader: { tts: { personas } } } } } : {}),
        };
        if (available) {
          installSpeechProviders([
            createMockSpeechProvider("mock", {
              isConfigured: ({ providerConfig }) => providerConfig.apiKey === expectedKey,
            }),
          ]);
        }
        const snapshot = await prepareSecretsRuntimeSnapshot({
          config: cfg,
          env: available
            ? {
                TEST_TTS_BASE_KEY: "base-fixture-key",
                TEST_TTS_PERSONA_KEY: expectedKey,
              }
            : {},
          agentDirs: [state.agentDir()],
          includeAuthStoreRefs: false,
          manifestRegistry: { plugins: [] },
          ...(available ? {} : { allowUnavailableSecretOwners: true }),
        });
        if (!available) {
          activateSecretsRuntimeSnapshot(snapshot);
        }
        const synthesis = speak(snapshot.config, {
          ...(available ? { agentId: "reader" } : {}),
          prefsPath: state.path("tts-prefs.json"),
          disableFallback: true,
        });
        if (!available) {
          await expect(synthesis).rejects.toMatchObject({
            code: "SECRET_SURFACE_UNAVAILABLE",
            ownerId: "tts",
          });
          expect(snapshot.config.tts?.personas?.reader?.providers?.mock?.apiKey).toEqual(ref);
          expect(synthesizeMock).not.toHaveBeenCalled();
          return;
        }
        expect(await synthesis).toMatchObject({ success: true, audioBuffer: Buffer.from("voice") });
        expect(requireFirstSynthesisRequest("resolved persona").providerConfig).toMatchObject({
          apiKey: expectedKey,
          model: "base-model",
          voice: "persona-voice",
        });
        expect(snapshot.sourceConfig).toEqual(cfg);
        expect(snapshot.warnings).toEqual([]);
        expect(
          discoverConfigSecretTargetsByIds(
            cfg,
            new Set(["agents.entries.*.tts.personas.*.providers.*.apiKey"]),
          ),
        ).toMatchObject([
          {
            providerId: "mock",
            path: 'agents.entries.reader.tts.personas["reader.uk"].providers.mock.apiKey',
          },
        ]);
      });
    },
  );

  it.each([
    { telephony: false, provider: "missing", reasonCode: "no_provider_registered", success: true },
    { telephony: true, provider: "mock", reasonCode: "unsupported_for_telephony", success: false },
  ])(
    "omits personaBinding when skipping $provider ($reasonCode)",
    async ({ telephony, provider, reasonCode, success }) => {
      const synthesize = telephony ? textToSpeechTelephony : synthesizeSpeech;
      const result = await synthesize({
        text: "Use the available fallback.",
        cfg: personaConfig({ providers: { [provider]: { voice: "persona-voice" } } }, { provider }),
      });
      expect(result.success).toBe(success);
      const attempt = requireAttempt(result.attempts, 0);
      expect(attempt).toMatchObject({
        provider,
        outcome: "skipped",
        reasonCode,
        persona: "alfred",
      });
      expect(attempt).not.toHaveProperty("personaBinding");
    },
  );

  it("uses provider defaults when fallback policy allows missing persona bindings", async () => {
    await speak(personaConfig({ fallbackPolicy: "provider-defaults" }));

    expect(prepareSynthesisMock).toHaveBeenCalledOnce();
    const prepareContext = prepareSynthesisMock.mock.lastCall?.[0];
    expect(prepareContext?.persona).toBeUndefined();
    expect(prepareContext?.personaProviderConfig).toBeUndefined();
  });

  it("skips unbound providers under fail policy while allowing bound fallbacks", async () => {
    installSpeechProviders([
      createMockSpeechProvider("mock", { autoSelectOrder: 1 }),
      createMockSpeechProvider("fallback", { autoSelectOrder: 2 }),
    ]);

    const result = await speak(
      personaConfig({
        fallbackPolicy: "fail",
        providers: { fallback: { voice: "fallback-voice" } },
      }),
    );

    expect(result).toMatchObject({ success: true, provider: "fallback", fallbackFrom: "mock" });
    expect(requireAttempt(result.attempts, 0)).toMatchObject({
      provider: "mock",
      outcome: "skipped",
      reasonCode: "not_configured",
      persona: "alfred",
      personaBinding: "missing",
      error: "mock: persona alfred has no provider binding",
    });
    expect(requireAttempt(result.attempts, 1)).toMatchObject({
      provider: "fallback",
      outcome: "success",
      persona: "alfred",
      personaBinding: "applied",
    });
  });
});

describe("TTS runtime per-agent config", () => {
  it("composes per-agent TTS overrides with active persona bindings", async () => {
    const cfg: OpenClawConfig = {
      ...personaConfig(
        {},
        {
          providers: { mock: { model: "base-model", voice: "base-voice" } },
          personas: {
            alfred: { provider: "mock", providers: { mock: { voice: "alfred-voice" } } },
            jarvis: { provider: "mock", providers: { mock: { style: "jarvis-style" } } },
          },
        },
      ),
      agents: {
        entries: {
          reader: {
            tts: {
              persona: "jarvis",
              providers: { mock: { voice: "agent-voice" } },
            },
          },
        },
      },
    };

    await withTtsPayload(
      {
        payload: { text: "This agent reply should use the composed persona config." },
        cfg,
        channel: "slack",
        kind: "final",
        agentId: "reader",
      },
      (result) => {
        expect(requireFirstSynthesisRequest("agent persona").providerConfig).toMatchObject({
          model: "base-model",
          voice: "agent-voice",
          style: "jarvis-style",
        });
        expect(result.mediaUrl).toMatch(/voice---[a-f0-9-]+\.ogg$/);
      },
    );
  });
});
