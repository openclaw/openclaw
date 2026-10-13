import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.js";
import type { SpeechProviderPlugin } from "../../../plugins/types.js";
import { callGatewayHandler } from "../../server-methods/skills.test-helpers.js";
import { talkHandlers } from "./index.js";

const registry = vi.hoisted(() => ({
  providers: [] as SpeechProviderPlugin[],
}));

vi.mock("../../../tts/provider-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../tts/provider-registry.js")>()),
  listSpeechProviders: () => registry.providers,
  canonicalizeSpeechProviderId: (id: string | undefined) => id,
  getSpeechProvider: () => undefined,
}));

beforeEach(() => {
  registry.providers = [];
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
