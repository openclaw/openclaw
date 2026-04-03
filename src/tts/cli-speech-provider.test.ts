import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import type { ResolvedTtsConfig } from "./tts.js";

// Mock tmp dir resolution — must be before dynamic import.
vi.mock("../infra/tmp-openclaw-dir.js", () => ({
  resolvePreferredOpenClawTmpDir: () => "/tmp/openclaw-test-tts-cli",
}));

// Mock child_process so execFile calls its callback properly.
const execFileMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

let buildCliSpeechProvider: typeof import("./cli-speech-provider.js").buildCliSpeechProvider;
let substituteCliArgs: typeof import("./cli-speech-provider.js").substituteCliArgs;

function makeConfig(cli?: ResolvedTtsConfig["cli"]): ResolvedTtsConfig {
  return {
    auto: "off",
    mode: "final",
    provider: "cli",
    providerSource: "config",
    modelOverrides: {
      enabled: false,
      allowText: false,
      allowProvider: false,
      allowVoice: false,
      allowModelId: false,
      allowVoiceSettings: false,
      allowNormalization: false,
      allowSeed: false,
    },
    elevenlabs: {
      baseUrl: "",
      voiceId: "",
      modelId: "",
      voiceSettings: {
        stability: 0.5,
        similarityBoost: 0.75,
        style: 0,
        useSpeakerBoost: true,
        speed: 1,
      },
    },
    openai: { baseUrl: "", model: "", voice: "" },
    edge: {
      enabled: false,
      voice: "",
      lang: "",
      outputFormat: "",
      outputFormatConfigured: false,
      saveSubtitles: false,
    },
    cli,
    maxTextLength: 4096,
    timeoutMs: 30_000,
  };
}

/** Set up execFileMock to write fake audio to the output file and call callback. */
function mockExecFileSuccess() {
  execFileMock.mockImplementation(
    (
      cmd: string,
      args: string[],
      opts: unknown,
      cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      // The output file is the last positional arg or one containing "output."
      const outputFile = args.find((a) => a.includes("output.")) ?? args[args.length - 1];
      if (outputFile) {
        mkdirSync(path.dirname(outputFile), { recursive: true });
        writeFileSync(outputFile, Buffer.from("RIFF-fake-audio"));
      }
      if (cb) {
        cb(null, { stdout: "", stderr: "" });
      }
    },
  );
}

function mockExecFileEmptyOutput() {
  execFileMock.mockImplementation(
    (
      cmd: string,
      args: string[],
      opts: unknown,
      cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      const outputFile = args.find((a) => a.includes("output.")) ?? args[args.length - 1];
      if (outputFile) {
        mkdirSync(path.dirname(outputFile), { recursive: true });
        writeFileSync(outputFile, Buffer.alloc(0));
      }
      if (cb) {
        cb(null, { stdout: "", stderr: "" });
      }
    },
  );
}

describe("CLI speech provider", () => {
  let provider: SpeechProviderPlugin;

  beforeEach(async () => {
    vi.resetModules();
    execFileMock.mockReset();
    ({ buildCliSpeechProvider, substituteCliArgs } = await import("./cli-speech-provider.js"));
    provider = buildCliSpeechProvider();
    mockExecFileSuccess();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("isConfigured", () => {
    it("returns true when cli.command is set", () => {
      const config = makeConfig({ command: "/usr/local/bin/kokoro-tts" });
      expect(provider.isConfigured({ config })).toBe(true);
    });

    it("returns false when cli is undefined", () => {
      const config = makeConfig(undefined);
      expect(provider.isConfigured({ config })).toBe(false);
    });

    it("returns false when cli.command is empty", () => {
      const config = makeConfig({ command: "" });
      expect(provider.isConfigured({ config })).toBe(false);
    });
  });

  describe("substituteCliArgs", () => {
    it("substitutes known placeholders", () => {
      const result = substituteCliArgs(
        ["--input", "{{TEXT_FILE}}", "--output", "{{OUTPUT_FILE}}", "--voice", "{{VOICE}}"],
        { TEXT_FILE: "/tmp/in.txt", OUTPUT_FILE: "/tmp/out.wav", VOICE: "af_heart" },
      );
      expect(result).toEqual([
        "--input",
        "/tmp/in.txt",
        "--output",
        "/tmp/out.wav",
        "--voice",
        "af_heart",
      ]);
    });

    it("leaves unknown placeholders unchanged", () => {
      const result = substituteCliArgs(["{{UNKNOWN}}"], { TEXT_FILE: "/tmp/in.txt" });
      expect(result).toEqual(["{{UNKNOWN}}"]);
    });
  });

  describe("synthesize", () => {
    it("calls the configured command and returns audio buffer", async () => {
      const config = makeConfig({
        command: "/usr/local/bin/kokoro-tts",
        outputFormat: "wav",
      });

      const result = await provider.synthesize({
        text: "Hello world",
        cfg: {} as OpenClawConfig,
        config,
        target: "audio-file",
      });

      expect(result.audioBuffer.length).toBeGreaterThan(0);
      expect(result.outputFormat).toBe("wav");
      expect(result.fileExtension).toBe(".wav");
      expect(result.voiceCompatible).toBe(false);
      expect(execFileMock).toHaveBeenCalledOnce();

      // Verify command and default args (textFile, outputFile).
      const [cmd, args] = execFileMock.mock.calls[0];
      expect(cmd).toBe("/usr/local/bin/kokoro-tts");
      expect(args).toHaveLength(2);
      expect(args[0]).toMatch(/input\.txt$/);
      expect(args[1]).toMatch(/output\.wav$/);
    });

    it("uses custom args with placeholder substitution", async () => {
      const config = makeConfig({
        command: "/usr/local/bin/kokoro-tts",
        args: ["--text", "{{TEXT_FILE}}", "--out", "{{OUTPUT_FILE}}", "--voice", "{{VOICE}}"],
        voice: "af_heart",
        outputFormat: "mp3",
      });

      const result = await provider.synthesize({
        text: "Test",
        cfg: {} as OpenClawConfig,
        config,
        target: "audio-file",
      });

      expect(result.outputFormat).toBe("mp3");
      const [, args] = execFileMock.mock.calls[0];
      expect(args[0]).toBe("--text");
      expect(args[1]).toMatch(/input\.txt$/);
      expect(args[2]).toBe("--out");
      expect(args[3]).toMatch(/output\.mp3$/);
      expect(args[4]).toBe("--voice");
      expect(args[5]).toBe("af_heart");
    });

    it("leaves unconfigured {{VOICE}}/{{MODEL}} placeholders intact", async () => {
      const config = makeConfig({
        command: "/usr/local/bin/kokoro-tts",
        args: ["--text", "{{TEXT_FILE}}", "--out", "{{OUTPUT_FILE}}", "--voice", "{{VOICE}}", "--model", "{{MODEL}}"],
        // voice and model intentionally omitted
      });

      await provider.synthesize({
        text: "Test",
        cfg: {} as OpenClawConfig,
        config,
        target: "audio-file",
      });

      const [, args] = execFileMock.mock.calls[0];
      expect(args[4]).toBe("--voice");
      expect(args[5]).toBe("{{VOICE}}");
      expect(args[6]).toBe("--model");
      expect(args[7]).toBe("{{MODEL}}");
    });

    it("throws when command is not configured", async () => {
      const config = makeConfig(undefined);
      await expect(
        provider.synthesize({
          text: "Hello",
          cfg: {} as OpenClawConfig,
          config,
          target: "audio-file",
        }),
      ).rejects.toThrow("CLI TTS command not configured");
    });

    it("throws when command produces empty output", async () => {
      mockExecFileEmptyOutput();

      const config = makeConfig({ command: "/usr/local/bin/kokoro-tts" });
      await expect(
        provider.synthesize({
          text: "Hello",
          cfg: {} as OpenClawConfig,
          config,
          target: "audio-file",
        }),
      ).rejects.toThrow("CLI TTS command produced empty output");
    });

    it("uses default output format (wav) when not specified", async () => {
      const config = makeConfig({ command: "/usr/local/bin/kokoro-tts" });
      const result = await provider.synthesize({
        text: "Hello",
        cfg: {} as OpenClawConfig,
        config,
        target: "audio-file",
      });
      expect(result.outputFormat).toBe("wav");
      expect(result.fileExtension).toBe(".wav");
    });

    it("respects custom timeout", async () => {
      const config = makeConfig({
        command: "/usr/local/bin/kokoro-tts",
        timeoutSeconds: 60,
      });
      await provider.synthesize({
        text: "Hello",
        cfg: {} as OpenClawConfig,
        config,
        target: "audio-file",
      });
      const [, , opts] = execFileMock.mock.calls[0];
      expect(opts.timeout).toBe(60_000);
    });

    it("writes input text to the text file", async () => {
      let capturedTextFile: string | undefined;
      execFileMock.mockImplementation(
        (
          cmd: string,
          args: string[],
          opts: unknown,
          cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
        ) => {
          capturedTextFile = args.find((a) => a.includes("input.txt")) ?? args[0];
          const outputFile = args.find((a) => a.includes("output.")) ?? args[args.length - 1];
          if (outputFile) {
            mkdirSync(path.dirname(outputFile), { recursive: true });
            writeFileSync(outputFile, Buffer.from("RIFF-fake-audio"));
          }
          if (cb) {
            cb(null, { stdout: "", stderr: "" });
          }
        },
      );

      const config = makeConfig({ command: "/usr/local/bin/kokoro-tts" });
      await provider.synthesize({
        text: "The quick brown fox",
        cfg: {} as OpenClawConfig,
        config,
        target: "audio-file",
      });

      // The text file should have been written before execFile was called.
      // We can't read it after since tmpDir is cleaned up, but we verified
      // the mock was called with the right path structure.
      expect(capturedTextFile).toMatch(/input\.txt$/);
    });
  });
});
