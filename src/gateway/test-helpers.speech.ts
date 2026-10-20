import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { withTestTimeout } from "../../test/helpers/promise.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import {
  TALK_TEST_PROVIDER_ID,
  TALK_TEST_PROVIDER_LABEL,
} from "../test-utils/talk-test-provider.js";

type StubSpeechProviderOptions = Pick<SpeechProviderPlugin, "id" | "label"> & {
  aliases?: string[];
  voices?: string[];
  resolveTalkOverrides?: SpeechProviderPlugin["resolveTalkOverrides"];
  synthesize?: SpeechProviderPlugin["synthesize"];
};

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function override(key: string, value: string | number | undefined) {
  return value === undefined ? {} : { [key]: value };
}

const mp3Format = { outputFormat: "mp3", fileExtension: ".mp3" };

const createStubSpeechProvider = (params: StubSpeechProviderOptions): SpeechProviderPlugin => ({
  id: params.id,
  label: params.label,
  aliases: params.aliases,
  voices: params.voices,
  resolveTalkOverrides: params.resolveTalkOverrides,
  isConfigured: () => true,
  synthesize:
    params.synthesize ??
    (async () => ({
      audioBuffer: Buffer.from(`${params.id}-audio`, "utf8"),
      ...mp3Format,
      voiceCompatible: true,
    })),
  listVoices: async () => (params.voices ?? []).map((id) => ({ id, name: id })),
});

export function createDefaultGatewayTestSpeechProviders() {
  const providers: StubSpeechProviderOptions[] = [
    {
      id: "openai",
      label: "OpenAI",
      voices: ["alloy", "nova"],
      resolveTalkOverrides: ({ params }) => ({
        ...override("voice", normalizeOptionalString(params.voiceId)),
        ...override("model", normalizeOptionalString(params.modelId)),
        ...override("speed", asNumber(params.speed)),
      }),
      synthesize: async (req) => {
        const config = req.providerConfig as Record<string, unknown>;
        const overrides = (req.providerOverrides ?? {}) as Record<string, unknown>;
        const body = JSON.stringify({
          input: req.text,
          model:
            normalizeOptionalString(overrides.model) ??
            normalizeOptionalString(config.modelId) ??
            "gpt-4o-mini-tts",
          voice:
            normalizeOptionalString(overrides.voice) ??
            normalizeOptionalString(config.voiceId) ??
            "alloy",
          ...override("speed", asNumber(overrides.speed)),
        });
        const response = await withTestTimeout(
          globalThis.fetch("https://api.openai.com/v1/audio/speech", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          }),
          5_000,
          "openai stub fetch timed out",
        );
        const audioBuffer = Buffer.from(
          await withTestTimeout(response.arrayBuffer(), 5_000, "openai stub read timed out"),
        );
        return { audioBuffer, ...mp3Format, voiceCompatible: false };
      },
    },
    {
      id: TALK_TEST_PROVIDER_ID,
      label: TALK_TEST_PROVIDER_LABEL,
      voices: ["stub-default-voice", "stub-alt-voice"],
      resolveTalkOverrides: ({ params }) => ({
        ...override("voiceId", normalizeOptionalString(params.voiceId)),
        ...override("modelId", normalizeOptionalString(params.modelId)),
        ...override("outputFormat", normalizeOptionalString(params.outputFormat)),
        ...override("latencyTier", asNumber(params.latencyTier)),
      }),
    },
  ];
  return providers.map((provider) => ({
    pluginId: provider.id,
    source: "test" as const,
    provider: createStubSpeechProvider(provider),
  }));
}
