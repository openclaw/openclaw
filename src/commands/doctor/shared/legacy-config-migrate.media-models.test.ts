import { describe, expect, it } from "vitest";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import type { OpenClawConfigWithLegacyRoster } from "../../../config/legacy.roster.js";
import { migrateLegacyConfigForTest } from "./legacy-config-migrate.apply.test-support.js";

describe("legacy model compat migrate", () => {
  it("upgrades the retired xAI quality image slug without pinning active aliases", () => {
    const raw: OpenClawConfigWithLegacyRoster = {
      agents: {
        defaults: {
          imageGenerationModel: {
            primary: "xai/grok-imagine-image-pro",
            fallbacks: ["xai/grok-imagine-image"],
          },
          model: {
            primary: "xai/grok-4.20-beta-latest-reasoning",
          },
          models: {
            "xai/grok-imagine-image-pro": { alias: "quality" },
          },
        },
      },
    };

    expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).toContain("agents");
    const res = migrateLegacyConfigForTest(raw);

    expect(res.config?.agents?.defaults?.mediaModels?.image).toEqual({
      primary: "xai/grok-imagine-image-quality",
      fallbacks: ["xai/grok-imagine-image"],
    });
    expect(res.config?.agents?.defaults?.model).toEqual({
      primary: "xai/grok-4.20-beta-latest-reasoning",
    });
    expect(res.config?.agents?.defaults?.models).toEqual({
      "xai/grok-imagine-image-quality": { alias: "quality" },
    });
  });

  it("upgrades retired model refs", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          workspace: "/tmp/claude-3-sonnet",
          imageModel: "anthropic/claude-haiku-4-5",
          imageGenerationModel: {
            primary: "github-copilot/claude-sonnet-4",
            fallbacks: ["github-copilot/grok-code-fast-1"],
          },
          musicGenerationModel: "vercel-ai-gateway/anthropic/claude-opus-4-5",
          pdfModel: "anthropic/claude-3-5-sonnet",
          videoGenerationModel: "anthropic/claude-opus-4-10",
          model: {
            primary: "anthropic/claude-opus-4-5@anthropic:work",
            fallbacks: [
              "anthropic/claude-sonnet-4-20250514",
              "github-copilot/claude-sonnet-4",
              "github-copilot/grok-code-fast-1@github:work",
              "venice/claude-opus-4-5",
              "vercel-ai-gateway/anthropic/claude-opus-4-5",
              "anthropic/claude-opus-5-0",
              "anthropic/claude-sonnet-4-7",
              "anthropic/claude-opus-4-10",
              "kilocode/anthropic/claude-sonnet-4",
              "amazon-bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0",
              "openai/gpt-5.5",
              "openai/gpt-4o",
              "openai/gpt-4.1-mini",
              "openai/gpt-5.1-codex-mini",
              "openai/gpt-5.2-codex",
              "openai-codex/gpt-5.2",
              "openai-codex/gpt-5.1-codex-mini",
              "github-copilot/gpt-4.1",
              "github-copilot/gpt-5.2",
              "github-copilot/gpt-5.2-codex",
              "groq/llama3-70b-8192",
              "groq/gemma2-9b-it",
              "groq/moonshotai/kimi-k2-instruct-0905",
              "xai/grok-code-fast-1",
              "xai/grok-4-fast-reasoning",
              "openai/gpt-4o-transcribe",
              "openai/gpt-4o-mini-tts",
              "openai/constructor",
            ],
          },
          models: {
            "anthropic/claude-haiku-4-5": { alias: "haiku" },
            "anthropic/claude-sonnet-4-6": { alias: "current-sonnet" },
            "github-copilot/claude-opus-4.5": { alias: "copilot-opus" },
            "openai/gpt-5.2-pro": { alias: "old-pro" },
            "github-copilot/gpt-5-mini": { alias: "old-mini" },
          },
        },
      } satisfies OpenClawConfigWithLegacyRoster["agents"],
      plugins: {
        entries: {
          "lossless-claw": {
            config: {
              summaryModel: "anthropic/claude-3-5-sonnet",
              dataPath: "/tmp/claude-opus-4-5",
            },
            subagent: {
              allowedModels: ["anthropic/claude-haiku-4-5", "*"],
            },
          },
        },
      },
      channels: {
        modelByChannel: {
          telegram: {
            "*": "anthropic/claude-opus-4-5",
          },
        },
      },
    });

    expect(res.config?.agents?.defaults?.imageModel).toBe("anthropic/claude-haiku-4-5");
    expect(res.config?.agents?.defaults?.mediaModels?.image).toEqual({
      primary: "github-copilot/claude-sonnet-4.6",
      fallbacks: ["github-copilot/gpt-5.4-mini"],
    });
    expect(res.config?.agents?.defaults?.mediaModels?.music).toBe(
      "vercel-ai-gateway/anthropic/claude-opus-4-6",
    );
    expect(res.config?.agents?.defaults?.pdfModel).toBe("anthropic/claude-sonnet-4-6");
    expect(res.config?.agents?.defaults?.mediaModels?.video).toBe("anthropic/claude-opus-4-10");
    expect(res.config?.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-opus-4-7@anthropic:work",
      fallbacks: [
        "anthropic/claude-sonnet-4-6",
        "github-copilot/claude-sonnet-4.6",
        "github-copilot/gpt-5.4-mini@github:work",
        "venice/claude-opus-4-6",
        "vercel-ai-gateway/anthropic/claude-opus-4-6",
        "anthropic/claude-opus-5-0",
        "anthropic/claude-sonnet-4-7",
        "anthropic/claude-opus-4-10",
        "kilocode/anthropic/claude-sonnet-4",
        "amazon-bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0",
        "openai/gpt-5.5",
        "openai/gpt-5.5",
        "openai/gpt-5.4-mini",
        "openai/gpt-5.4-mini",
        "openai/gpt-5.3-codex",
        "openai-codex/gpt-5.5",
        "openai-codex/gpt-5.4-mini",
        "github-copilot/gpt-5.5",
        "github-copilot/gpt-5.5",
        "github-copilot/gpt-5.3-codex",
        "groq/llama-3.3-70b-versatile",
        "groq/llama-3.1-8b-instant",
        "groq/openai/gpt-oss-120b",
        "xai/grok-build-0.1",
        "xai/grok-4.3",
        "openai/gpt-4o-transcribe",
        "openai/gpt-4o-mini-tts",
        "openai/constructor",
      ],
    });
    expect(res.config?.agents?.defaults?.workspace).toBe("/tmp/claude-3-sonnet");
    expect(res.config?.agents?.defaults?.models).toEqual({
      "anthropic/claude-haiku-4-5": { alias: "haiku" },
      "anthropic/claude-sonnet-4-6": { alias: "current-sonnet" },
      "github-copilot/claude-opus-4.7": { alias: "copilot-opus" },
      "openai/gpt-5.5-pro": { alias: "old-pro" },
      "github-copilot/gpt-5.4-mini": { alias: "old-mini" },
    });
    expect(res.config).toHaveProperty("plugins.entries.lossless-claw.config", {
      summaryModel: "anthropic/claude-sonnet-4-6",
      dataPath: "/tmp/claude-opus-4-5",
    });
    expect(res.config).toHaveProperty("plugins.entries.lossless-claw.subagent.allowedModels", [
      "anthropic/claude-haiku-4-5",
      "*",
    ]);
    expect(res.config?.channels?.modelByChannel?.telegram?.["*"]).toBe("anthropic/claude-opus-4-7");
  });
});
