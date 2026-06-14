// CLI audio runner tests cover prompt/language templating and command execution
// options for local transcription binaries.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import type { MediaUnderstandingModelConfig } from "../config/types.tools.js";
import { CLI_OUTPUT_MAX_BUFFER } from "./defaults.constants.js";
import { withAudioFixture } from "./runner.test-utils.js";

const runExecMock = vi.hoisted(() => vi.fn());

vi.mock("../process/exec.js", () => ({
  runExec: (...args: unknown[]) => runExecMock(...args),
}));

let runCliEntry: typeof import("./runner.entries.js").runCliEntry;

function requireFirstRunExecCall(): unknown[] {
  const [call] = runExecMock.mock.calls;
  if (!call) {
    throw new Error("expected runExec call");
  }
  return call;
}

const localWhisperNodeEntry: MediaUnderstandingModelConfig = {
  type: "cli",
  command: "node",
  args: [
    "/home/art/.openclaw/skills/local-whisper/transcribe.js",
    "{{MediaPath}}",
    "--output-dir",
    "{{OutputDir}}",
  ],
};

function localWhisperTranscriptPath(args: unknown[]): string {
  const argv = args as string[];
  const mediaPath = argv[1] ?? "";
  const outputDir = argv[argv.indexOf("--output-dir") + 1] ?? "";
  return path.join(outputDir, `${path.parse(mediaPath).name}.txt`);
}

async function writeLocalWhisperTranscript(args: unknown[], content: string): Promise<void> {
  await fs.writeFile(localWhisperTranscriptPath(args), content);
}

function findArgValue(argv: string[], key: string): string {
  const index = argv.indexOf(key);
  if (index < 0 || !argv[index + 1]) {
    throw new Error(`expected ${key} argument`);
  }
  return argv[index + 1];
}

function whisperCliTranscriptPath(args: unknown[]): string {
  return `${findArgValue(args as string[], "-of")}.txt`;
}

function parakeetTranscriptPath(args: unknown[]): string {
  const argv = args as string[];
  const mediaPath = argv[0] ?? "";
  const outputDir = findArgValue(argv, "--output-dir");
  return path.join(outputDir, `${path.parse(mediaPath).name}.txt`);
}

describe("media-understanding CLI audio entry", () => {
  beforeAll(async () => {
    ({ runCliEntry } = await import("./runner.entries.js"));
  });

  beforeEach(() => {
    runExecMock.mockReset().mockResolvedValue({ stdout: "cli transcript" });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("applies per-request prompt and language overrides to CLI transcription templating", async () => {
    let mediaPath = "";

    await withAudioFixture("openclaw-cli-audio", async ({ ctx, cache }) => {
      mediaPath = await fs.realpath(ctx.MediaPath);

      await runCliEntry({
        capability: "audio",
        entry: {
          type: "cli",
          command: "mock-transcriber",
          args: ["--prompt", "{{Prompt}}", "--language", "{{Language}}", "--file", "{{MediaPath}}"],
          prompt: "entry prompt",
          language: "de",
        },
        cfg: {
          tools: {
            media: {
              audio: {
                prompt: "configured prompt",
                language: "fr",
                _requestPromptOverride: "Focus on names",
                _requestLanguageOverride: "en",
              },
            },
          },
        } as OpenClawConfig,
        ctx,
        attachmentIndex: 0,
        cache,
        config: {
          prompt: "configured prompt",
          language: "fr",
          _requestPromptOverride: "Focus on names",
          _requestLanguageOverride: "en",
        } as never,
      });
    });

    expect(runExecMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = requireFirstRunExecCall();
    expect(command).toBe("mock-transcriber");
    expect(args).toEqual(["--prompt", "Focus on names", "--language", "en", "--file", mediaPath]);
    expect(options).toEqual({
      timeoutMs: 60_000,
      maxBuffer: CLI_OUTPUT_MAX_BUFFER,
    });
  });

  it("treats sherpa structured JSON with empty text as empty output", async () => {
    runExecMock.mockResolvedValueOnce({
      stdout:
        '{"lang":"","emotion":"","event":"","text":"","timestamps":[],"durations":[],"tokens":[],"ys_log_probs":[],"words":[]}',
      stderr: "",
    });

    await withAudioFixture("openclaw-cli-audio-empty-sherpa", async ({ ctx, cache }) => {
      const result = await runCliEntry({
        capability: "audio",
        entry: {
          type: "cli",
          command: "sherpa-onnx-offline",
          args: ["{{MediaPath}}"],
        },
        cfg: { tools: { media: { audio: {} } } } as OpenClawConfig,
        ctx,
        attachmentIndex: 0,
        cache,
        config: {} as never,
      });

      expect(result).toBeNull();
    });
  });

  it("extracts sherpa text from the final structured output line", async () => {
    runExecMock.mockResolvedValueOnce({
      stdout: 'loading model\n{"text":"sherpa transcript","tokens":["sherpa","transcript"]}\n',
      stderr: "",
    });

    await withAudioFixture("openclaw-cli-audio-sherpa-json", async ({ ctx, cache }) => {
      const result = await runCliEntry({
        capability: "audio",
        entry: {
          type: "cli",
          command: "sherpa-onnx-offline",
          args: ["{{MediaPath}}"],
        },
        cfg: { tools: { media: { audio: {} } } } as OpenClawConfig,
        ctx,
        attachmentIndex: 0,
        cache,
        config: {} as never,
      });

      expect(result?.text).toBe("sherpa transcript");
    });
  });

  it("treats an empty whisper-cli inferred transcript file as no transcript", async () => {
    runExecMock.mockImplementationOnce(async (_command, args) => {
      await fs.writeFile(whisperCliTranscriptPath(args as unknown[]), "");
      return {
        stdout: "whisper progress: processing audio\n",
        stderr: "",
      };
    });

    await withAudioFixture("openclaw-cli-audio-whisper-cli-empty", async ({ ctx, cache }) => {
      const result = await runCliEntry({
        capability: "audio",
        entry: {
          type: "cli",
          command: "whisper-cli",
          args: ["-otxt", "-of", "{{OutputBase}}", "{{MediaPath}}"],
        },
        cfg: { tools: { media: { audio: {} } } } as OpenClawConfig,
        ctx,
        attachmentIndex: 0,
        cache,
        config: {} as never,
      });

      expect(result).toBeNull();
    });
  });

  it("does not expose whisper progress output when an inferred whisper transcript file is missing", async () => {
    runExecMock.mockResolvedValueOnce({
      stdout: "whisper progress: processing audio\n",
      stderr: "",
    });

    await withAudioFixture("openclaw-cli-audio-whisper-missing", async ({ ctx, cache }) => {
      const result = await runCliEntry({
        capability: "audio",
        entry: {
          type: "cli",
          command: "whisper",
          args: ["--output_format", "txt", "--output_dir", "{{OutputDir}}", "{{MediaPath}}"],
        },
        cfg: { tools: { media: { audio: {} } } } as OpenClawConfig,
        ctx,
        attachmentIndex: 0,
        cache,
        config: {} as never,
      });

      expect(result).toBeNull();
    });
  });

  it("treats an empty explicit txt parakeet-mlx inferred transcript file as no transcript", async () => {
    runExecMock.mockImplementationOnce(async (_command, args) => {
      await fs.writeFile(parakeetTranscriptPath(args as unknown[]), "");
      return {
        stdout: "parakeet progress: processing audio\n",
        stderr: "",
      };
    });

    await withAudioFixture("openclaw-cli-audio-parakeet-empty", async ({ ctx, cache }) => {
      const result = await runCliEntry({
        capability: "audio",
        entry: {
          type: "cli",
          command: "parakeet-mlx",
          args: ["{{MediaPath}}", "--output-dir", "{{OutputDir}}", "--output-format", "txt"],
        },
        cfg: { tools: { media: { audio: {} } } } as OpenClawConfig,
        ctx,
        attachmentIndex: 0,
        cache,
        config: {} as never,
      });

      expect(result).toBeNull();
    });
  });

  it("keeps stdout fallback for parakeet-mlx output-dir without explicit txt format", async () => {
    runExecMock.mockImplementationOnce(async () => ({
      stdout: "parakeet stdout transcript\n",
      stderr: "",
    }));

    await withAudioFixture(
      "openclaw-cli-audio-parakeet-output-dir-default",
      async ({ ctx, cache }) => {
        const result = await runCliEntry({
          capability: "audio",
          entry: {
            type: "cli",
            command: "parakeet-mlx",
            args: ["{{MediaPath}}", "--output-dir", "{{OutputDir}}"],
          },
          cfg: { tools: { media: { audio: {} } } } as OpenClawConfig,
          ctx,
          attachmentIndex: 0,
          cache,
          config: {} as never,
        });

        expect(result?.text).toBe("parakeet stdout transcript");
      },
    );
  });

  it("reads transcript text emitted by the local whisper node wrapper", async () => {
    runExecMock.mockImplementationOnce(async (_command, args) => {
      await writeLocalWhisperTranscript(args as unknown[], "local transcript\n");
      return {
        stdout: "Whisper Voice Transcription\nModel: small\nTranscribing with Whisper...\n",
        stderr: "",
      };
    });

    await withAudioFixture("openclaw-cli-audio-local-whisper", async ({ ctx, cache }) => {
      const result = await runCliEntry({
        capability: "audio",
        entry: localWhisperNodeEntry,
        cfg: { tools: { media: { audio: {} } } } as OpenClawConfig,
        ctx,
        attachmentIndex: 0,
        cache,
        config: {} as never,
      });

      expect(result?.text).toBe("local transcript");
    });
  });

  it("treats an empty local whisper node wrapper transcript file as no transcript", async () => {
    runExecMock.mockImplementationOnce(async (_command, args) => {
      await writeLocalWhisperTranscript(args as unknown[], "");
      return {
        stdout: "Whisper Voice Transcription\nModel: small\nTranscribing with Whisper...\n",
        stderr: "",
      };
    });

    await withAudioFixture("openclaw-cli-audio-local-whisper-empty", async ({ ctx, cache }) => {
      const result = await runCliEntry({
        capability: "audio",
        entry: localWhisperNodeEntry,
        cfg: { tools: { media: { audio: {} } } } as OpenClawConfig,
        ctx,
        attachmentIndex: 0,
        cache,
        config: {} as never,
      });

      expect(result).toBeNull();
    });
  });

  it("does not expose local whisper node wrapper progress output when transcript file is missing", async () => {
    runExecMock.mockResolvedValueOnce({
      stdout: "Whisper Voice Transcription\nModel: small\nTranscribing with Whisper...\n",
      stderr: "",
    });

    await withAudioFixture(
      "openclaw-cli-audio-local-whisper-missing-output",
      async ({ ctx, cache }) => {
        const result = await runCliEntry({
          capability: "audio",
          entry: localWhisperNodeEntry,
          cfg: { tools: { media: { audio: {} } } } as OpenClawConfig,
          ctx,
          attachmentIndex: 0,
          cache,
          config: {} as never,
        });

        expect(result).toBeNull();
      },
    );
  });

  it("treats local whisper node wrapper -o output as authoritative", async () => {
    runExecMock.mockResolvedValueOnce({
      stdout: "Whisper Voice Transcription\nModel: small\nTranscribing with Whisper...\n",
      stderr: "",
    });

    await withAudioFixture(
      "openclaw-cli-audio-local-whisper-short-output",
      async ({ ctx, cache }) => {
        const result = await runCliEntry({
          capability: "audio",
          entry: {
            ...localWhisperNodeEntry,
            args: [
              "/home/art/.openclaw/skills/local-whisper/transcribe.js",
              "{{MediaPath}}",
              "-o",
              "{{OutputDir}}",
            ],
          },
          cfg: { tools: { media: { audio: {} } } } as OpenClawConfig,
          ctx,
          attachmentIndex: 0,
          cache,
          config: {} as never,
        });

        expect(result).toBeNull();
      },
    );
  });

  it("preserves stdout fallback for other node transcription wrappers", async () => {
    runExecMock.mockImplementationOnce(async (_command, args) => {
      await writeLocalWhisperTranscript(args as unknown[], "");
      return {
        stdout: "stdout transcript\n",
        stderr: "",
      };
    });

    await withAudioFixture("openclaw-cli-audio-node-wrapper-stdout", async ({ ctx, cache }) => {
      const result = await runCliEntry({
        capability: "audio",
        entry: {
          ...localWhisperNodeEntry,
          args: [
            "/opt/other-whisper/transcribe.js",
            "{{MediaPath}}",
            "--output-dir",
            "{{OutputDir}}",
          ],
        },
        cfg: { tools: { media: { audio: {} } } } as OpenClawConfig,
        ctx,
        attachmentIndex: 0,
        cache,
        config: {} as never,
      });

      expect(result?.text).toBe("stdout transcript");
    });
  });

  it("surfaces unexpected local whisper node wrapper transcript read errors", async () => {
    runExecMock.mockImplementationOnce(async (_command, args) => {
      await fs.mkdir(localWhisperTranscriptPath(args as unknown[]));
      return {
        stdout: "Whisper Voice Transcription\nModel: small\nTranscribing with Whisper...\n",
        stderr: "",
      };
    });

    await withAudioFixture(
      "openclaw-cli-audio-local-whisper-read-error",
      async ({ ctx, cache }) => {
        await expect(
          runCliEntry({
            capability: "audio",
            entry: localWhisperNodeEntry,
            cfg: { tools: { media: { audio: {} } } } as OpenClawConfig,
            ctx,
            attachmentIndex: 0,
            cache,
            config: {} as never,
          }),
        ).rejects.toThrow();
      },
    );
  });
});
