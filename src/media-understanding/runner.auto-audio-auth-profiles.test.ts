import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { withEnvAsync } from "../test-utils/env.js";
import { buildProviderRegistry, runCapability } from "./runner.js";
import { withAudioFixture } from "./runner.test-utils.js";

/**
 * Create a temporary agent directory containing an auth-profiles.json file
 * with the given profiles. Returns the agent directory path (not the file
 * path) so it can be passed directly to `runCapability` as `agentDir` or to
 * the `OPENCLAW_AGENT_DIR` env var.
 */
function createAuthProfileDir(profiles: Record<string, unknown>): string {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-audio-"));
  const store = { version: 1, profiles };
  fs.writeFileSync(path.join(agentDir, "auth-profiles.json"), JSON.stringify(store, null, 2));
  return agentDir;
}

function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("runCapability audio auto-detect via auth-profiles", () => {
  it("detects openai from auth-profiles when no env vars are set", async () => {
    const agentDir = createAuthProfileDir({
      "openai:default": {
        type: "api_key",
        provider: "openai",
        key: "sk-test-openai-key",
      },
    });

    try {
      let runResult: Awaited<ReturnType<typeof runCapability>> | undefined;
      await withAudioFixture("openclaw-auth-profile-openai", async ({ ctx, media, cache }) => {
        const providerRegistry = buildProviderRegistry({
          openai: {
            id: "openai",
            capabilities: ["audio"],
            transcribeAudio: async (req) => ({
              text: "auth-profile-openai",
              model: req.model ?? "unknown",
            }),
          },
        });
        const cfg = {} as OpenClawConfig;

        await withEnvAsync(
          {
            OPENAI_API_KEY: undefined,
            GROQ_API_KEY: undefined,
            DEEPGRAM_API_KEY: undefined,
            GEMINI_API_KEY: undefined,
            MISTRAL_API_KEY: undefined,
            OPENCLAW_AGENT_DIR: agentDir,
            PI_CODING_AGENT_DIR: agentDir,
          },
          async () => {
            runResult = await runCapability({
              capability: "audio",
              cfg,
              ctx,
              attachments: cache,
              media,
              providerRegistry,
              agentDir,
            });
          },
        );
      });

      expect(runResult).toBeDefined();
      expect(runResult!.decision.outcome).toBe("success");
      expect(runResult!.outputs[0]?.provider).toBe("openai");
      expect(runResult!.outputs[0]?.model).toBe("gpt-4o-mini-transcribe");
      expect(runResult!.outputs[0]?.text).toBe("auth-profile-openai");
    } finally {
      cleanupDir(agentDir);
    }
  });

  it("detects groq from auth-profiles with a token credential", async () => {
    const agentDir = createAuthProfileDir({
      "groq:default": {
        type: "token",
        provider: "groq",
        token: "gsk_test-groq-token",
      },
    });

    try {
      let runResult: Awaited<ReturnType<typeof runCapability>> | undefined;
      await withAudioFixture("openclaw-auth-profile-groq", async ({ ctx, media, cache }) => {
        const providerRegistry = buildProviderRegistry({
          groq: {
            id: "groq",
            capabilities: ["audio"],
            transcribeAudio: async (req) => ({
              text: "auth-profile-groq",
              model: req.model ?? "unknown",
            }),
          },
        });
        const cfg = {} as OpenClawConfig;

        await withEnvAsync(
          {
            OPENAI_API_KEY: undefined,
            GROQ_API_KEY: undefined,
            DEEPGRAM_API_KEY: undefined,
            GEMINI_API_KEY: undefined,
            MISTRAL_API_KEY: undefined,
            OPENCLAW_AGENT_DIR: agentDir,
            PI_CODING_AGENT_DIR: agentDir,
          },
          async () => {
            runResult = await runCapability({
              capability: "audio",
              cfg,
              ctx,
              attachments: cache,
              media,
              providerRegistry,
              agentDir,
            });
          },
        );
      });

      expect(runResult).toBeDefined();
      expect(runResult!.decision.outcome).toBe("success");
      expect(runResult!.outputs[0]?.provider).toBe("groq");
      expect(runResult!.outputs[0]?.model).toBe("whisper-large-v3-turbo");
      expect(runResult!.outputs[0]?.text).toBe("auth-profile-groq");
    } finally {
      cleanupDir(agentDir);
    }
  });

  it("detects mistral from auth-profiles with an oauth credential", async () => {
    const agentDir = createAuthProfileDir({
      "mistral:default": {
        type: "oauth",
        provider: "mistral",
        access: "mistral-oauth-access-token",
        refresh: "mistral-oauth-refresh-token",
        expires: Date.now() + 3600_000,
      },
    });

    try {
      let runResult: Awaited<ReturnType<typeof runCapability>> | undefined;
      await withAudioFixture("openclaw-auth-profile-mistral", async ({ ctx, media, cache }) => {
        const providerRegistry = buildProviderRegistry({
          mistral: {
            id: "mistral",
            capabilities: ["audio"],
            transcribeAudio: async (req) => ({
              text: "auth-profile-mistral",
              model: req.model ?? "unknown",
            }),
          },
        });
        const cfg = {} as OpenClawConfig;

        await withEnvAsync(
          {
            OPENAI_API_KEY: undefined,
            GROQ_API_KEY: undefined,
            DEEPGRAM_API_KEY: undefined,
            GEMINI_API_KEY: undefined,
            MISTRAL_API_KEY: undefined,
            OPENCLAW_AGENT_DIR: agentDir,
            PI_CODING_AGENT_DIR: agentDir,
          },
          async () => {
            runResult = await runCapability({
              capability: "audio",
              cfg,
              ctx,
              attachments: cache,
              media,
              providerRegistry,
              agentDir,
            });
          },
        );
      });

      expect(runResult).toBeDefined();
      expect(runResult!.decision.outcome).toBe("success");
      expect(runResult!.outputs[0]?.provider).toBe("mistral");
      expect(runResult!.outputs[0]?.model).toBe("voxtral-mini-latest");
      expect(runResult!.outputs[0]?.text).toBe("auth-profile-mistral");
    } finally {
      cleanupDir(agentDir);
    }
  });

  it("skips expired token credentials in auth-profiles", async () => {
    const agentDir = createAuthProfileDir({
      "openai:default": {
        type: "token",
        provider: "openai",
        token: "expired-token",
        expires: Date.now() - 1000, // expired 1 second ago
      },
    });

    try {
      let runResult: Awaited<ReturnType<typeof runCapability>> | undefined;
      await withAudioFixture("openclaw-auth-profile-expired", async ({ ctx, media, cache }) => {
        const providerRegistry = buildProviderRegistry({
          openai: {
            id: "openai",
            capabilities: ["audio"],
            transcribeAudio: async () => ({
              text: "should not reach",
              model: "gpt-4o-mini-transcribe",
            }),
          },
        });
        const cfg = {} as OpenClawConfig;

        await withEnvAsync(
          {
            OPENAI_API_KEY: undefined,
            GROQ_API_KEY: undefined,
            DEEPGRAM_API_KEY: undefined,
            GEMINI_API_KEY: undefined,
            MISTRAL_API_KEY: undefined,
            OPENCLAW_AGENT_DIR: agentDir,
            PI_CODING_AGENT_DIR: agentDir,
          },
          async () => {
            runResult = await runCapability({
              capability: "audio",
              cfg,
              ctx,
              attachments: cache,
              media,
              providerRegistry,
              agentDir,
            });
          },
        );
      });

      expect(runResult).toBeDefined();
      expect(runResult!.decision.outcome).toBe("skipped");
      expect(runResult!.outputs).toHaveLength(0);
    } finally {
      cleanupDir(agentDir);
    }
  });

  it("skips expired oauth access-only credentials in auth-profiles", async () => {
    const agentDir = createAuthProfileDir({
      "mistral:default": {
        type: "oauth",
        provider: "mistral",
        access: "expired-access-only-token",
        expires: Date.now() - 1000,
      },
    });

    try {
      let runResult: Awaited<ReturnType<typeof runCapability>> | undefined;
      await withAudioFixture(
        "openclaw-auth-profile-expired-oauth",
        async ({ ctx, media, cache }) => {
          const providerRegistry = buildProviderRegistry({
            mistral: {
              id: "mistral",
              capabilities: ["audio"],
              transcribeAudio: async () => ({
                text: "should not reach",
                model: "voxtral-mini-latest",
              }),
            },
          });
          const cfg = {} as OpenClawConfig;

          await withEnvAsync(
            {
              OPENAI_API_KEY: undefined,
              GROQ_API_KEY: undefined,
              DEEPGRAM_API_KEY: undefined,
              GEMINI_API_KEY: undefined,
              MISTRAL_API_KEY: undefined,
              OPENCLAW_AGENT_DIR: agentDir,
              PI_CODING_AGENT_DIR: agentDir,
            },
            async () => {
              runResult = await runCapability({
                capability: "audio",
                cfg,
                ctx,
                attachments: cache,
                media,
                providerRegistry,
                agentDir,
              });
            },
          );
        },
      );

      expect(runResult).toBeDefined();
      expect(runResult!.decision.outcome).toBe("skipped");
      expect(runResult!.outputs).toHaveLength(0);
    } finally {
      cleanupDir(agentDir);
    }
  });

  it("skips providers without transcription support", async () => {
    // anthropic has describeImage but NOT transcribeAudio
    const agentDir = createAuthProfileDir({
      "anthropic:default": {
        type: "api_key",
        provider: "anthropic",
        key: "sk-ant-test-key",
      },
    });

    try {
      let runResult: Awaited<ReturnType<typeof runCapability>> | undefined;
      await withAudioFixture(
        "openclaw-auth-profile-no-transcription",
        async ({ ctx, media, cache }) => {
          // Register anthropic with only image support, no audio.
          const providerRegistry = buildProviderRegistry({
            anthropic: {
              id: "anthropic",
              capabilities: ["image"],
            },
          });
          const cfg = {} as OpenClawConfig;

          await withEnvAsync(
            {
              OPENAI_API_KEY: undefined,
              GROQ_API_KEY: undefined,
              DEEPGRAM_API_KEY: undefined,
              GEMINI_API_KEY: undefined,
              MISTRAL_API_KEY: undefined,
              ANTHROPIC_API_KEY: undefined,
              ANTHROPIC_OAUTH_TOKEN: undefined,
              OPENCLAW_AGENT_DIR: agentDir,
              PI_CODING_AGENT_DIR: agentDir,
            },
            async () => {
              runResult = await runCapability({
                capability: "audio",
                cfg,
                ctx,
                attachments: cache,
                media,
                providerRegistry,
                agentDir,
              });
            },
          );
        },
      );

      expect(runResult).toBeDefined();
      expect(runResult!.decision.outcome).toBe("skipped");
      expect(runResult!.outputs).toHaveLength(0);
    } finally {
      cleanupDir(agentDir);
    }
  });
});
