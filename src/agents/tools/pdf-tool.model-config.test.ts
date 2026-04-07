import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolvePdfModelConfigForTool } from "./pdf-tool.model-config.js";

const ANTHROPIC_PDF_MODEL = "anthropic/claude-opus-4-6";

async function withTempAgentDir<T>(run: (agentDir: string) => Promise<T>): Promise<T> {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pdf-"));
  try {
    return await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

function resetAuthEnv() {
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("GOOGLE_API_KEY", "");
  vi.stubEnv("MINIMAX_API_KEY", "");
  vi.stubEnv("ZAI_API_KEY", "");
  vi.stubEnv("Z_AI_API_KEY", "");
  vi.stubEnv("COPILOT_GITHUB_TOKEN", "");
  vi.stubEnv("GH_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "");
}

function withDefaultModel(primary: string): OpenClawConfig {
  return {
    agents: { defaults: { model: { primary } } },
  } as OpenClawConfig;
}

describe("resolvePdfModelConfigForTool", () => {
  beforeEach(() => {
    resetAuthEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null without any auth", async () => {
    await withTempAgentDir(async (agentDir) => {
      const cfg = withDefaultModel("openai/gpt-5.4");
      expect(resolvePdfModelConfigForTool({ cfg, agentDir })).toBeNull();
    });
  });

  it("prefers explicit pdfModel config", async () => {
    await withTempAgentDir(async (agentDir) => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.4" },
            pdfModel: { primary: ANTHROPIC_PDF_MODEL },
          },
        },
      } as OpenClawConfig;
      expect(resolvePdfModelConfigForTool({ cfg, agentDir })).toEqual({
        primary: ANTHROPIC_PDF_MODEL,
      });
    });
  });

  it("falls back to imageModel config when no pdfModel set", async () => {
    await withTempAgentDir(async (agentDir) => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.4" },
            imageModel: { primary: "openai/gpt-5.4-mini" },
          },
        },
      } as OpenClawConfig;
      expect(resolvePdfModelConfigForTool({ cfg, agentDir })).toEqual({
        primary: "openai/gpt-5.4-mini",
      });
    });
  });

  it("prefers anthropic when available for native PDF support", async () => {
    await withTempAgentDir(async (agentDir) => {
      vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test");
      vi.stubEnv("OPENAI_API_KEY", "openai-test");
      const cfg = withDefaultModel("openai/gpt-5.4");
      expect(resolvePdfModelConfigForTool({ cfg, agentDir })?.primary).toBe(ANTHROPIC_PDF_MODEL);
    });
  });

  it("uses anthropic primary when provider is anthropic", async () => {
    await withTempAgentDir(async (agentDir) => {
      vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test");
      const cfg = withDefaultModel(ANTHROPIC_PDF_MODEL);
      expect(resolvePdfModelConfigForTool({ cfg, agentDir })?.primary).toBe(ANTHROPIC_PDF_MODEL);
    });
  });
});
