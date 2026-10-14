import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.js";
import type { RealtimeVoiceProviderPlugin, SpeechProviderPlugin } from "../../../plugins/types.js";
import { callGatewayHandler } from "../../server-methods/skills.test-helpers.js";
import { talkHandlers } from "./index.js";

const registry = vi.hoisted(() => ({
  providers: [] as SpeechProviderPlugin[],
  realtime: [] as RealtimeVoiceProviderPlugin[],
}));

vi.mock("../../../tts/provider-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../tts/provider-registry.js")>()),
  listSpeechProviders: () => registry.providers,
  canonicalizeSpeechProviderId: (id: string | undefined) => id,
  getSpeechProvider: () => undefined,
}));

vi.mock("../../../talk/provider-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../talk/provider-registry.js")>()),
  listRealtimeVoiceProviders: () => registry.realtime,
  canonicalizeRealtimeVoiceProviderId: (id: string | undefined) => id,
  getRealtimeVoiceProvider: (id: string | undefined) =>
    registry.realtime.find((provider) => provider.id === id),
}));

beforeEach(() => {
  registry.providers = [];
  registry.realtime = [];
});

it("checks the listed speech provider with its resolved config and async availability", async () => {
  const cfg: OpenClawConfig = {
    plugins: { enabled: false },
    tts: { providers: { sample: { apiKey: "synthetic-speech-key" } } },
  };
  let available = true;
  registry.providers = [
    {
      id: "sample",
      label: "Sample speech",
      resolveConfig: ({ rawConfig }) => ({
        resolvedKey: asOptionalRecord(asOptionalRecord(rawConfig.providers)?.sample)?.apiKey,
      }),
      isConfigured: () => false,
      isConfiguredAsync: async ({ providerConfig }) =>
        available && providerConfig.resolvedKey === "synthetic-speech-key",
      synthesize: async () => {
        throw new Error("catalog must not synthesize");
      },
    },
  ];

  const read = () =>
    callGatewayHandler(
      talkHandlers,
      "talk.catalog",
      {},
      {
        context: { getRuntimeConfig: () => cfg },
      },
    );
  expect(await read()).toMatchObject({
    ok: true,
    response: { speech: { providers: [{ id: "sample", configured: true }] } },
  });
  available = false;
  const later = await read();
  expect(later).toMatchObject({
    ok: true,
    response: { speech: { providers: [{ id: "sample", configured: false }] } },
  });
  expect(JSON.stringify(later.response)).not.toContain("synthetic-speech-key");
});

it("prepares the selected realtime catalog once per request and refreshes availability", async () => {
  const cfg: OpenClawConfig = {
    plugins: { enabled: false },
    talk: { realtime: { provider: "sample" } },
  };
  let available = true;
  const readDefault = vi.fn(async () => "discovery-model");
  const readAvailability = vi.fn(async () => available);
  registry.realtime = [
    {
      id: "sample",
      label: "Sample realtime",
      resolveConfigAsync: async ({ rawConfig }) => ({
        ...rawConfig,
        model: rawConfig.model ?? (await readDefault()),
      }),
      isConfigured: () => false,
      isConfiguredAsync: readAvailability,
      capabilities: {
        transports: ["gateway-relay"],
        inputAudioFormats: [],
        outputAudioFormats: [],
        supportsToolCalls: false,
      },
      createBridge: () => {
        throw new Error("catalog must not create a session");
      },
    },
  ];
  const read = (params: Record<string, unknown> = {}) =>
    callGatewayHandler(talkHandlers, "talk.catalog", params, {
      context: { getRuntimeConfig: () => cfg },
    });

  expect(await read()).toMatchObject({
    ok: true,
    response: {
      realtime: {
        ready: true,
        activeProvider: "sample",
        providers: [
          {
            id: "sample",
            configured: true,
            defaultModel: "discovery-model",
            brains: ["none"],
            transports: ["gateway-relay"],
          },
        ],
      },
    },
  });
  expect(readDefault).toHaveBeenCalledTimes(1);
  expect(readAvailability).toHaveBeenCalledTimes(1);

  // The launch override must not replace the discovery default in the picker.
  expect(await read({ model: "explicit-model" })).toMatchObject({
    ok: true,
    response: {
      realtime: { providers: [{ configured: true, defaultModel: "discovery-model" }] },
    },
  });
  expect(readDefault).toHaveBeenCalledTimes(2);
  expect(readAvailability).toHaveBeenCalledTimes(2);

  available = false;
  expect(await read()).toMatchObject({
    ok: true,
    response: { realtime: { ready: false, providers: [{ configured: false }] } },
  });
});
