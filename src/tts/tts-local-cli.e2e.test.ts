import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCliSpeechProvider } from "../../extensions/tts-local-cli/speech-provider.ts";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { synthesizeSpeech, resolveTtsConfig } from "./tts.js";

// mlx_audio TTS configuration
const MLX_AUDIO_COMMAND =
  "python3 -m mlx_audio.tts.generate --model mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16 --voice serena --lang_code zh --audio_format wav";
const MLX_AUDIO_ARGS = [
  "--output_path",
  "{{OutputDir}}",
  "--file_prefix",
  "{{OutputBase}}",
  "--text",
  "{{Text}}",
];

const LIVE_CLI_TTS = process.env.OPENCLAW_LIVE_CLI_TTS?.trim() || MLX_AUDIO_COMMAND;
const LIVE_CLI_ARGS = process.env.OPENCLAW_LIVE_CLI_ARGS
  ? JSON.parse(process.env.OPENCLAW_LIVE_CLI_ARGS)
  : MLX_AUDIO_ARGS;
const LIVE_CLI_FORMAT = process.env.OPENCLAW_LIVE_CLI_FORMAT || "opus";
const liveEnabled = LIVE_CLI_TTS.length > 0 && process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = liveEnabled ? describe : describe.skip;

// Output directory for audio files
const AUDIO_OUTPUT_DIR = "/tmp/openclaw-cli-tts-output";

describe("CLI TTS", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(process.cwd(), ".tmp-cli-tts-test");
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });

    const registry = createEmptyPluginRegistry();
    registry.speechProviders = [
      { pluginId: "tts-local-cli", provider: buildCliSpeechProvider(), source: "test" },
    ];
    setActivePluginRegistry(registry, "cli-tts-test");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("config resolution", () => {
    it("merges agent-specific CLI config with base config", () => {
      const cfg: OpenClawConfig = {
        messages: {
          tts: {
            provider: "cli",
            providers: {
              cli: {
                command: "tts-cli",
                args: ["--output", "{{OutputPath}}", "{{Text}}"],
                outputFormat: "mp3",
                timeoutMs: 60000,
                agents: {
                  "agent-1": {
                    command: "specialized-tts-1",
                    args: ["--voice", "voice1", "{{Text}}"],
                    outputFormat: "opus",
                  },
                  "agent-2": {
                    command: "specialized-tts-2",
                  },
                },
              },
            },
          },
        },
      };

      // Test base config (no agentId)
      const baseConfig = resolveTtsConfig(cfg);
      expect(baseConfig.providerConfigs.cli.command).toBe("tts-cli");
      expect(baseConfig.providerConfigs.cli.args).toEqual([
        "--output",
        "{{OutputPath}}",
        "{{Text}}",
      ]);
      expect(baseConfig.providerConfigs.cli.outputFormat).toBe("mp3");
      expect(baseConfig.providerConfigs.cli.timeoutMs).toBe(60000);

      // Test agent-1 override
      const agent1Config = resolveTtsConfig(cfg, "agent-1");
      expect(agent1Config.providerConfigs.cli.command).toBe("specialized-tts-1");
      expect(agent1Config.providerConfigs.cli.args).toEqual(["--voice", "voice1", "{{Text}}"]);
      expect(agent1Config.providerConfigs.cli.outputFormat).toBe("opus");
      expect(agent1Config.providerConfigs.cli.timeoutMs).toBe(60000); // inherited from base

      // Test agent-2 override (command only)
      const agent2Config = resolveTtsConfig(cfg, "agent-2");
      expect(agent2Config.providerConfigs.cli.command).toBe("specialized-tts-2");
      expect(agent2Config.providerConfigs.cli.args).toEqual([
        "--output",
        "{{OutputPath}}",
        "{{Text}}",
      ]); // inherited
      expect(agent2Config.providerConfigs.cli.outputFormat).toBe("mp3"); // inherited
    });

    it("returns base config for unknown agent", () => {
      const cfg: OpenClawConfig = {
        messages: {
          tts: {
            provider: "cli",
            providers: {
              cli: {
                command: "tts-cli",
                args: ["{{Text}}"],
                agents: {
                  "known-agent": {
                    command: "special-tts",
                  },
                },
              },
            },
          },
        },
      };

      const unknownConfig = resolveTtsConfig(cfg, "unknown-agent");
      expect(unknownConfig.providerConfigs.cli.command).toBe("tts-cli"); // base config
    });
  });

  describe("provider isConfigured", () => {
    it("returns true when command is set", () => {
      const provider = buildCliSpeechProvider();
      expect(
        provider.isConfigured({
          providerConfig: { command: "/usr/local/bin/tts-cli" },
          timeoutMs: 30000,
        }),
      ).toBe(true);
    });

    it("returns false when command is missing", () => {
      const provider = buildCliSpeechProvider();
      expect(
        provider.isConfigured({
          providerConfig: {},
          timeoutMs: 30000,
        }),
      ).toBe(false);
    });
  });

  describe("template placeholders", () => {
    it("supports double-brace format {{Text}}", () => {
      const config = {
        command: "echo",
        args: ["{{Text}}"],
        outputFormat: "wav" as const,
      };
      expect(config.args[0]).toBe("{{Text}}");
    });

    it("supports {{OutputBase}} placeholder", () => {
      const config = {
        command: "echo",
        args: ["--file_prefix", "{{OutputBase}}", "--text", "{{Text}}"],
        outputFormat: "wav" as const,
      };
      expect(config.args[1]).toBe("{{OutputBase}}");
    });
  });
});

describeLive("CLI TTS (Live - mlx_audio)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(process.cwd(), ".tmp-cli-tts-live-test");
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });

    // Create output directory for audio files (don't delete if exists)
    if (!existsSync(AUDIO_OUTPUT_DIR)) {
      mkdirSync(AUDIO_OUTPUT_DIR, { recursive: true });
    }

    const registry = createEmptyPluginRegistry();
    registry.speechProviders = [
      { pluginId: "tts-local-cli", provider: buildCliSpeechProvider(), source: "test" },
    ];
    setActivePluginRegistry(registry, "cli-tts-live-test");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("synthesizes Chinese text", async () => {
    const cfg: OpenClawConfig = {
      messages: {
        tts: {
          provider: "cli",
          providers: {
            cli: {
              command: LIVE_CLI_TTS,
              args: LIVE_CLI_ARGS,
              outputFormat: LIVE_CLI_FORMAT,
              timeoutMs: 120000,
            },
          },
        },
      },
    };

    const text = "你好世界，这是一个测试。";
    const result = await synthesizeSpeech({
      text,
      cfg,
    });

    expect(result.success).toBe(true);
    expect(result.audioBuffer).toBeDefined();
    expect(result.audioBuffer!.length).toBeGreaterThan(0);

    // Save to file for listening
    const outputPath = path.join(AUDIO_OUTPUT_DIR, "test-chinese.wav");
    writeFileSync(outputPath, result.audioBuffer!);
    console.log(`Saved Chinese audio to: ${outputPath} (${result.audioBuffer!.length} bytes)`);
  });

  it("synthesizes English text", async () => {
    const cfg: OpenClawConfig = {
      messages: {
        tts: {
          provider: "cli",
          providers: {
            cli: {
              command: LIVE_CLI_TTS,
              args: LIVE_CLI_ARGS,
              outputFormat: LIVE_CLI_FORMAT,
              timeoutMs: 120000,
            },
          },
        },
      },
    };

    const text = "Hello world, this is a test.";
    const result = await synthesizeSpeech({
      text,
      cfg,
    });

    if (!result.success) {
      console.log(`Error: ${result.error}`);
    }
    expect(result.success).toBe(true);
    expect(result.audioBuffer).toBeDefined();
    expect(result.audioBuffer!.length).toBeGreaterThan(0);

    // Save to file for listening
    const outputPath = path.join(AUDIO_OUTPUT_DIR, "test-english.wav");
    writeFileSync(outputPath, result.audioBuffer!);
    console.log(`Saved English audio to: ${outputPath} (${result.audioBuffer!.length} bytes)`);
  });

  it("handles text with emojis", async () => {
    const cfg: OpenClawConfig = {
      messages: {
        tts: {
          provider: "cli",
          providers: {
            cli: {
              command: LIVE_CLI_TTS,
              args: LIVE_CLI_ARGS,
              outputFormat: LIVE_CLI_FORMAT,
              timeoutMs: 120000,
            },
          },
        },
      },
    };

    const text = "Hello 😀 World 🎉 Test";
    const result = await synthesizeSpeech({
      text,
      cfg,
    });

    if (!result.success) {
      console.log(`Error: ${result.error}`);
    }
    expect(result.success).toBe(true);
    expect(result.audioBuffer).toBeDefined();

    // Save to file for listening
    const outputPath = path.join(AUDIO_OUTPUT_DIR, "test-emoji.wav");
    writeFileSync(outputPath, result.audioBuffer!);
    console.log(`Saved emoji audio to: ${outputPath} (${result.audioBuffer!.length} bytes)`);
  });
});
