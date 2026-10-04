import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { CUSTOM_LOCAL_AUTH_MARKER } from "../agents/model-auth-markers.js";
import type { OpenClawConfig } from "../config/types.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { MediaUnderstandingModelConfig } from "../config/types.tools.js";
import { withEnvAsync } from "../test-utils/env.js";
import { buildProviderRegistry, runCapability } from "./runner.js";
import { withAudioFixture } from "./runner.test-utils.js";
import type { AudioTranscriptionRequest, MediaUnderstandingProvider } from "./types.js";

vi.mock("../plugins/capability-provider-runtime.js", async () => {
  const { createEmptyCapabilityProviderMockModule } = await import("./runner.test-mocks.js");
  return createEmptyCapabilityProviderMockModule();
});

const modelAuthTestControl = vi.hoisted(() => ({
  forceMissingProvider: false,
  store: undefined as AuthProfileStore | undefined,
}));

vi.mock("../agents/model-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/model-auth.js")>();
  return {
    ...actual,
    resolveApiKeyForProviderCore: async (
      ...args: Parameters<typeof actual.resolveApiKeyForProviderCore>
    ) => {
      if (modelAuthTestControl.forceMissingProvider) {
        throw new actual.ProviderAuthError(
          "missing-provider-auth",
          args[0].provider,
          `No API key found for provider "${args[0].provider}".`,
        );
      }
      const [params] = args;
      return await actual.resolveApiKeyForProviderCore({
        ...params,
        store: modelAuthTestControl.store ?? params.store,
      });
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
} satisfies Record<string, string | undefined>;

beforeEach(() => {
  modelAuthTestControl.forceMissingProvider = false;
  modelAuthTestControl.store = undefined;
});

type AudioResult = Awaited<ReturnType<typeof runCapability>>;

type AudioCase = {
  provider?: string;
  model?: string;
  providerConfig?: ModelProviderConfig;
  entry?: Partial<MediaUnderstandingModelConfig>;
  resolveAuth?: MediaUnderstandingProvider["resolveAuth"];
  env?: Record<string, string | undefined>;
};

const noAuth = () => ({ kind: "none" as const, source: "media plugin no-auth" });

async function withAudioCase(
  params: AudioCase,
  check: (result: AudioResult, requests: AudioTranscriptionRequest[]) => void,
) {
  const provider = params.provider ?? "local-audio";
  const model = params.model ?? "whisper-local";
  const requests: AudioTranscriptionRequest[] = [];
  const cfg: OpenClawConfig = {
    ...(params.providerConfig
      ? { models: { providers: { [provider]: params.providerConfig } } }
      : {}),
    tools: {
      media: {
        models: [{ type: "provider", provider, model, capabilities: ["audio"], ...params.entry }],
        audio: { enabled: true },
      },
    },
  };
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-local-audio-auth-"));
  try {
    await withEnvAsync(params.env ?? AUTH_ENV, async () => {
      await withAudioFixture("openclaw-audio-auth", async ({ ctx, media, cache }) => {
        const result = await runCapability({
          capability: "audio",
          cfg,
          ctx,
          attachments: cache,
          media,
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
        check(result, requests);
      });
    });
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

function expectAuthenticated(
  result: AudioResult,
  requests: AudioTranscriptionRequest[],
  apiKey: string,
) {
  expect(result.decision.outcome).toBe("success");
  expect(result.outputs[0]?.text).toBe(apiKey);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.apiKey).toBe(apiKey);
}

function expectRejected(
  result: AudioResult,
  requests: AudioTranscriptionRequest[],
  reason: string,
) {
  expect(result.decision.outcome).toBe("failed");
  expect(result.decision.attachments[0]?.attempts[0]?.reason).toContain(reason);
  expect(requests).toHaveLength(0);
}

describe("runCapability media auth", () => {
  it("regression #74644: uses explicit plugin no-auth after generic auth misses", async () => {
    modelAuthTestControl.forceMissingProvider = true;
    await withAudioCase({ resolveAuth: noAuth }, (result, requests) => {
      expectAuthenticated(result, requests, CUSTOM_LOCAL_AUTH_MARKER);
      expect(requests[0]?.auth).toEqual(noAuth());
    });
  });

  it("prefers an OpenAI API key over the default OAuth profile and plugin no-auth", async () => {
    modelAuthTestControl.store = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "oauth",
          provider: "openai",
          access: "oauth-chat-token",
          refresh: "oauth-refresh-token",
          // Stay outside the refresh window to exercise API-key selection.
          expires: Date.now() + 10 * 60_000,
        },
      },
    };
    await withAudioCase(
      {
        provider: "openai",
        model: "whisper-1",
        resolveAuth: noAuth,
        env: { ...AUTH_ENV, OPENAI_API_KEY: "env-openai-audio-key" },
      },
      (result, requests) => {
        expectAuthenticated(result, requests, "env-openai-audio-key");
      },
    );
  });

  it("prefers literal configured provider apiKey over the media no-auth hook", async () => {
    await withAudioCase(
      {
        providerConfig: { apiKey: "real-key", baseUrl: "http://127.0.0.1:43111/v1", models: [] },
        resolveAuth: noAuth,
      },
      (result, requests) => {
        expectAuthenticated(result, requests, "real-key");
      },
    );
  });

  it("allows a media auth hook to provide an API key after normal auth misses", async () => {
    modelAuthTestControl.forceMissingProvider = true;
    const auth = { kind: "api-key" as const, apiKey: "hook-key", source: "media auth hook" };
    await withAudioCase({ resolveAuth: () => auth }, (result, requests) => {
      expectAuthenticated(result, requests, "hook-key");
      expect(requests[0]?.auth).toEqual(auth);
    });
  });

  it("rejects a remote provider when generic auth is missing and its hook returns null", async () => {
    modelAuthTestControl.forceMissingProvider = true;
    await withAudioCase(
      {
        provider: "remote-audio",
        model: "remote-whisper",
        resolveAuth: () => null,
        providerConfig: {
          api: "openai-completions",
          baseUrl: "https://example.invalid/v1",
          models: [],
        },
      },
      (result, requests) => {
        expectRejected(result, requests, 'No API key found for provider "remote-audio"');
      },
    );
  });

  it("does not let plugin no-auth override an explicit missing profile", async () => {
    await withAudioCase(
      { entry: { profile: "missing-profile" }, resolveAuth: noAuth },
      (result, requests) => {
        expectRejected(result, requests, 'No credentials found for profile "missing-profile"');
      },
    );
  });
});
