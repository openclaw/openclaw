import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { MediaUnderstandingModelConfig } from "../config/types.tools.js";
import * as globals from "../globals.js";
import { logWarn } from "../logger.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
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
type Overrides = Pick<Parameters<typeof runCliEntry>[0], "assertCurrent" | "config" | "request">;

function runFixture(
  { ctx, media, cache }: Fixture,
  entry: MediaUnderstandingModelConfig,
  options: Overrides = {},
) {
  const attachment = expectDefined(media[0], "audio attachment");
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

function expectExec(
  command: string,
  args: unknown[],
  options: unknown = { timeoutMs: 60_000, maxBuffer: CLI_OUTPUT_MAX_BUFFER },
) {
  expect(runExecMock).toHaveBeenCalledExactlyOnceWith(command, args, options);
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
type FileCase = [
  name: string,
  command: string,
  args: string[],
  path: (args: string[]) => string,
  text: string | null,
  requested?: string,
  observed?: string,
];
const transcriptFileCases: FileCase[] = [
  [
    "whisper.cpp short flags and observed Metal device",
    whisper.command,
    [...whisper.args, "--device", "GPU0"],
    (args) => `${args[2]}.txt`,
    "file transcript",
    "device:GPU0",
    "metal",
  ],
  [
    "whisper.cpp long flags and CPU request",
    whisper.command,
    ["--output-txt", "--output-file={{OutputBase}}", "{{MediaPath}}", "--no-gpu"],
    (args) => `${args[1]?.slice("--output-file=".length)}.txt`,
    "file transcript",
    "cpu",
  ],
  [
    "missing OpenAI Whisper explicit txt",
    "whisper",
    ["{{MediaPath}}", "--output_format=txt", "--output_dir={{OutputDir}}"],
    (args) =>
      path.join(
        args[2]?.slice("--output_dir=".length) ?? "",
        `${path.parse(args[0] ?? "").name}.txt`,
      ),
    null,
  ],
  [
    "artifact-only OpenAI Whisper default all output",
    "whisper",
    ["-o", "{{OutputDir}}", "{{MediaPath}}"],
    (args) => path.join(args[1] ?? "", `${path.parse(args[2] ?? "").name}.txt`),
    "context:",
  ],
  [
    "parakeet environment-selected output",
    "parakeet-mlx",
    ["{{MediaPath}}", "--output-dir", "{{OutputDir}}"],
    (args) => path.join(args[2] ?? "", `${path.parse(args[0] ?? "").name}.txt`),
    "file transcript",
  ],
];

beforeEach(() => {
  runExecMock.mockReset().mockResolvedValue({ stdout: "cli transcript" });
  runFfmpegMock.mockReset();
});
afterEach(() => vi.clearAllMocks());

it.each([
  ["cli-missing-command", undefined, false],
  ["cli-missing-attachment-arg", "invalid-transcribe", true],
] as const)("reports %s and handles configured fallback", async (reason, command, fallback) => {
  await withAudioFixture("openclaw-cli-invalid", async (fixture) => {
    const invalid: MediaUnderstandingModelConfig = {
      type: "cli",
      command,
      capabilities: ["audio"],
    };
    await expect(runFixture(fixture, invalid)).rejects.toMatchObject({ reason });
    const working: MediaUnderstandingModelConfig = {
      type: "cli",
      command: "working-transcribe",
      args: ["{{ AttachmentPath }}"],
      capabilities: ["audio"],
    };
    const result = await runModels(fixture, fallback ? [invalid, working] : [invalid]);
    expect(result.decision).toMatchObject({
      outcome: fallback ? "success" : "failed",
      attachmentProcessing: { 0: fallback ? "completed" : "omitted" },
      attachmentDispositions: { 0: { kind: fallback ? "handled" : "failed" } },
    });
    const failed = { type: "cli", outcome: "failed", reason: expect.stringContaining(reason) };
    expect(result.decision.attachments[0]?.attempts).toMatchObject(
      fallback
        ? [failed, { type: "cli", provider: "working-transcribe", outcome: "success" }]
        : [failed],
    );
    if (fallback) {
      expect(result.outputs[0]?.text).toBe("cli transcript");
      expectExec("working-transcribe", [expect.any(String)], expect.any(Object));
    } else {
      expect(result.outputs).toEqual([]);
      expect(logWarn).toHaveBeenCalledWith(expect.stringContaining(reason));
      expect(runExecMock).not.toHaveBeenCalled();
      expect(runFfmpegMock).not.toHaveBeenCalled();
    }
  });
});

it("preserves custom arguments relative to the attachment working directory", async () => {
  await withAudioFixture("openclaw-cli-custom-input", async (fixture) => {
    const args = ["describe", path.basename(fixture.mediaPath)];
    expect((await runFixture(fixture, { command: "agy", args }))?.text).toBe("cli transcript");
    expectExec(
      "agy",
      args,
      expect.objectContaining({ cwd: path.dirname(await fs.realpath(fixture.mediaPath)) }),
    );
  });
});

it("uses capability language and entry prompt precedence without logging prompts", async () => {
  const verbose = vi.spyOn(globals, "shouldLogVerbose").mockReturnValue(true);
  const log = vi.spyOn(globals, "logVerbose").mockImplementation(() => {});
  try {
    await runAudioEntry(
      {
        command: "mock-transcriber",
        args: ["--prompt", "{{Prompt}}", "--language", "{{Language}}", "--file", "{{MediaPath}}"],
        prompt: "entry prompt",
      },
      { config: { prompt: "configured prompt", language: "fr" } },
    );
    expectExec("mock-transcriber", [
      "--prompt",
      "entry prompt",
      "--language",
      "fr",
      "--file",
      expect.any(String),
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("entry prompt");
  } finally {
    log.mockRestore();
    verbose.mockRestore();
  }
});

it("substitutes an unset language as an empty argument instead of dropping it", async () => {
  await runAudioEntry({
    command: "mock-transcriber",
    args: ["--language", "{{Language}}", "--file", "{{AttachmentPath}}"],
  });
  expectExec("mock-transcriber", ["--language", "", "--file", expect.any(String)]);
});

it.each(transcriptFileCases)(
  "honors %s transcript file authority",
  async (_name, command, args, resolvePath, text, requestedBackend, observedBackend) => {
    runExecMock.mockImplementationOnce(async (_command, argv: string[]) => {
      if (text !== null) {
        await fs.writeFile(resolvePath(argv), text);
      }
      return {
        stdout: "Transcribing...\n",
        stderr: observedBackend ? "whisper_backend_init_gpu: using MTL0 backend" : "",
      };
    });
    const result = await withEnvAsync(
      { PARAKEET_OUTPUT_FORMAT: "txt", PARAKEET_OUTPUT_TEMPLATE: undefined },
      () => runAudioEntry({ command, args }),
    );
    if (text === "file transcript") {
      expect(result).toMatchObject({ text, provider: command, model: command });
      expect(result?.requestedBackend).toBe(requestedBackend);
      expect(result?.observedBackend).toBe(observedBackend);
    } else {
      expect(result).toBeNull();
    }
  },
);

it("does not convert or transcribe when admission expires during attachment path resolution", async () => {
  const pathResolutionStarted = createDeferred();
  const releasePathResolution = createDeferred();
  await withMediaFixture(
    {
      filePrefix: "openclaw-cli-expired-admission",
      extension: "mp3",
      mediaType: "audio/mpeg",
      fileContents: createSafeAudioFixtureBuffer(),
    },
    async (fixture) => {
      const getPath = fixture.cache.getPath.bind(fixture.cache);
      vi.spyOn(fixture.cache, "getPath").mockImplementation(async (params) => {
        pathResolutionStarted.resolve();
        await releasePathResolution.promise;
        return await getPath(params);
      });
      let admitted = true;
      const assertCurrent = () => {
        if (!admitted) {
          throw new Error("admission expired");
        }
      };
      const transcription = runFixture(fixture, whisper, { assertCurrent });

      await pathResolutionStarted.promise;
      admitted = false;
      releasePathResolution.resolve();
      await expect(transcription).rejects.toThrow("admission expired");
      expect(runFfmpegMock).not.toHaveBeenCalled();
      expect(runExecMock).not.toHaveBeenCalled();
    },
  );
});

it.each([
  { language: "fr", expected: "fr" },
  { language: "fr", request: { language: "es" }, expected: "es" },
  { language: "fr", config: { language: "de" }, expected: "de" },
  { expected: undefined },
  { language: "fr", request: { language: "" }, expected: undefined },
  { command: "whisper-cli", language: "fr", expected: undefined },
])("forwards auto-discovered Whisper language: %j", async (options) => {
  await withTestDir({ prefix: "openclaw-auto-language-" }, async (dir) => {
    const command = options.command ?? "whisper";
    await fs.writeFile(
      path.join(dir, `${command}${process.platform === "win32" ? ".cmd" : ""}`),
      "synthetic executable",
      { mode: 0o755 },
    );
    const model = path.join(dir, "model.bin");
    await fs.writeFile(model, "synthetic model");
    runExecMock.mockImplementation(async (_executable, args: string[]) => {
      if (command === "whisper") {
        await fs.writeFile(
          path.join(
            expectDefined(args[args.indexOf("--output_dir") + 1], "Whisper output directory"),
            `${path.parse(args.at(-1) ?? "").name}.txt`,
          ),
          "fixture transcript",
        );
      } else if (args.includes("-of")) {
        await fs.writeFile(`${args[args.indexOf("-of") + 1]}.txt`, "fixture transcript");
      }
      return { stdout: "", stderr: "" };
    });
    await withAudioFixture("openclaw-auto-language", async ({ ctx, media, cache }) => {
      const result = await withEnvAsync(
        { PATH: dir, WHISPER_CPP_MODEL: model, SHERPA_ONNX_MODEL_DIR: undefined },
        () =>
          runCapability({
            capability: "audio",
            cfg: { tools: { media: { audio: { language: options.language } } } },
            ctx,
            media,
            attachments: cache,
            providerRegistry: new Map(),
            request: options.request,
            config: options.config,
          }),
      );
      expect(result.outputs[0]?.text).toBe("fixture transcript");
    });
    const args = runExecMock.mock.calls.find(
      ([executable]) =>
        executable === path.join(dir, command) || executable === path.join(dir, `${command}.cmd`),
    )?.[1];
    expect(args).toBeDefined();
    if (options.expected === undefined) {
      expect(args).not.toContain("--language");
    } else {
      expect(args.filter((arg: string) => arg === "--language")).toHaveLength(1);
      expect(args[args.indexOf("--language") + 1]).toBe(options.expected);
    }
    expect(args).not.toContain("{{Language}}");
  });
});

it.each([
  ["{{Language}}", "de", { language: "en" }, "en"],
  ["{{Language}}", "de", undefined, "de"],
  ["it", "de", { language: "en" }, "it"],
  [undefined, undefined, { language: "en" }, undefined],
] as const)("preserves explicit CLI language %s", async (value, language, request, expected) => {
  const args = [...(value === undefined ? [] : ["--language", value]), "{{AttachmentPath}}"];
  await runAudioEntry(
    { command: "whisper", args, language },
    { config: { language: "fr" }, request },
  );
  expect(runExecMock.mock.calls[0]?.[1]).toEqual([
    ...(expected === undefined ? [] : ["--language", expected]),
    expect.any(String),
  ]);
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

it.each([
  { executionFails: false, cleanupFails: false },
  { executionFails: false, cleanupFails: true },
  { executionFails: true, cleanupFails: false },
  { executionFails: true, cleanupFails: true },
])(
  "preserves the CLI result and reports scratch cleanup: %j",
  async ({ executionFails, cleanupFails }) => {
    let scratchDir = "";
    let retainedDir = "";
    const executionError = new Error("fixture CLI execution failed");
    const cleanupError = new Error("fixture scratch removal denied");
    const rm = fs.rm.bind(fs);
    const remove = vi.spyOn(fs, "rm").mockImplementation((target, options) => {
      if (target === scratchDir && cleanupFails) {
        retainedDir = scratchDir;
        return Promise.reject(cleanupError);
      }
      return rm(target, options);
    });
    runExecMock.mockImplementationOnce(async (_command, argv: string[]) => {
      scratchDir = path.dirname(expectDefined(argv[2], "CLI output base"));
      if (executionFails) {
        throw executionError;
      }
      await fs.writeFile(`${argv[2]}.txt`, "cli transcript");
      return { stdout: "" };
    });
    try {
      await withAudioFixture("openclaw-cli-scratch", async (fixture) => {
        const result = runFixture(fixture, whisper);
        if (executionFails) {
          await expect(result).rejects.toBe(executionError);
        } else {
          expect((await result)?.text).toBe("cli transcript");
        }
      });
      expect(scratchDir).not.toBe("");
      if (cleanupFails) {
        expect((await fs.stat(scratchDir)).isDirectory()).toBe(true);
        expect(logWarn).toHaveBeenCalledExactlyOnceWith(
          `media-understanding: failed to remove CLI temporary directory ${scratchDir}: ${String(cleanupError)}; remove it manually.`,
        );
      } else {
        await expect(fs.stat(scratchDir)).rejects.toMatchObject({ code: "ENOENT" });
        expect(logWarn).not.toHaveBeenCalled();
      }
    } finally {
      remove.mockRestore();
      if (retainedDir) {
        await rm(retainedDir, { recursive: true, force: true });
      }
    }
  },
);

it("preserves parakeet stdout for default srt output without a file contract", async () => {
  const result = await withEnvAsync(
    { PARAKEET_OUTPUT_FORMAT: undefined, PARAKEET_OUTPUT_TEMPLATE: undefined },
    () =>
      runAudioEntry({
        command: "parakeet-mlx",
        args: ["{{MediaPath}}", "--output-dir", "{{OutputDir}}"],
      }),
  );
  expect(result?.text).toBe("cli transcript");
});

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
