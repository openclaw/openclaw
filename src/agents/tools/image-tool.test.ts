import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClawdbotConfig } from "../../config/config.js";
import {
  createImageTool,
  resolveImageModelConfigForTool,
} from "./image-tool.js";

async function writeAuthProfiles(agentDir: string, profiles: unknown) {
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "auth-profiles.json"),
    `${JSON.stringify(profiles, null, 2)}\n`,
    "utf8",
  );
}

describe("image tool implicit imageModel config", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
    vi.stubEnv("MINIMAX_API_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stays disabled without auth when no pairing is possible", async () => {
    const agentDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-image-"),
    );
    const cfg: ClawdbotConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-5.2" } } },
    };
    expect(resolveImageModelConfigForTool({ cfg, agentDir })).toBeNull();
    expect(createImageTool({ config: cfg, agentDir })).toBeNull();
  });

  it("pairs minimax primary with MiniMax-VL-01 (and fallbacks) when auth exists", async () => {
    const agentDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-image-"),
    );
    vi.stubEnv("MINIMAX_API_KEY", "minimax-test");
    vi.stubEnv("OPENAI_API_KEY", "openai-test");
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test");
    const cfg: ClawdbotConfig = {
      agents: { defaults: { model: { primary: "minimax/MiniMax-M2.1" } } },
    };
    expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual({
      primary: "minimax/MiniMax-VL-01",
      fallbacks: ["openai/gpt-5-mini", "anthropic/claude-opus-4-5"],
    });
    expect(createImageTool({ config: cfg, agentDir })).not.toBeNull();
  });

  it("pairs a custom provider when it declares an image-capable model", async () => {
    const agentDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-image-"),
    );
    await writeAuthProfiles(agentDir, {
      version: 1,
      profiles: {
        "acme:default": { type: "api_key", provider: "acme", key: "sk-test" },
      },
    });
    const cfg: ClawdbotConfig = {
      agents: { defaults: { model: { primary: "acme/text-1" } } },
      models: {
        providers: {
          acme: {
            models: [
              { id: "text-1", input: ["text"] },
              { id: "vision-1", input: ["text", "image"] },
            ],
          },
        },
      },
    };
    expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual({
      primary: "acme/vision-1",
    });
    expect(createImageTool({ config: cfg, agentDir })).not.toBeNull();
  });

  it("prefers explicit agents.defaults.imageModel", async () => {
    const agentDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-image-"),
    );
    const cfg: ClawdbotConfig = {
      agents: {
        defaults: {
          model: { primary: "minimax/MiniMax-M2.1" },
          imageModel: { primary: "openai/gpt-5-mini" },
        },
      },
    };
    expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual({
      primary: "openai/gpt-5-mini",
    });
  });
});
