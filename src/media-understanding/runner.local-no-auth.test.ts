import { expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { CUSTOM_LOCAL_AUTH_MARKER } from "../agents/model-auth-markers.js";
import type { OpenClawConfig } from "../config/types.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runMediaFixture } from "./runner-case.test-support.js";
import { buildProviderRegistry } from "./runner.js";
import type { AudioTranscriptionRequest, MediaUnderstandingProvider } from "./types.js";

vi.mock("../plugins/capability-provider-runtime.js", async () => {
  const { createEmptyCapabilityProviderMockModule } = await import("./runner.test-mocks.js");
  return createEmptyCapabilityProviderMockModule();
});

const authControl = vi.hoisted(() => ({
  forceMissingProvider: false,
  store: { version: 1, profiles: {} } satisfies AuthProfileStore,
}));

vi.mock("../agents/model-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/model-auth.js")>();
  return {
    ...actual,
    resolveApiKeyForProviderCore: async (
      params: Parameters<typeof actual.resolveApiKeyForProviderCore>[0],
    ) => {
      if (authControl.forceMissingProvider) {
        throw new actual.ProviderAuthError(
          "missing-provider-auth",
          params.provider,
          `No API key found for provider "${params.provider}".`,
        );
      }
      return actual.resolveApiKeyForProviderCore({ ...params, store: authControl.store });
    },
  };
});

vi.mock("../plugins/providers.js", async (importOriginal) => ({
  ...(await importOriginal()),
  resolveOwningPluginIdsForProvider: () => [],
  resolveOwningPluginIdsForProviderRef: () => [],
}));

vi.mock("../plugins/provider-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/provider-runtime.js")>()),
  // This plugin-free suite must not load bundled plugins to find retired profiles.
  resolveProviderDeprecatedAuthProfileIds: () => [],
}));

const AUTH_ENV = {
  LOCAL_AUDIO_API_KEY: undefined,
  REMOTE_AUDIO_API_KEY: undefined,
  OPENCLAW_AGENT_DIR: undefined,
};
const remoteProvider: ModelProviderConfig = {
  api: "openai-completions",
  baseUrl: "https://example.invalid/v1",
  models: [],
};

type AudioCase = {
  remote?: boolean;
  profile?: string;
  resolveAuth?: MediaUnderstandingProvider["resolveAuth"];
  missing?: boolean;
};
type Expected = { apiKey: string; auth: AudioTranscriptionRequest["auth"] } | { reason: string };

const noAuth = () => ({ kind: "none" as const, source: "media plugin no-auth" });

async function checkAudioCase(params: AudioCase, expected: Expected) {
  authControl.forceMissingProvider = params.missing ?? true;
  authControl.store = { version: 1, profiles: {} };
  const provider = params.remote ? "remote-audio" : "local-audio";
  const model = params.remote ? "remote-whisper" : "whisper-local";
  const requests: AudioTranscriptionRequest[] = [];
  const cfg: OpenClawConfig = {
    ...(params.remote ? { models: { providers: { [provider]: remoteProvider } } } : {}),
    tools: {
      media: {
        models: [{ provider, model, capabilities: ["audio"], profile: params.profile }],
        audio: { enabled: true },
      },
    },
  };
  await withTestDir({ prefix: "openclaw-local-audio-auth-" }, async (agentDir) => {
    await withEnvAsync(AUTH_ENV, async () => {
      const result = await runMediaFixture("audio", "openclaw-audio-auth", {
        cfg,
        agentDir,
        providerRegistry: buildProviderRegistry({
          [provider]: {
            id: provider,
            capabilities: ["audio"],
            resolveAuth: params.resolveAuth,
            transcribeAudio: async (request) => {
              requests.push(request);
              return { text: request.apiKey, model: request.model };
            },
          },
        }),
      });
      if ("reason" in expected) {
        expect(result.decision.outcome).toBe("failed");
        expect(result.decision.attachments[0]?.attempts[0]?.reason).toContain(expected.reason);
        expect(requests).toEqual([]);
      } else {
        expect(result.decision.outcome).toBe("success");
        expect(requests.map(({ apiKey, auth }) => ({ apiKey, auth }))).toEqual([expected]);
      }
    });
  });
}

const hookAuth = { kind: "api-key", apiKey: "hook-key", source: "media auth hook" } as const;
// #74644: plugin no-auth remains available after generic auth misses.
it.each<[AudioCase, Expected]>([
  [{ resolveAuth: noAuth }, { apiKey: CUSTOM_LOCAL_AUTH_MARKER, auth: noAuth() }],
  [{ resolveAuth: () => hookAuth }, { apiKey: "hook-key", auth: hookAuth }],
  [
    { remote: true, resolveAuth: () => null },
    { reason: 'No API key found for provider "remote-audio"' },
  ],
  [
    { missing: false, profile: "missing-profile", resolveAuth: noAuth },
    { reason: 'No credentials found for profile "missing-profile"' },
  ],
])("runCapability media auth case %# (%j): %j", checkAudioCase);
