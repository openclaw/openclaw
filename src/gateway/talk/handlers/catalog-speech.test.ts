import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../../config/types.js";
import type {
  RealtimeTranscriptionProviderPlugin,
  RealtimeVoiceProviderPlugin,
  SpeechProviderPlugin,
} from "../../../plugins/types.js";
import { callGatewayHandler as callGatewayHandlerOnce } from "../../server-methods/skills.test-helpers.js";
import { talkHandlers } from "./index.js";

const registry = vi.hoisted(() => ({
  providers: [] as SpeechProviderPlugin[],
  listSpeechProviders: vi.fn<() => SpeechProviderPlugin[]>(),
  realtime: [] as RealtimeVoiceProviderPlugin[],
  transcription: [] as RealtimeTranscriptionProviderPlugin[],
}));

vi.mock("../../../tts/provider-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../tts/provider-registry.js")>()),
  listSpeechProviders: registry.listSpeechProviders,
  canonicalizeSpeechProviderId: (id: string | undefined) => id,
  getSpeechProvider: (id: string | undefined) =>
    registry.providers.find((provider) => provider.id === id),
}));

vi.mock("../../../talk/provider-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../talk/provider-registry.js")>()),
  listRealtimeVoiceProviders: () => registry.realtime,
  canonicalizeRealtimeVoiceProviderId: (id: string | undefined) => id,
  getRealtimeVoiceProvider: (id: string | undefined) =>
    registry.realtime.find((provider) => provider.id === id),
}));

vi.mock("../../../realtime-transcription/provider-registry.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../realtime-transcription/provider-registry.js")
  >()),
  listRealtimeTranscriptionProviders: () => registry.transcription,
  canonicalizeRealtimeTranscriptionProviderId: (id: string | undefined) => id,
  getRealtimeTranscriptionProvider: (id: string | undefined) =>
    registry.transcription.find((provider) => provider.id === id),
}));

// Existing catalog contract cases consume the documented warming retry before inspecting rows.
async function callGatewayHandler(...args: Parameters<typeof callGatewayHandlerOnce>) {
  const ownsTimers = !vi.isFakeTimers();
  if (ownsTimers) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  }
  try {
    const result = await callGatewayHandlerOnce(...args);
    if (
      asOptionalRecord(asOptionalRecord(result.error)?.details)?.reason !== "talk-catalog-warming"
    ) {
      return result;
    }
    await vi.advanceTimersByTimeAsync(0);
    return await callGatewayHandlerOnce(...args);
  } finally {
    if (ownsTimers) {
      vi.useRealTimers();
    }
  }
}

afterEach(() => vi.useRealTimers());

beforeEach(() => {
  registry.providers = [];
  registry.listSpeechProviders.mockReset().mockImplementation(() => registry.providers);
  registry.realtime = [];
  registry.transcription = [];
});

it.each([false, true])(
  "checks speech readiness with the prepared Talk override=%s",
  async (talkOverride) => {
    const expectedKey = talkOverride ? "synthetic-talk-key" : "synthetic-speech-key";
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      tts: { providers: { sample: { apiKey: "synthetic-speech-key" } } },
      ...(talkOverride
        ? { talk: { provider: "sample", providers: { sample: { apiKey: "synthetic-talk-key" } } } }
        : {}),
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
          available && providerConfig.resolvedKey === expectedKey,
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
    expect(JSON.stringify(later.response)).not.toContain("synthetic-talk-key");
  },
);

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

it("reuses selected transcription readiness and refreshes it on the next catalog request", async () => {
  const cfg: OpenClawConfig = {
    plugins: {
      enabled: false,
      entries: { "voice-call": { config: { streaming: { provider: "sample" } } } },
    },
  };
  let available = true;
  const readAvailability = vi.fn(async () => available);
  const resolveConfig = vi.fn(({ rawConfig }) => rawConfig);
  registry.transcription = [
    {
      id: "sample",
      label: "Sample transcription",
      resolveConfig,
      isConfigured: () => false,
      isConfiguredAsync: readAvailability,
      createSession: () => {
        throw new Error("catalog must not create a session");
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
    response: {
      transcription: {
        ready: true,
        activeProvider: "sample",
        providers: [{ id: "sample", configured: true }],
      },
    },
  });
  expect(readAvailability).toHaveBeenCalledTimes(1);
  expect(resolveConfig).toHaveBeenCalledTimes(1);
  available = false;
  expect(await read()).toMatchObject({
    ok: true,
    response: { transcription: { ready: false, providers: [{ configured: false }] } },
  });
});

it("publishes the first catalog after a slow cold refresh without starting concurrent work", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const cfg: OpenClawConfig = {
    plugins: { enabled: false },
    talk: { realtime: { provider: "slow" } },
  };
  const context = { getRuntimeConfig: () => cfg };
  const readiness = createDeferred<boolean>();
  const readAvailability = vi.fn(() => readiness.promise);
  registry.realtime = [
    {
      id: "slow",
      label: "Slow realtime",
      isConfigured: () => false,
      isConfiguredAsync: readAvailability,
      capabilities: {
        transports: ["gateway-relay"],
        inputAudioFormats: [],
        outputAudioFormats: [],
      },
      createBridge: () => {
        throw new Error("catalog must not create a session");
      },
    },
  ];
  const read = () => callGatewayHandlerOnce(talkHandlers, "talk.catalog", {}, { context });
  expect(await read()).toMatchObject({
    ok: false,
    error: { retryable: true, details: { reason: "talk-catalog-warming" } },
  });
  await vi.advanceTimersByTimeAsync(6_000);
  const waiting = await Promise.all(Array.from({ length: 20 }, read));
  expect(waiting.every((result) => !result.ok)).toBe(true);
  expect(readAvailability).toHaveBeenCalledTimes(1);
  readiness.resolve(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(await read()).toMatchObject({
    ok: true,
    response: { realtime: { ready: true, providers: [{ id: "slow", configured: true }] } },
  });
  expect(readAvailability).toHaveBeenCalledTimes(1);
});

it("serves the last catalog during one slow refresh and retains it after the deadline", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const cfg: OpenClawConfig = { plugins: { enabled: false } };
  const context = { getRuntimeConfig: () => cfg, logGateway: { warn: vi.fn() } };
  let finish: ((value: boolean) => void) | undefined;
  const readiness = vi.fn(async () => true);
  registry.providers = [
    {
      id: "slow",
      label: "Slow fixture",
      isConfigured: () => false,
      isConfiguredAsync: readiness,
      synthesize: async () => {
        throw new Error("must not synthesize");
      },
    },
  ];
  const read = () =>
    callGatewayHandlerOnce(talkHandlers, "talk.catalog", {}, { context: context as never });
  expect(await read()).toMatchObject({
    ok: false,
    error: { retryable: true, details: { reason: "talk-catalog-warming" } },
  });
  await vi.advanceTimersByTimeAsync(0);
  const first = await read();
  expect(first).toMatchObject({
    ok: true,
    response: { speech: { providers: [{ configured: true }] } },
  });
  readiness.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  await vi.advanceTimersByTimeAsync(30_000);
  const burst = await Promise.all(Array.from({ length: 20 }, read));
  expect(burst.every((result) => result.response === first.response)).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(readiness).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(35_000);
  expect((await read()).response).toBe(first.response);
  expect(readiness).toHaveBeenCalledTimes(2);
  expect(context.logGateway.warn).toHaveBeenCalledTimes(1);
  expect(context.logGateway.warn).toHaveBeenCalledWith(expect.stringContaining("waiting=speech"));
  finish?.(false);
  await vi.advanceTimersByTimeAsync(0);
  readiness.mockResolvedValue(false);
  expect((await read()).response).toBe(first.response);
  await vi.advanceTimersByTimeAsync(0);
  expect(await read()).toMatchObject({
    ok: true,
    response: { speech: { providers: [{ configured: false }] } },
  });
});

it("isolates catalog owners and model overrides while a cold provider is pending", async () => {
  const cfg: OpenClawConfig = { plugins: { enabled: false } };
  const context = { getRuntimeConfig: () => cfg };
  let finish: (() => void) | undefined;
  const readiness = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = () => resolve(true);
      }),
  );
  registry.providers = [
    {
      id: "slow",
      label: "Slow",
      isConfigured: () => false,
      isConfiguredAsync: readiness,
      synthesize: async () => {
        throw new Error("must not synthesize");
      },
    },
  ];
  const read = () => callGatewayHandlerOnce(talkHandlers, "talk.catalog", {}, { context });
  const results = await Promise.all(Array.from({ length: 20 }, read));
  expect(results.every((result) => result.ok === false)).toBe(true);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect(readiness).toHaveBeenCalledTimes(1);
  finish?.();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect((await read()).ok).toBe(true);
  const otherOwner = { getRuntimeConfig: () => cfg };
  readiness.mockResolvedValue(true);
  expect(
    await callGatewayHandlerOnce(talkHandlers, "talk.catalog", {}, { context: otherOwner }),
  ).toMatchObject({ ok: false });
  expect(
    await callGatewayHandlerOnce(talkHandlers, "talk.catalog", { model: "other" }, { context }),
  ).toMatchObject({ ok: false });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
});

it("retains successful readiness after a provider failure and refreshes on config publication", async () => {
  let cfg: OpenClawConfig = { plugins: { enabled: false } };
  const context = { getRuntimeConfig: () => cfg };
  const readiness = vi.fn(async () => true);
  registry.providers = [
    {
      id: "sample",
      label: "Sample",
      isConfigured: () => false,
      isConfiguredAsync: readiness,
      synthesize: async () => {
        throw new Error("must not synthesize");
      },
    },
  ];
  const read = () => callGatewayHandlerOnce(talkHandlers, "talk.catalog", {}, { context });
  await read();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  const first = await read();
  expect(first.ok).toBe(true);
  readiness.mockRejectedValue(new Error("synthetic provider unavailable"));
  cfg = { ...cfg };
  expect((await read()).response).toBe(first.response);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect((await read()).response).toBe(first.response);
  readiness.mockResolvedValue(false);
  cfg = { ...cfg };
  expect((await read()).response).toBe(first.response);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect(await read()).toMatchObject({
    ok: true,
    response: { speech: { providers: [{ configured: false }] } },
  });
});

it("retries failed cold discovery before the client's warming window expires", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const cfg: OpenClawConfig = { plugins: { enabled: false } };
  const context = { getRuntimeConfig: () => cfg };
  const readiness = vi.fn(async () => true);
  registry.listSpeechProviders.mockImplementationOnce(() => {
    throw new Error("temporary discovery failure");
  });
  registry.providers = [
    {
      id: "sample",
      label: "Sample",
      isConfigured: () => false,
      isConfiguredAsync: readiness,
      synthesize: async () => {
        throw new Error("must not synthesize");
      },
    },
  ];
  const read = () => callGatewayHandlerOnce(talkHandlers, "talk.catalog", {}, { context });
  expect((await read()).ok).toBe(false);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(1_000);
  expect((await read()).ok).toBe(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(await read()).toMatchObject({
    ok: true,
    response: { speech: { providers: [{ configured: true }] } },
  });
  expect(readiness).toHaveBeenCalledTimes(1);
});

it.each(["speech", "realtime", "transcription"] as const)(
  "isolates cold %s readiness failures and retains the recovered warm snapshot",
  async (kind) => {
    let cfg: OpenClawConfig = {
      plugins: {
        enabled: false,
        entries: { "voice-call": { config: { streaming: { provider: "healthy" } } } },
      },
      talk: { realtime: { provider: "healthy" } },
    };
    const context = { getRuntimeConfig: () => cfg };
    const brokenReadiness = vi.fn(async (): Promise<boolean> => {
      throw new Error("synthetic provider unavailable");
    });
    for (const id of ["healthy", "broken"]) {
      const provider = {
        id,
        label: id,
        isConfigured: () => false,
        isConfiguredAsync: id === "broken" ? brokenReadiness : async () => true,
      };
      if (kind === "speech") {
        registry.providers.push({
          ...provider,
          synthesize: async () => {
            throw new Error("catalog must not synthesize");
          },
        });
      } else if (kind === "realtime") {
        registry.realtime.push({
          ...provider,
          capabilities: {
            transports: ["gateway-relay"],
            inputAudioFormats: [],
            outputAudioFormats: [],
          },
          createBridge: () => {
            throw new Error("catalog must not create a session");
          },
        });
      } else {
        registry.transcription.push({
          ...provider,
          createSession: () => {
            throw new Error("catalog must not create a session");
          },
        });
      }
    }
    const read = () => callGatewayHandlerOnce(talkHandlers, "talk.catalog", {}, { context });
    expect((await read()).ok).toBe(false);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(await read()).toMatchObject({
      ok: true,
      response: {
        [kind]: {
          providers: [
            { id: "healthy", configured: true },
            { id: "broken", configured: false },
          ],
        },
      },
    });
    brokenReadiness.mockResolvedValue(true);
    cfg = { ...cfg };
    await read();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const recovered = await read();
    expect(recovered).toMatchObject({
      ok: true,
      response: { [kind]: { providers: [{ configured: true }, { configured: true }] } },
    });
    brokenReadiness.mockRejectedValue(new Error("provider unavailable again"));
    cfg = { ...cfg };
    expect((await read()).response).toBe(recovered.response);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect((await read()).response).toBe(recovered.response);
  },
);
