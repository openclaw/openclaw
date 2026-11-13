// Sherpa ONNX TTS binary tests cover bundled skill binary references and availability.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDirSync } from "../../test-helpers/temp-dir.js";

describe("skills/sherpa-onnx-tts bin script", () => {
  it.each([
    [[], "Missing runtime/model directory.\n"],
    [["--output", "", "hi"], ""],
    [["--output", "--model-dir", "/tmp/model", "hi"], ""],
  ])("loads as ESM and exits with usage for %j", (args, reason) => {
    const scriptPath = path.resolve("skills", "sherpa-onnx-tts", "bin", "sherpa-onnx-tts");
    const result = spawnSync(process.execPath, [scriptPath, ...args], { encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      `${reason}\nUsage: sherpa-onnx-tts [--runtime-dir <dir>] [--model-dir <dir>] [--model-file <file>] [--tokens-file <file>] [--data-dir <dir>] [--output <file>] "text"\n\nRequired env (or flags):\n  SHERPA_ONNX_RUNTIME_DIR\n  SHERPA_ONNX_MODEL_DIR\n`,
    );
  });

  it.skipIf(process.platform === "win32").each(["flags", "env"])(
    "preserves literal model file, tokens file, and data dir from %s",
    (source) => {
      withTempDirSync({ prefix: "sherpa-resource-paths-" }, (root) => {
        const runtimeDir = path.join(root, "runtime");
        const modelDir = path.join(root, "model");
        const binary = path.join(runtimeDir, "bin", "sherpa-onnx-offline-tts");
        fs.mkdirSync(path.dirname(binary), { recursive: true });
        fs.mkdirSync(modelDir, { recursive: true });
        fs.writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });

        const modelFile = path.join(root, "voice .onnx");
        const tokensFile = path.join(root, "tokens .txt");
        const dataDir = path.join(root, "espeak data ");
        fs.writeFileSync(modelFile, "model fixture");
        fs.writeFileSync(tokensFile, "tokens fixture");
        fs.mkdirSync(dataDir, { recursive: true });

        const env = Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith("SHERPA_ONNX_")),
        );
        if (source === "env") {
          env.SHERPA_ONNX_RUNTIME_DIR = runtimeDir;
          env.SHERPA_ONNX_MODEL_DIR = modelDir;
          env.SHERPA_ONNX_MODEL_FILE = modelFile;
          env.SHERPA_ONNX_TOKENS_FILE = tokensFile;
          env.SHERPA_ONNX_DATA_DIR = dataDir;
        }

        const flagArgs =
          source === "flags"
            ? [
                "--runtime-dir",
                runtimeDir,
                "--model-dir",
                modelDir,
                "--model-file",
                modelFile,
                "--tokens-file",
                tokensFile,
                "--data-dir",
                dataDir,
              ]
            : [];

        const output = path.join(root, "speech.wav");
        const result = spawnSync(
          process.execPath,
          [
            path.resolve("skills", "sherpa-onnx-tts", "bin", "sherpa-onnx-tts"),
            ...flagArgs,
            "--output",
            output,
            "Hello.",
          ],
          { encoding: "utf8", env },
        );

        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        expect(result.stdout).toBe(
          [
            `--vits-model=${modelFile}`,
            `--vits-tokens=${tokensFile}`,
            `--vits-data-dir=${dataDir}`,
            `--output-filename=${output}`,
            "Hello.",
            "",
          ].join("\n"),
        );
      });
    },
  );
});
