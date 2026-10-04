import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaUnderstandingModelConfig } from "../config/types.tools.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runCapability } from "./runner.js";
import { withAudioFixture } from "./runner.test-utils.js";

const runExecMock = vi.hoisted(() => vi.fn<typeof import("../process/exec.js").runExec>());
// mock-isolation: Record argv without executing synthetic local audio binaries or host tools.
vi.mock("../process/exec.js", () => ({ runExec: runExecMock }));

type RunParams = Parameters<typeof runCapability>[0];

async function runLocalAudio(options: {
  command?: "whisper" | "whisper-cli";
  language?: string;
  request?: RunParams["request"];
  config?: RunParams["config"];
  entry?: MediaUnderstandingModelConfig;
}) {
  return withTestDir({ prefix: "openclaw-auto-language-" }, async (dir) => {
    const command = path.join(
      dir,
      `${options.command ?? "whisper"}${process.platform === "win32" ? ".cmd" : ""}`,
    );
    // Discovery sees a file on PATH; only the existing runExec boundary is mocked.
    await fs.writeFile(command, "synthetic executable", { mode: 0o755 });
    const model = path.join(dir, "model.bin");
    await fs.writeFile(model, "synthetic model");
    runExecMock.mockImplementation(async (executable: string, args: string[]) => {
      const outputDir = args[args.indexOf("--output_dir") + 1];
      const outputBase = args[args.indexOf("-of") + 1];
      if (path.parse(executable).name === "whisper" && args.includes("--output_dir")) {
        await fs.writeFile(
          path.join(
            expectDefined(outputDir, "Whisper output directory"),
            `${path.parse(args.at(-1) ?? "").name}.txt`,
          ),
          "fixture transcript",
        );
      } else if (args.includes("-of")) {
        await fs.writeFile(
          `${expectDefined(outputBase, "whisper.cpp output base")}.txt`,
          "fixture transcript",
        );
      }
      return { stdout: "fixture transcript", stderr: "" };
    });
    await withAudioFixture("openclaw-auto-language", async ({ ctx, media, cache }) => {
      await withEnvAsync(
        {
          PATH: dir,
          WHISPER_CPP_MODEL: model,
          SHERPA_ONNX_MODEL_DIR: undefined,
          OPENCLAW_STATE_DIR: dir,
        },
        async () => {
          const result = await runCapability({
            capability: "audio",
            cfg: {
              tools: {
                media: {
                  audio: { language: options.language },
                  models: options.entry ? [{ ...options.entry, capabilities: ["audio"] }] : [],
                },
              },
            },
            ctx,
            media,
            attachments: cache,
            providerRegistry: new Map(),
            request: options.request,
            config: options.config,
          });
          expect(result.outputs[0]?.text).toBe("fixture transcript");
        },
      );
    });
    const calls = runExecMock.mock.calls.filter(
      ([executable]) => executable !== "readelf" && executable !== "otool",
    );
    expect(calls).toHaveLength(1);
    const call = expectDefined(calls[0], "local audio CLI call");
    return { command, args: call[1] };
  });
}

describe("automatic local audio language arguments", () => {
  beforeEach(() => {
    runExecMock.mockReset();
  });

  it.each([
    { name: "capability default", language: "fr", expected: "fr" },
    { name: "request override", language: "fr", request: { language: "es" }, expected: "es" },
    { name: "runtime config", language: "fr", config: { language: "de" }, expected: "de" },
    { name: "unset language", expected: undefined },
    { name: "empty capability", language: "", expected: undefined },
    { name: "empty request", language: "fr", request: { language: "" }, expected: undefined },
    { name: "whitespace request", language: "fr", request: { language: " " }, expected: " " },
  ])("passes Python Whisper $name at the CLI boundary", async ({ expected, ...options }) => {
    const { args } = await runLocalAudio(options);
    if (expected === undefined) {
      expect(args).not.toContain("--language");
    } else {
      expect(args.filter((arg) => arg === "--language")).toHaveLength(1);
      expect(args[args.indexOf("--language") + 1]).toBe(expected);
    }
    expect(args).not.toContain("{{Language}}");
    expect(args).toEqual([
      "--model",
      "turbo",
      "--output_format",
      "txt",
      "--output_dir",
      expect.any(String),
      "--verbose",
      "False",
      ...(expected === undefined ? [] : ["--language", expected]),
      expect.stringMatching(/\.wav$/),
    ]);
  });

  it.each([
    { name: "request", language: "de", request: { language: "en" }, expected: "en" },
    { name: "entry", language: "de", expected: "de" },
    { name: "capability", expected: "fr" },
  ])("preserves explicit custom CLI $name precedence", async ({ language, request, expected }) => {
    const { args } = await runLocalAudio({
      language: "fr",
      request,
      entry: {
        command: "custom-transcriber",
        language,
        args: ["--language", "{{Language}}", "{{AttachmentPath}}"],
      },
    });
    expect(args).toEqual(["--language", expected, expect.stringMatching(/\.wav$/)]);
  });

  it("preserves explicit custom Python Whisper arguments", async () => {
    const { args } = await runLocalAudio({
      language: "fr",
      request: { language: "en" },
      entry: {
        command: "whisper",
        language: "de",
        args: ["--language", "it", "{{AttachmentPath}}"],
      },
    });
    expect(args).toEqual(["--language", "it", expect.stringMatching(/\.wav$/)]);
  });

  it("does not change custom CLI arguments without a language template", async () => {
    const { args } = await runLocalAudio({
      language: "fr",
      request: { language: "en" },
      entry: { command: "whisper", args: ["{{AttachmentPath}}"] },
    });
    expect(args).toEqual([expect.stringMatching(/\.wav$/)]);
  });

  it("does not add Python language arguments to autodetected whisper.cpp", async () => {
    const { args } = await runLocalAudio({ command: "whisper-cli", language: "fr" });
    expect(args).toEqual([
      "-m",
      expect.stringMatching(/model\.bin$/),
      "-otxt",
      "-of",
      expect.any(String),
      "-nt",
      expect.stringMatching(/\.wav$/),
    ]);
  });
});
