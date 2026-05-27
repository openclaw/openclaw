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
