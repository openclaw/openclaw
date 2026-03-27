import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCliSpeechProvider } from "../../extensions/tts-local-cli/speech-provider.ts";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { synthesizeSpeech, resolveTtsConfig, getResolvedSpeechProviderConfig } from "./tts.js";

const MLX_AUDIO_COMMAND =
  "python3 -m mlx_audio.tts.generate --model mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16 --voice serena --lang_code zh --audio_format wav";

const AUDIO_OUTPUT_DIR = "/tmp/openclaw-cli-tts-e2e-output";

const liveEnabled = process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = liveEnabled ? describe : describe.skip;

// Helper to build config with multi-agent setup
function buildMultiAgentConfig(): OpenClawConfig {
  return {
    messages: {
      tts: {
        provider: "cli",
        providers: {
          cli: {
            command: MLX_AUDIO_COMMAND,
            args: [
              "--output_path",
              "{{OutputDir}}",
              "--file_prefix",
              "{{OutputBase}}",
              "--text",
              "{{Text}}",
            ],
            outputFormat: "wav",
            timeoutMs: 120000,
            // Per-agent overrides
            agents: {
              // Agent "alice" uses the same model but different voice
              alice: {
                command:
                  "python3 -m mlx_audio.tts.generate --model mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16 --voice default --lang_code en --audio_format wav",
              },
              // Agent "bob" uses a faster/simpler command (hypothetical)
              bob: {
                command: "echo",
                args: ["{{Text}}"],
              },
            },
          },
        },
      },
    },
  };
}

describeLive("CLI TTS Multi-Agent Integration", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(process.cwd(), ".tmp-cli-tts-integration-test");
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });

    if (!existsSync(AUDIO_OUTPUT_DIR)) {
      mkdirSync(AUDIO_OUTPUT_DIR, { recursive: true });
    }

    const registry = createEmptyPluginRegistry();
    registry.speechProviders = [
      { pluginId: "tts-local-cli", provider: buildCliSpeechProvider(), source: "test" },
    ];
    setActivePluginRegistry(registry, "cli-tts-integration-test");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("config resolution with multiple agents", () => {
    it("resolves default config when no agentId specified", () => {
      const cfg = buildMultiAgentConfig();
      const config = resolveTtsConfig(cfg);

      expect(config.provider).toBe("cli");
      const cliConfig = getResolvedSpeechProviderConfig(config, "cli");
      expect(cliConfig.command).toContain("--voice serena");
      expect(cliConfig.command).toContain("--lang_code zh");
    });

    it("resolves agent-specific config for 'alice' agent", () => {
      const cfg = buildMultiAgentConfig();
      const config = resolveTtsConfig(cfg, "alice");

      const cliConfig = getResolvedSpeechProviderConfig(config, "cli");
      expect(cliConfig.command).toContain("--voice default");
      expect(cliConfig.command).toContain("--lang_code en");
    });

    it("resolves agent-specific config for 'bob' agent", () => {
      const cfg = buildMultiAgentConfig();
      const config = resolveTtsConfig(cfg, "bob");

      const cliConfig = getResolvedSpeechProviderConfig(config, "cli");
      expect(cliConfig.command).toBe("echo");
      expect(cliConfig.args).toEqual(["{{Text}}"]);
    });

    it("falls back to default config for unknown agent", () => {
      const cfg = buildMultiAgentConfig();
      const config = resolveTtsConfig(cfg, "unknown-agent");

      const cliConfig = getResolvedSpeechProviderConfig(config, "cli");
      expect(cliConfig.command).toContain("--voice serena");
    });
  });

  describe("synthesis with different agents", () => {
    it("synthesizes with default config (no agentId)", async () => {
      const cfg = buildMultiAgentConfig();

      const result = await synthesizeSpeech({
        text: "Default agent test.",
        cfg,
      });

      expect(result.success).toBe(true);
      expect(result.audioBuffer!.length).toBeGreaterThan(0);

      const outputPath = path.join(AUDIO_OUTPUT_DIR, "agent-default.wav");
      writeFileSync(outputPath, result.audioBuffer!);
      console.log(`Saved default agent audio to: ${outputPath}`);
    });

    it("synthesizes with 'alice' agent config (English voice)", async () => {
      const cfg = buildMultiAgentConfig();

      const result = await synthesizeSpeech({
        text: "Alice agent speaking English.",
        cfg,
        agentId: "alice",
      });

      expect(result.success).toBe(true);
      expect(result.audioBuffer!.length).toBeGreaterThan(0);

      const outputPath = path.join(AUDIO_OUTPUT_DIR, "agent-alice.wav");
      writeFileSync(outputPath, result.audioBuffer!);
      console.log(`Saved alice agent audio to: ${outputPath}`);
    });
  });

  describe("end-to-end scenarios", () => {
    it("handles Chinese text with default agent", async () => {
      const cfg = buildMultiAgentConfig();

      const result = await synthesizeSpeech({
        text: "这是一个中文测试，测试多智能体配置。",
        cfg,
      });

      expect(result.success).toBe(true);

      const outputPath = path.join(AUDIO_OUTPUT_DIR, "scenario-chinese.wav");
      writeFileSync(outputPath, result.audioBuffer!);
      console.log(`Saved Chinese scenario audio to: ${outputPath}`);
    });

    it("handles text with emojis (strips them)", async () => {
      const cfg = buildMultiAgentConfig();

      const result = await synthesizeSpeech({
        text: "Hello 😀 World 🎉 Testing emoji removal!",
        cfg,
      });

      expect(result.success).toBe(true);

      const outputPath = path.join(AUDIO_OUTPUT_DIR, "scenario-emoji.wav");
      writeFileSync(outputPath, result.audioBuffer!);
      console.log(`Saved emoji scenario audio to: ${outputPath}`);
    });

    it("handles long text", async () => {
      const cfg = buildMultiAgentConfig();

      const longText =
        "This is a longer text to test the TTS system's ability to handle extended content. ".repeat(
          3,
        );

      const result = await synthesizeSpeech({
        text: longText,
        cfg,
      });

      expect(result.success).toBe(true);

      const outputPath = path.join(AUDIO_OUTPUT_DIR, "scenario-long.wav");
      writeFileSync(outputPath, result.audioBuffer!);
      console.log(
        `Saved long text scenario audio to: ${outputPath} (${result.audioBuffer!.length} bytes)`,
      );
    });
  });
});
