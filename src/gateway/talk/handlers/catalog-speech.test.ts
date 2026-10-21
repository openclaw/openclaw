import { setImmediate as nextTurn } from "node:timers/promises";
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

const capabilities = {
  transports: ["gateway-relay" as const],
  inputAudioFormats: [],
  outputAudioFormats: [],
};
const unexpectedSession = () => {
  throw new Error("catalog must not create a session");
};
const providerFields = <T>(isConfiguredAsync: T, id = "sample") => ({
  id,
  label: id,
  isConfigured: () => false,
  isConfiguredAsync,
});
const speechProvider = (
  isConfiguredAsync: NonNullable<SpeechProviderPlugin["isConfiguredAsync"]>,
  id = "sample",
): SpeechProviderPlugin => ({
  ...providerFields(isConfiguredAsync, id),
  synthesize: unexpectedSession,
});
const realtimeProvider = (
  isConfiguredAsync: NonNullable<RealtimeVoiceProviderPlugin["isConfiguredAsync"]>,
  id = "sample",
): RealtimeVoiceProviderPlugin => ({
  ...providerFields(isConfiguredAsync, id),
  capabilities,
  createBridge: () => {
    throw new Error("catalog must not create a session");
  },
});

function expectCatalog(result: unknown, kind: string, catalog: Record<string, unknown>) {
  expect(result).toMatchObject({ ok: true, response: { [kind]: catalog } });
}

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

function readCatalog(cfg: OpenClawConfig, params: Record<string, unknown> = {}) {
  return callGatewayHandler(talkHandlers, "talk.catalog", params, {
    context: { getRuntimeConfig: () => cfg },
  });
}

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
        ...speechProvider(
          async ({ providerConfig }) => available && providerConfig.resolvedKey === expectedKey,
        ),
        resolveConfig: ({ rawConfig }) => ({
          resolvedKey: asOptionalRecord(asOptionalRecord(rawConfig.providers)?.sample)?.apiKey,
        }),
      },
    ];

    const read = () => readCatalog(cfg);
    expectCatalog(await read(), "speech", { providers: [{ id: "sample", configured: true }] });
    available = false;
    const later = await read();
    expectCatalog(later, "speech", { providers: [{ id: "sample", configured: false }] });
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
      ...realtimeProvider(readAvailability),
      resolveConfigAsync: async ({ rawConfig }) => ({
        ...rawConfig,
        model: rawConfig.model ?? (await readDefault()),
      }),
      capabilities: { ...capabilities, supportsToolCalls: false },
    },
  ];
  const read = (params: Record<string, unknown> = {}) => readCatalog(cfg, params);

  expectCatalog(await read(), "realtime", {
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
  });
  expect(readDefault).toHaveBeenCalledTimes(1);
  expect(readAvailability).toHaveBeenCalledTimes(1);

  // The launch override must not replace the discovery default in the picker.
  expectCatalog(await read({ model: "explicit-model" }), "realtime", {
    providers: [{ configured: true, defaultModel: "discovery-model" }],
  });
  expect(readDefault).toHaveBeenCalledTimes(2);
  expect(readAvailability).toHaveBeenCalledTimes(2);

  available = false;
  expectCatalog(await read(), "realtime", { ready: false, providers: [{ configured: false }] });
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
      ...providerFields(readAvailability),
      label: "Sample transcription",
      resolveConfig,
      createSession: unexpectedSession,
    },
  ];
  const read = () => readCatalog(cfg);
  expectCatalog(await read(), "transcription", {
    ready: true,
    activeProvider: "sample",
    providers: [{ id: "sample", configured: true }],
  });
  expect(readAvailability).toHaveBeenCalledTimes(1);
  expect(resolveConfig).toHaveBeenCalledTimes(1);
  available = false;
  expectCatalog(await read(), "transcription", {
    ready: false,
    providers: [{ configured: false }],
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
  registry.realtime = [realtimeProvider(readAvailability, "slow")];
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
  expectCatalog(await read(), "realtime", {
    ready: true,
    providers: [{ id: "slow", configured: true }],
  });
  expect(readAvailability).toHaveBeenCalledTimes(1);
});

it("serves the last catalog during one slow refresh and publishes its late success", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const cfg: OpenClawConfig = { plugins: { enabled: false } };
  const context = { getRuntimeConfig: () => cfg, logGateway: { warn: vi.fn() } };
  const pending = createDeferred<boolean>();
  const readiness = vi.fn(async () => true);
  registry.providers = [speechProvider(readiness, "slow")];
  const read = () =>
    callGatewayHandlerOnce(talkHandlers, "talk.catalog", {}, { context: context as never });
  expect(await read()).toMatchObject({
    ok: false,
    error: { retryable: true, details: { reason: "talk-catalog-warming" } },
  });
  await vi.advanceTimersByTimeAsync(0);
  const first = await read();
  expectCatalog(first, "speech", { providers: [{ configured: true }] });
  readiness.mockReturnValue(pending.promise);
  await vi.advanceTimersByTimeAsync(30_000);
  const burst = await Promise.all(Array.from({ length: 20 }, read));
  expect(burst.every((result) => result.response === first.response)).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(readiness).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(6_000);
  expect((await read()).response).toBe(first.response);
  expect(readiness).toHaveBeenCalledTimes(2);
  expect(context.logGateway.warn).toHaveBeenCalledTimes(1);
  expect(context.logGateway.warn).toHaveBeenCalledWith(expect.stringContaining("waiting=speech"));
  pending.resolve(false);
  await vi.advanceTimersByTimeAsync(0);
  expectCatalog(await read(), "speech", { providers: [{ configured: false }] });
  expect(readiness).toHaveBeenCalledTimes(2);
});

it("isolates catalog owners and model overrides while a cold provider is pending", async () => {
  const cfg: OpenClawConfig = { plugins: { enabled: false } };
  const context = { getRuntimeConfig: () => cfg };
  const pending = createDeferred<boolean>();
  const readiness = vi.fn(() => pending.promise);
  registry.providers = [speechProvider(readiness, "slow")];
  const read = () => callGatewayHandlerOnce(talkHandlers, "talk.catalog", {}, { context });
  const results = await Promise.all(Array.from({ length: 20 }, read));
  expect(results.every((result) => result.ok === false)).toBe(true);
  await nextTurn();
  expect(readiness).toHaveBeenCalledTimes(1);
  pending.resolve(true);
  await nextTurn();
  expect((await read()).ok).toBe(true);
  const otherOwner = { getRuntimeConfig: () => cfg };
  readiness.mockResolvedValue(true);
  expect(
    await callGatewayHandlerOnce(talkHandlers, "talk.catalog", {}, { context: otherOwner }),
  ).toMatchObject({ ok: false });
  expect(
    await callGatewayHandlerOnce(talkHandlers, "talk.catalog", { model: "other" }, { context }),
  ).toMatchObject({ ok: false });
  await nextTurn();
});

it("retries failed cold discovery before the client's warming window expires", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const cfg: OpenClawConfig = { plugins: { enabled: false } };
  const context = { getRuntimeConfig: () => cfg };
  const readiness = vi.fn(async () => true);
  registry.listSpeechProviders.mockImplementationOnce(() => {
    throw new Error("temporary discovery failure");
  });
  registry.providers = [speechProvider(readiness, "sample")];
  const read = () => callGatewayHandlerOnce(talkHandlers, "talk.catalog", {}, { context });
  expect((await read()).ok).toBe(false);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(1_000);
  expect((await read()).ok).toBe(false);
  await vi.advanceTimersByTimeAsync(0);
  expectCatalog(await read(), "speech", { providers: [{ configured: true }] });
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
      const provider = providerFields(id === "broken" ? brokenReadiness : async () => true, id);
      if (kind === "speech") {
        registry.providers.push({
          ...provider,
          synthesize: unexpectedSession,
        });
      } else if (kind === "realtime") {
        registry.realtime.push(realtimeProvider(provider.isConfiguredAsync, id));
      } else {
        registry.transcription.push({
          ...provider,
          createSession: unexpectedSession,
        });
      }
    }
    const read = () => callGatewayHandlerOnce(talkHandlers, "talk.catalog", {}, { context });
    expect((await read()).ok).toBe(false);
    await nextTurn();
    expectCatalog(await read(), kind, {
      providers: [
        { id: "healthy", configured: true },
        { id: "broken", configured: false },
      ],
    });
    brokenReadiness.mockResolvedValue(true);
    cfg = { ...cfg };
    await read();
    await nextTurn();
    const recovered = await read();
    expectCatalog(recovered, kind, { providers: [{ configured: true }, { configured: true }] });
    brokenReadiness.mockRejectedValue(new Error("provider unavailable again"));
    cfg = { ...cfg };
    expect((await read()).response).toBe(recovered.response);
    await nextTurn();
    expect((await read()).response).toBe(recovered.response);
    brokenReadiness.mockResolvedValue(false);
    cfg = { ...cfg };
    expect((await read()).response).toBe(recovered.response);
    await nextTurn();
    expectCatalog(await read(), kind, {
      providers: [
        { id: "healthy", configured: true },
        { id: "broken", configured: false },
      ],
    });
  },
);
