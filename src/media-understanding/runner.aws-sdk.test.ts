// aws-sdk auth-mode runner tests cover the audio and video describe paths for
// providers (e.g. amazon-bedrock) whose credentials resolve through the AWS SDK
// chain at call time rather than a static API key. The resolved auth carries no
// key, so the runner must execute keyless instead of throwing missing-api-key.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CUSTOM_LOCAL_AUTH_MARKER } from "../agents/model-auth-markers.js";
import type { OpenClawConfig } from "../config/types.js";
import { withEnvAsync } from "../test-utils/env.js";
import { buildProviderRegistry, runCapability } from "./runner.js";
import { withAudioFixture, withVideoFixture } from "./runner.test-utils.js";
import type {
  AudioTranscriptionRequest,
  MediaUnderstandingProvider,
  VideoDescriptionRequest,
} from "./types.js";

vi.mock("../plugins/capability-provider-runtime.js", async () => {
  const { createEmptyCapabilityProviderMockModule } = await import("./runner.test-mocks.js");
  return createEmptyCapabilityProviderMockModule();
});

vi.mock("../plugins/providers.js", async (importOriginal) => ({
  ...(await importOriginal()),
  resolveOwningPluginIdsForProvider: () => [],
}));

// Clear AWS credentials so the resolved auth stays keyless and the test does not
// depend on the host's SDK credential chain.
const AUTH_ENV = {
  AWS_BEARER_TOKEN_BEDROCK: undefined,
  AWS_ACCESS_KEY_ID: undefined,
  AWS_SECRET_ACCESS_KEY: undefined,
  AWS_PROFILE: undefined,
  OPENCLAW_AGENT_DIR: undefined,
} satisfies Record<string, string | undefined>;

const BEDROCK_PROVIDER = "amazon-bedrock";
const BEDROCK_MODEL = "us.anthropic.claude-sonnet-4-6-v1";

function awsSdkProviderConfig(): Record<string, unknown> {
  return {
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    api: "bedrock-converse-stream",
    models: [],
    auth: "aws-sdk",
  };
}

function createAudioProvider(
  id: string,
  transcribeAudio: (req: AudioTranscriptionRequest) => Promise<{ text: string; model?: string }>,
): MediaUnderstandingProvider {
  return { id, capabilities: ["audio"], transcribeAudio };
}

function createVideoProvider(
  id: string,
  describeVideo: (req: VideoDescriptionRequest) => Promise<{ text: string; model?: string }>,
): MediaUnderstandingProvider {
  return { id, capabilities: ["video"], describeVideo };
}

async function withIsolatedAgentDir<T>(run: (agentDir: string) => Promise<T>): Promise<T> {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-aws-sdk-media-"));
  try {
    return await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

function createAudioCfg(): OpenClawConfig {
  return {
    models: { providers: { [BEDROCK_PROVIDER]: awsSdkProviderConfig() } },
    tools: {
      media: {
        audio: {
          enabled: true,
          models: [{ type: "provider", provider: BEDROCK_PROVIDER, model: BEDROCK_MODEL }],
        },
      },
    },
  } as unknown as OpenClawConfig;
}

function createVideoCfg(): OpenClawConfig {
  return {
    models: { providers: { [BEDROCK_PROVIDER]: awsSdkProviderConfig() } },
    tools: {
      media: {
        video: {
          enabled: true,
          models: [{ type: "provider", provider: BEDROCK_PROVIDER, model: BEDROCK_MODEL }],
        },
      },
    },
  } as unknown as OpenClawConfig;
}

describe("runCapability aws-sdk auth mode", () => {
  it("transcribes audio keyless when amazon-bedrock resolves aws-sdk auth", async () => {
    await withIsolatedAgentDir(async (agentDir) => {
      await withEnvAsync(AUTH_ENV, async () => {
        await withAudioFixture("openclaw-aws-sdk-audio", async ({ ctx, media, cache }) => {
          const transcribeAudio = vi.fn(async (req: AudioTranscriptionRequest) => ({
            text: `ok:${req.apiKey}`,
            model: req.model,
          }));

          const result = await runCapability({
            capability: "audio",
            cfg: createAudioCfg(),
            ctx,
            attachments: cache,
            media,
            agentDir,
            providerRegistry: buildProviderRegistry({
              [BEDROCK_PROVIDER]: createAudioProvider(BEDROCK_PROVIDER, transcribeAudio),
            }),
          });

          expect(result.decision.outcome).toBe("success");
          expect(result.outputs[0]?.text).toBe(`ok:${CUSTOM_LOCAL_AUTH_MARKER}`);
          expect(transcribeAudio).toHaveBeenCalledTimes(1);
          expect(transcribeAudio.mock.calls[0]?.[0].apiKey).toBe(CUSTOM_LOCAL_AUTH_MARKER);
        });
      });
    });
  });

  it("describes video keyless when amazon-bedrock resolves aws-sdk auth", async () => {
    await withIsolatedAgentDir(async (agentDir) => {
      await withEnvAsync(AUTH_ENV, async () => {
        await withVideoFixture("openclaw-aws-sdk-video", async ({ ctx, media, cache }) => {
          const describeVideo = vi.fn(async (req: VideoDescriptionRequest) => ({
            text: `ok:${req.apiKey}`,
            model: req.model,
          }));

          const result = await runCapability({
            capability: "video",
            cfg: createVideoCfg(),
            ctx,
            attachments: cache,
            media,
            agentDir,
            providerRegistry: buildProviderRegistry({
              [BEDROCK_PROVIDER]: createVideoProvider(BEDROCK_PROVIDER, describeVideo),
            }),
          });

          expect(result.decision.outcome).toBe("success");
          expect(result.outputs[0]?.text).toBe(`ok:${CUSTOM_LOCAL_AUTH_MARKER}`);
          expect(describeVideo).toHaveBeenCalledTimes(1);
          expect(describeVideo.mock.calls[0]?.[0].apiKey).toBe(CUSTOM_LOCAL_AUTH_MARKER);
        });
      });
    });
  });
});
