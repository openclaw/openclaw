import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaUnderstandingModelConfig } from "../config/types.tools.js";
import { logWarn } from "../logger.js";
import { withEnvAsync } from "../test-utils/env.js";
import { CLI_OUTPUT_MAX_BUFFER } from "./defaults.constants.js";
import { runCliEntry } from "./runner.entries.js";
import { runCapability } from "./runner.js";
import {
  createSafeAudioFixtureBuffer,
  withAudioFixture,
  withMediaFixture,
} from "./runner.test-utils.js";

const runExecMock = vi.hoisted(() => vi.fn());
const runFfmpegMock = vi.hoisted(() => vi.fn());
vi.mock("../logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logger.js")>()),
  logWarn: vi.fn(),
}));
vi.mock("../process/exec.js", () => ({ runExec: (...args: unknown[]) => runExecMock(...args) }));
vi.mock("../media/media-services.js", () => ({
  runFfmpeg: (...args: unknown[]) => runFfmpegMock(...args),
}));

type Fixture = Parameters<Parameters<typeof withAudioFixture>[1]>[0];
type Overrides = Pick<Parameters<typeof runCliEntry>[0], "config" | "request">;

function runFixture(
  { ctx, media, cache }: Fixture,
  entry: MediaUnderstandingModelConfig,
  options: Overrides = {},
) {
  const attachment = media[0];
  if (!attachment) {
    throw new Error("expected audio attachment");
  }
  return runCliEntry({ capability: "audio", entry, cfg: {}, ctx, attachment, cache, ...options });
}

async function runAudioEntry(
  entry: MediaUnderstandingModelConfig,
  options?: Overrides,
): Promise<Awaited<ReturnType<typeof runCliEntry>>> {
  let result: Awaited<ReturnType<typeof runCliEntry>> = null;
  await withAudioFixture("openclaw-cli-audio", async (fixture) => {
    result = await runFixture(fixture, entry, options);
  });
  return result;
}

function runModels({ ctx, media, cache }: Fixture, models: MediaUnderstandingModelConfig[]) {
  return runCapability({
    capability: "audio",
    cfg: { tools: { media: { models } } },
    ctx,
    media,
    attachments: cache,
    providerRegistry: new Map(),
  });
}

const whisper = {
  command: "whisper-cli",
  args: ["-otxt", "-of", "{{OutputBase}}", "{{MediaPath}}"],
};
const transcriptFileCases: Array<{
  name: string;
  command: string;
  args: string[];
  resolvePath: (args: string[]) => string;
  text: string | null;
  requestedBackend?: string;
  observedBackend?: string;
}> = [
  {
    name: "whisper.cpp short flags and observed Metal device",
    ...whisper,
    args: [...whisper.args, "--device", "GPU0"],
    resolvePath: (args) => `${args[2]}.txt`,
    text: "file transcript",
    requestedBackend: "device:GPU0",
    observedBackend: "metal",
  },
  {
    name: "whisper.cpp long flags and CPU request",
    command: "whisper-cli",
    args: ["--output-txt", "--output-file={{OutputBase}}", "{{MediaPath}}", "--no-gpu"],
    resolvePath: (args) => `${args[1]?.slice("--output-file=".length)}.txt`,
    text: "file transcript",
    requestedBackend: "cpu",
  },
  {
    name: "missing OpenAI Whisper explicit txt",
    command: "whisper",
    args: ["{{MediaPath}}", "--output_format=txt", "--output_dir={{OutputDir}}"],
    resolvePath: (args) =>
      path.join(
        args[2]?.slice("--output_dir=".length) ?? "",
        `${path.parse(args[0] ?? "").name}.txt`,
      ),
    text: null,
  },
  {
    name: "artifact-only OpenAI Whisper default all output",
    command: "whisper",
    args: ["-o", "{{OutputDir}}", "{{MediaPath}}"],
    resolvePath: (args) => path.join(args[1] ?? "", `${path.parse(args[2] ?? "").name}.txt`),
    text: "context:",
  },
  {
    name: "parakeet environment-selected output",
    command: "parakeet-mlx",
    args: ["{{MediaPath}}", "--output-dir", "{{OutputDir}}"],
    resolvePath: (args) => path.join(args[2] ?? "", `${path.parse(args[0] ?? "").name}.txt`),
    text: "file transcript",
  },
];

describe("media-understanding CLI audio entry", () => {
  beforeEach(() => {
    runExecMock.mockReset().mockResolvedValue({ stdout: "cli transcript" });
    runFfmpegMock.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  it("reports a missing command as unavailable without executing it", async () => {
    await withAudioFixture("openclaw-cli-unavailable", async (fixture) => {
      const entry: MediaUnderstandingModelConfig = { type: "cli" };
      await expect(runFixture(fixture, entry)).rejects.toMatchObject({
        reason: "cli-missing-command",
      });
      const result = await runModels(fixture, [{ ...entry, capabilities: ["audio"] }]);
      expect(result.outputs).toEqual([]);
      expect(result.decision).toMatchObject({
        outcome: "failed",
        attachmentProcessing: { 0: "omitted" },
        attachmentDispositions: { 0: { kind: "failed" } },
      });
      expect(result.decision.attachments[0]?.attempts).toMatchObject([
        { type: "cli", outcome: "failed", reason: expect.stringContaining("cli-missing-command") },
      ]);
      expect(logWarn).toHaveBeenCalledWith(expect.stringContaining("cli-missing-command"));
      expect(runExecMock).not.toHaveBeenCalled();
      expect(runFfmpegMock).not.toHaveBeenCalled();
    });
  });

  it("continues to a working CLI after an entry with missing args", async () => {
    await withAudioFixture("openclaw-cli-fallback", async (fixture) => {
      const invalid: MediaUnderstandingModelConfig = {
        type: "cli",
        command: "invalid-transcribe",
        capabilities: ["audio"],
      };
      await expect(runFixture(fixture, invalid)).rejects.toMatchObject({
        reason: "cli-missing-attachment-arg",
      });
      const working: MediaUnderstandingModelConfig = {
        type: "cli",
        command: "working-transcribe",
        args: ["{{ AttachmentPath }}"],
        capabilities: ["audio"],
      };
      const result = await runModels(fixture, [invalid, working]);
      expect(result.outputs[0]?.text).toBe("cli transcript");
      expect(result.decision).toMatchObject({
        outcome: "success",
        attachmentProcessing: { 0: "completed" },
        attachmentDispositions: { 0: { kind: "handled" } },
      });
      expect(result.decision.attachments[0]?.attempts).toMatchObject([
        {
          type: "cli",
          outcome: "failed",
          reason: expect.stringContaining("cli-missing-attachment-arg"),
        },
        { type: "cli", provider: "working-transcribe", outcome: "success" },
      ]);
      expect(runExecMock).toHaveBeenCalledExactlyOnceWith(
        "working-transcribe",
        [expect.any(String)],
        expect.any(Object),
      );
    });
  });

  it("preserves custom arguments relative to the attachment working directory", async () => {
    await withAudioFixture("openclaw-cli-custom-input", async (fixture) => {
      const args = ["describe", path.basename(fixture.mediaPath)];
      expect((await runFixture(fixture, { command: "agy", args }))?.text).toBe("cli transcript");
      expect(runExecMock).toHaveBeenCalledExactlyOnceWith(
        "agy",
        args,
        expect.objectContaining({ cwd: path.dirname(await fs.realpath(fixture.mediaPath)) }),
      );
    });
  });

  it.each<[string, string | undefined, Overrides["request"], string, string]>([
    ["capability", undefined, undefined, "fr", "entry prompt"],
  ])(
    "uses %s language and prompt precedence",
    async (_source, language, request, expected, prompt) => {
      await runAudioEntry(
        {
          command: "mock-transcriber",
          args: ["--prompt", "{{Prompt}}", "--language", "{{Language}}", "--file", "{{MediaPath}}"],
          prompt: "entry prompt",
          language,
        },
        { config: { prompt: "configured prompt", language: "fr" }, request },
      );
      expect(runExecMock).toHaveBeenCalledExactlyOnceWith(
        "mock-transcriber",
        ["--prompt", prompt, "--language", expected, "--file", expect.any(String)],
        { timeoutMs: 60_000, maxBuffer: CLI_OUTPUT_MAX_BUFFER },
      );
    },
  );

  it.each(transcriptFileCases)("honors $name transcript file authority", async (testCase) => {
    runExecMock.mockImplementationOnce(async (_command, args: string[]) => {
      if (testCase.text !== null) {
        await fs.writeFile(testCase.resolvePath(args), testCase.text);
      }
      return {
        stdout: "Transcribing...\n",
        stderr: testCase.observedBackend ? "whisper_backend_init_gpu: using MTL0 backend" : "",
      };
    });
    const result = await withEnvAsync(
      { PARAKEET_OUTPUT_FORMAT: "txt", PARAKEET_OUTPUT_TEMPLATE: undefined },
      async () => await runAudioEntry(testCase),
    );
    if (testCase.text === "file transcript") {
      expect(result).toMatchObject({
        text: "file transcript",
        provider: testCase.command,
        model: testCase.command,
      });
      expect(result?.requestedBackend).toBe(testCase.requestedBackend);
      expect(result?.observedBackend).toBe(testCase.observedBackend);
    } else {
      expect(result).toBeNull();
    }
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
        filePrefix: "openclaw-cli-conversion",
        extension: "mp3",
        mediaType: "audio/mpeg",
        fileContents: createSafeAudioFixtureBuffer(),
      },
      async (fixture) => {
        await expect(runFixture(fixture, whisper)).rejects.toThrow("ffmpeg conversion failed");
      },
    );
    expect(scratchDir).not.toBe("");
    await expect(fs.stat(scratchDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([{ name: "default srt output", extra: [] }])(
    "preserves parakeet stdout for $name without a file contract",
    async ({ extra }) => {
      const result = await withEnvAsync(
        { PARAKEET_OUTPUT_FORMAT: undefined, PARAKEET_OUTPUT_TEMPLATE: undefined },
        async () =>
          await runAudioEntry({
            command: "parakeet-mlx",
            args: ["{{MediaPath}}", "--output-dir", "{{OutputDir}}", ...extra],
          }),
      );
      expect(result?.text).toBe("cli transcript");
    },
  );

  it("surfaces unexpected transcript file read errors", async () => {
    runExecMock.mockImplementationOnce(async (_command, args: string[]) => {
      await fs.mkdir(`${args[2]}.txt`);
      return { stdout: "Transcribing...\n", stderr: "" };
    });
    await expect(runAudioEntry(whisper)).rejects.toMatchObject({ code: "EISDIR" });
  });

  it.each([
    {
      name: "empty structured output",
      stdout: '{"text":""}',
      args: ["{{MediaPath}}"],
      expected: null,
    },
    {
      name: "final structured line",
      stdout: 'loading model\n{"text":"sherpa transcript","tokens":["sherpa","transcript"]}\n',
      args: ["--provider=cuda", "{{MediaPath}}"],
      expected: { text: "sherpa transcript", requestedBackend: "cuda" },
    },
  ])("extracts sherpa $name", async ({ stdout, args, expected }) => {
    runExecMock.mockResolvedValueOnce({ stdout, stderr: "" });
    const result = await runAudioEntry({ command: "sherpa-onnx-offline", args });
    if (expected === null) {
      expect(result).toBeNull();
    } else {
      expect(result).toMatchObject(expected);
    }
  });
});
