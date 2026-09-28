// CLI audio runner tests cover prompt/language templating and command execution
// options for local transcription binaries.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import type { MediaUnderstandingModelConfig } from "../config/types.tools.js";
import { logWarn } from "../logger.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { CLI_OUTPUT_MAX_BUFFER } from "./defaults.constants.js";
import { createMediaAttachmentCache, normalizeMediaAttachments } from "./runner.attachments.js";
import {
  createSafeAudioFixtureBuffer,
  withAudioFixture,
  withMediaFixture,
} from "./runner.test-utils.js";
import type { MediaAttachment } from "./types.js";

const runExecMock = vi.hoisted(() => vi.fn());
const runFfmpegMock = vi.hoisted(() => vi.fn());

vi.mock("../logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logger.js")>()),
  logWarn: vi.fn(),
}));

vi.mock("../process/exec.js", () => ({
  runExec: (...args: unknown[]) => runExecMock(...args),
}));

vi.mock("../media/media-services.js", () => ({
  runFfmpeg: (...args: unknown[]) => runFfmpegMock(...args),
}));

let runCliEntry: typeof import("./runner.entries.js").runCliEntry;

type TranscriptFileCase = {
  name: string;
  command: string;
  args: string[];
  resolvePath: (args: string[]) => string;
};

const transcriptFileCases: TranscriptFileCase[] = [
  {
    name: "whisper.cpp short flags",
    command: "whisper-cli",
    args: ["-otxt", "-of", "{{OutputBase}}", "{{MediaPath}}"],
    resolvePath: (args) => `${args[2]}.txt`,
  },
  {
    name: "whisper.cpp long flags",
    command: "whisper-cli",
    args: ["--output-txt", "--output-file={{OutputBase}}", "{{MediaPath}}"],
    resolvePath: (args) => `${args[1]?.slice("--output-file=".length)}.txt`,
  },
  {
    name: "OpenAI Whisper explicit txt",
    command: "whisper",
    args: ["{{MediaPath}}", "--output_format=txt", "--output_dir={{OutputDir}}"],
    resolvePath: (args) =>
      path.join(
        args[2]?.slice("--output_dir=".length) ?? "",
        `${path.parse(args[0] ?? "").name}.txt`,
      ),
  },
  {
    name: "OpenAI Whisper default all output",
    command: "whisper",
    args: ["-o", "{{OutputDir}}", "{{MediaPath}}"],
    resolvePath: (args) => path.join(args[1] ?? "", `${path.parse(args[2] ?? "").name}.txt`),
  },
  {
    name: "parakeet txt output",
    command: "parakeet-mlx",
    args: ["{{MediaPath}}", "--output-format", "txt", "--output-dir", "{{OutputDir}}"],
    resolvePath: (args) => path.join(args[4] ?? "", `${path.parse(args[0] ?? "").name}.txt`),
  },
  {
    name: "parakeet all output with default template",
    command: "parakeet-mlx",
    args: [
      "{{MediaPath}}",
      "--output-format=all",
      "--output-dir={{OutputDir}}",
      "--output-template={filename}",
    ],
    resolvePath: (args) =>
      path.join(
        args[2]?.slice("--output-dir=".length) ?? "",
        `${path.parse(args[0] ?? "").name}.txt`,
      ),
  },
];

function requireFirstRunExecCall(): unknown[] {
  const [call] = runExecMock.mock.calls;
  if (!call) {
    throw new Error("expected runExec call");
  }
  return call;
}

function requireFirstAttachment(media: MediaAttachment[]): MediaAttachment {
  const attachment = media[0];
  if (!attachment) {
    throw new Error("expected media attachment");
  }
  return attachment;
}

async function runAudioEntry(params: {
  command: string;
  args: string[];
}): Promise<Awaited<ReturnType<typeof runCliEntry>>> {
  let result: Awaited<ReturnType<typeof runCliEntry>> = null;
  await withAudioFixture(`openclaw-cli-${params.command}`, async ({ ctx, media, cache }) => {
    result = await runCliEntry({
      capability: "audio",
      entry: { type: "cli", command: params.command, args: params.args },
      cfg: { tools: { media: { audio: {} } } } as OpenClawConfig,
      ctx,
      attachment: requireFirstAttachment(media),
      cache,
      config: {} as never,
    });
  });
  return result;
}

describe("media-understanding CLI audio entry", () => {
  beforeAll(async () => {
    ({ runCliEntry } = await import("./runner.entries.js"));
  });

  beforeEach(() => {
    runExecMock.mockReset().mockResolvedValue({ stdout: "cli transcript" });
    runFfmpegMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each<{ name: string; entry: MediaUnderstandingModelConfig; reason: string }>([
    { name: "missing command", entry: { type: "cli" }, reason: "cli-missing-command" },
    { name: "blank command", entry: { type: "cli", command: "  " }, reason: "cli-missing-command" },
    {
      name: "missing args",
      entry: { type: "cli", command: "fixture-transcribe" },
      reason: "cli-missing-attachment-arg",
    },
    {
      name: "empty args",
      entry: { command: "fixture-transcribe", args: [] },
      reason: "cli-missing-attachment-arg",
    },
  ])("reports $name as unavailable without executing it", async ({ entry, reason }) => {
    const { runCapability } = await import("./runner.js");
    await withAudioFixture("openclaw-cli-unavailable", async ({ ctx, media, cache }) => {
      await expect(
        runCliEntry({
          capability: "audio",
          entry,
          cfg: {},
          ctx,
          attachment: requireFirstAttachment(media),
          cache,
        }),
      ).rejects.toMatchObject({ reason });
      const result = await runCapability({
        capability: "audio",
        cfg: { tools: { media: { models: [{ ...entry, capabilities: ["audio"] }] } } },
        ctx,
        media,
        attachments: cache,
        providerRegistry: new Map(),
      });
      expect(result.outputs).toEqual([]);
      expect(result.decision).toMatchObject({
        outcome: "failed",
        attachmentProcessing: { 0: "omitted" },
        attachmentDispositions: { 0: { kind: "failed" } },
        attachments: [
          {
            attempts: [{ type: "cli", outcome: "failed", reason: expect.stringContaining(reason) }],
          },
        ],
      });
      expect(logWarn).toHaveBeenCalledWith(expect.stringContaining(reason));
      expect(runExecMock).not.toHaveBeenCalled();
      expect(runFfmpegMock).not.toHaveBeenCalled();
    });
  });

  it("continues to a working CLI after an unavailable entry", async () => {
    const { runCapability } = await import("./runner.js");
    await withAudioFixture("openclaw-cli-fallback", async ({ ctx, media, cache }) => {
      const result = await runCapability({
        capability: "audio",
        cfg: {
          tools: {
            media: {
              models: [
                { type: "cli", command: "invalid-transcribe", capabilities: ["audio"] },
                {
                  type: "cli",
                  command: "working-transcribe",
                  args: ["{{ AttachmentPath }}"],
                  capabilities: ["audio"],
                },
              ],
            },
          },
        },
        ctx,
        media,
        attachments: cache,
        providerRegistry: new Map(),
      });
      expect(result.outputs[0]?.text).toBe("cli transcript");
      expect(result.decision.attachments[0]?.attempts.map((attempt) => attempt.outcome)).toEqual([
        "failed",
        "success",
      ]);
      expect(runExecMock).toHaveBeenCalledExactlyOnceWith(
        "working-transcribe",
        [expect.any(String)],
        expect.any(Object),
      );
    });
  });

  it("executes a custom CLI with a literal attachment path", async () => {
    const actual = await vi.importActual<typeof import("../process/exec.js")>("../process/exec.js");
    runExecMock.mockImplementationOnce(actual.runExec);
    await withAudioFixture(
      "openclaw-cli-literal-input",
      async ({ ctx, media, mediaPath, cache }) => {
        const args = [
          "-e",
          "process.stdout.write(String(require('node:fs').readFileSync(process.argv[1]).length))",
          mediaPath,
        ];
        const result = await runCliEntry({
          capability: "audio",
          entry: { type: "cli", command: process.execPath, args },
          cfg: {},
          ctx,
          attachment: requireFirstAttachment(media),
          cache,
        });
        expect(result?.text).toBe(String((await fs.stat(mediaPath)).size));
        expect(runExecMock).toHaveBeenCalledExactlyOnceWith(
          process.execPath,
          args,
          expect.any(Object),
        );
      },
    );
  });

  it("preserves custom arguments relative to the attachment working directory", async () => {
    await withAudioFixture(
      "openclaw-cli-custom-input",
      async ({ ctx, media, mediaPath, cache }) => {
        const args = ["describe", path.basename(mediaPath)];
        const result = await runCliEntry({
          capability: "audio",
          entry: { type: "cli", command: "agy", args },
          cfg: {},
          ctx,
          attachment: requireFirstAttachment(media),
          cache,
        });
        expect(result?.text).toBe("cli transcript");
        expect(runExecMock).toHaveBeenCalledExactlyOnceWith(
          "agy",
          args,
          expect.objectContaining({
            cwd: path.dirname(await fs.realpath(mediaPath)),
          }),
        );
      },
    );
  });

  it("applies per-request prompt and language overrides to CLI transcription templating", async () => {
    let mediaPath = "";

    await withAudioFixture(
      "openclaw-cli-audio",
      async ({ ctx, mediaPath: fixturePath, media, cache }) => {
        mediaPath = await fs.realpath(fixturePath);

        await runCliEntry({
          capability: "audio",
          entry: {
            type: "cli",
            command: "mock-transcriber",
            args: [
              "--prompt",
              "{{Prompt}}",
              "--language",
              "{{Language}}",
              "--file",
              "{{MediaPath}}",
            ],
            prompt: "entry prompt",
            language: "de",
          },
          cfg: {
            tools: {
              media: {
                audio: {
                  prompt: "configured prompt",
                  language: "fr",
                },
              },
            },
          },
          ctx,
          attachment: requireFirstAttachment(media),
          cache,
          config: {
            prompt: "configured prompt",
            language: "fr",
          },
          request: { prompt: "Focus on names", language: "en" },
        });
      },
    );

    expect(runExecMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = requireFirstRunExecCall();
    expect(command).toBe("mock-transcriber");
    expect(args).toEqual(["--prompt", "Focus on names", "--language", "en", "--file", mediaPath]);
    expect(options).toEqual({
      timeoutMs: 60_000,
      maxBuffer: CLI_OUTPUT_MAX_BUFFER,
    });
  });

  it.each([
    { source: "model entry", entryLanguage: "de", configLanguage: "fr", expected: "de" },
    {
      source: "capability default",
      entryLanguage: undefined,
      configLanguage: "fr",
      expected: "fr",
    },
  ])("applies the configured $source language to CLI templating", async (testCase) => {
    await withAudioFixture("openclaw-cli-language", async ({ ctx, media, cache }) => {
      await runCliEntry({
        capability: "audio",
        entry: {
          type: "cli",
          command: "mock-transcriber",
          args: ["--language", "{{Language}}", "--file", "{{MediaPath}}"],
          language: testCase.entryLanguage,
        },
        cfg: {
          tools: { media: { audio: { language: testCase.configLanguage } } },
        } as OpenClawConfig,
        ctx,
        attachment: requireFirstAttachment(media),
        cache,
        config: { language: testCase.configLanguage } as never,
      });
    });

    const [, args] = requireFirstRunExecCall();
    expect(args).toEqual(["--language", testCase.expected, "--file", expect.any(String)]);
  });

  it.each([
    { name: "one attachment", count: 1, leadingEmpty: false },
    { name: "many attachments after an empty slot", count: 2, leadingEmpty: true },
  ])(
    "projects facts-first and deprecated template variables for $name",
    async ({ count, leadingEmpty }) => {
      await withTestDir({ prefix: "openclaw-cli-media-template-" }, async (base) => {
        const media = await Promise.all(
          Array.from({ length: count }, async (_, index) => {
            const mediaPath = path.join(base, `audio-${index}.wav`);
            await fs.writeFile(mediaPath, createSafeAudioFixtureBuffer());
            return {
              path: mediaPath,
              url: `media://inbound/audio-${index}.wav`,
              contentType: index === 0 ? "audio/wav" : "audio/x-wav",
            };
          }),
        );
        const alignedMedia: Array<Partial<(typeof media)[number]>> = leadingEmpty
          ? [{}, ...media]
          : media;
        const ctx = {
          media: alignedMedia,
        };
        const attachments = normalizeMediaAttachments(ctx);
        expect(attachments.map((attachment) => attachment.index)).toEqual(
          leadingEmpty ? [1, 2] : [0],
        );
        const cache = createMediaAttachmentCache(attachments, {
          localPathRoots: [base],
          includeDefaultLocalPathRoots: false,
        });
        try {
          for (const [callIndex, attachment] of attachments.entries()) {
            await runCliEntry({
              capability: "audio",
              entry: {
                type: "cli",
                command: "mock-transcriber",
                args: [
                  "{{AttachmentPath}}",
                  "{{AttachmentUrl}}",
                  "{{AttachmentContentType}}",
                  "{{AttachmentDir}}",
                  "{{AttachmentIndex}}",
                  "{{MediaPath}}",
                  "{{MediaUrl}}",
                  "{{MediaType}}",
                  "{{MediaDir}}",
                  "{{MediaPaths}}",
                ],
              },
              cfg: { tools: { media: { audio: {} } } } as OpenClawConfig,
              ctx,
              attachment,
              cache,
              config: {} as never,
            });
            expect(runExecMock.mock.calls[callIndex]?.[1]).toEqual([
              media[callIndex]?.path,
              media[callIndex]?.url,
              media[callIndex]?.contentType,
              base,
              String(attachment.index),
              media[callIndex]?.path,
              media[callIndex]?.url,
              media[callIndex]?.contentType,
              base,
              "",
            ]);
          }
        } finally {
          await cache.cleanup();
        }
      });
    },
  );

  it.each(transcriptFileCases.slice(1))("reads $name transcript output", async (testCase) => {
    runExecMock.mockImplementationOnce(async (_command, args: string[]) => {
      await fs.writeFile(testCase.resolvePath(args), "file transcript\n");
      return { stdout: "Transcribing...\n", stderr: "" };
    });

    const result = await runAudioEntry(testCase);

    expect(result?.text).toBe("file transcript");
  });

  it("removes the CLI scratch directory when audio conversion fails", async () => {
    let scratchDir = "";
    runFfmpegMock.mockImplementationOnce(async (args: string[]) => {
      const outputPath = args.at(-1);
      if (!outputPath) {
        throw new Error("expected ffmpeg output path");
      }
      scratchDir = path.dirname(outputPath);
      throw new Error("ffmpeg conversion failed");
    });

    await withMediaFixture(
      {
        filePrefix: "openclaw-cli-whisper-conversion-failure",
        extension: "mp3",
        mediaType: "audio/mpeg",
        fileContents: createSafeAudioFixtureBuffer(),
      },
      async ({ ctx, media, cache }) => {
        await expect(
          runCliEntry({
            capability: "audio",
            entry: {
              type: "cli",
              command: "whisper-cli",
              args: ["-otxt", "-of", "{{OutputBase}}", "{{MediaPath}}"],
            },
            cfg: { tools: { media: { audio: {} } } } as OpenClawConfig,
            ctx,
            attachment: requireFirstAttachment(media),
            cache,
            config: {} as never,
          }),
        ).rejects.toThrow("ffmpeg conversion failed");
      },
    );

    expect(scratchDir).not.toBe("");
    await expect(fs.stat(scratchDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records the backend observed during a whisper.cpp model run", async () => {
    runExecMock.mockImplementationOnce(async (_command, args: string[]) => {
      await fs.writeFile(`${args[2]}.txt`, "observed transcript\n");
      return {
        stdout: "",
        stderr: "whisper_backend_init_gpu: using MTL0 backend",
      };
    });

    const result = await runAudioEntry({
      command: "whisper-cli",
      args: ["-otxt", "-of", "{{OutputBase}}", "{{MediaPath}}"],
    });

    expect(result).toMatchObject({
      provider: "whisper-cli",
      model: "whisper-cli",
      observedBackend: "metal",
      text: "observed transcript",
    });
  });

  it("reads parakeet txt output selected through its upstream environment", async () => {
    const testCase: TranscriptFileCase = {
      name: "parakeet environment output",
      command: "parakeet-mlx",
      args: ["{{MediaPath}}", "--output-dir", "{{OutputDir}}"],
      resolvePath: (args) => path.join(args[2] ?? "", `${path.parse(args[0] ?? "").name}.txt`),
    };
    runExecMock.mockImplementationOnce(async (_command, args: string[]) => {
      await fs.writeFile(testCase.resolvePath(args), "environment transcript\n");
      return { stdout: "Transcribing...\n", stderr: "" };
    });

    const result = await withEnvAsync(
      { PARAKEET_OUTPUT_FORMAT: "txt", PARAKEET_OUTPUT_TEMPLATE: undefined },
      async () => await runAudioEntry(testCase),
    );

    expect(result?.text).toBe("environment transcript");
  });

  it.each(
    transcriptFileCases.flatMap((testCase) =>
      (["empty", "missing", "artifact"] as const).map((fileState) =>
        Object.assign({ fileState }, testCase),
      ),
    ),
  )("treats $fileState $name transcript output as empty", async (testCase) => {
    runExecMock.mockImplementationOnce(async (_command, args: string[]) => {
      if (testCase.fileState !== "missing") {
        await fs.writeFile(
          testCase.resolvePath(args),
          testCase.fileState === "artifact" ? "context:" : "  \n",
        );
      }
      return { stdout: "Transcribing with Whisper...\n", stderr: "" };
    });

    await expect(runAudioEntry(testCase)).resolves.toBeNull();
  });

  it.each([
    {
      name: "generic Node wrapper",
      command: "node",
      args: [
        "./skills/local-whisper/transcribe.js",
        "{{MediaPath}}",
        "--output-dir",
        "{{OutputDir}}",
      ],
    },
    {
      name: "parakeet default srt output",
      command: "parakeet-mlx",
      args: ["{{MediaPath}}", "--output-dir", "{{OutputDir}}"],
    },
    {
      name: "parakeet custom output template",
      command: "parakeet-mlx",
      args: [
        "{{MediaPath}}",
        "--output-format",
        "txt",
        "--output-dir",
        "{{OutputDir}}",
        "--output-template",
        "custom-{filename}",
      ],
    },
  ])("preserves stdout for $name without an inferred file contract", async (testCase) => {
    const result = await runAudioEntry(testCase);

    expect(result?.text).toBe("cli transcript");
  });

  it("surfaces unexpected transcript file read errors", async () => {
    const testCase = transcriptFileCases[0];
    if (!testCase) {
      throw new Error("missing transcript file test case");
    }
    runExecMock.mockImplementationOnce(async (_command, args: string[]) => {
      await fs.mkdir(testCase.resolvePath(args));
      return { stdout: "Transcribing...\n", stderr: "" };
    });

    await expect(runAudioEntry(testCase)).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("treats sherpa structured JSON with empty text as empty output", async () => {
    runExecMock.mockResolvedValueOnce({
      stdout:
        '{"lang":"","emotion":"","event":"","text":"","timestamps":[],"durations":[],"tokens":[],"ys_log_probs":[],"words":[]}',
      stderr: "",
    });

    await withAudioFixture("openclaw-cli-audio-empty-sherpa", async ({ ctx, media, cache }) => {
      const result = await runCliEntry({
        capability: "audio",
        entry: {
          type: "cli",
          command: "sherpa-onnx-offline",
          args: ["{{MediaPath}}"],
        },
        cfg: { tools: { media: { audio: {} } } } as OpenClawConfig,
        ctx,
        attachment: requireFirstAttachment(media),
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

    await withAudioFixture("openclaw-cli-audio-sherpa-json", async ({ ctx, media, cache }) => {
      const result = await runCliEntry({
        capability: "audio",
        entry: {
          type: "cli",
          command: "sherpa-onnx-offline",
          args: ["{{MediaPath}}"],
        },
        cfg: { tools: { media: { audio: {} } } } as OpenClawConfig,
        ctx,
        attachment: requireFirstAttachment(media),
        cache,
        config: {} as never,
      });

      expect(result?.text).toBe("sherpa transcript");
    });
  });
});
