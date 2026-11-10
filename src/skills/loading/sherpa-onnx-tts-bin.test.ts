// Sherpa ONNX TTS binary tests cover bundled skill binary references and availability.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDirSync } from "../../test-helpers/temp-dir.js";

describe("skills/sherpa-onnx-tts bin script", () => {
  it.skipIf(process.platform === "win32").each(["flags", "env"])(
    "preserves literal resource paths from %s, including model discovery",
    (source) => {
      withTempDirSync({ prefix: "sherpa-paths-" }, (root) => {
        const runtimeDir = path.join(root, "runtime ");
        const modelDir = path.join(root, "model ");
        const binary = path.join(runtimeDir, "bin", "sherpa-onnx-offline-tts");
        fs.mkdirSync(path.dirname(binary), { recursive: true });
        fs.mkdirSync(modelDir);
        fs.writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
        for (const explicit of [false, true]) {
          const modelFile = path.join(modelDir, explicit ? "voice.onnx " : "voice.onnx");
          const tokensFile = path.join(modelDir, explicit ? "tokens.txt " : "tokens.txt");
          const dataDir = path.join(modelDir, explicit ? "espeak-ng-data " : "espeak-ng-data");
          fs.writeFileSync(modelFile, "model fixture");
          fs.writeFileSync(tokensFile, "tokens fixture");
          fs.mkdirSync(dataDir);
          const paths = [
            ["RUNTIME_DIR", "--runtime-dir", runtimeDir],
            ["MODEL_DIR", "--model-dir", modelDir],
            ["MODEL_FILE", "--model-file", modelFile],
            ["TOKENS_FILE", "--tokens-file", tokensFile],
            ["DATA_DIR", "--data-dir", dataDir],
          ] as const;
          const selected = explicit ? paths : paths.slice(0, 2);
          const env = Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !key.startsWith("SHERPA_ONNX_")),
          );
          if (source === "env") {
            for (const [key, , value] of selected) {
              env[`SHERPA_ONNX_${key}`] = value;
            }
          }
          const output = path.join(root, "speech .wav");
          const result = spawnSync(
            process.execPath,
            [
              path.resolve("skills/sherpa-onnx-tts/bin/sherpa-onnx-tts"),
              ...(source === "flags" ? selected.flatMap(([, flag, value]) => [flag, value]) : []),
              "--output",
              output,
              "  Hello.  ",
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
        }
      });
    },
  );

  it("loads as ESM and falls through to usage output when env is missing", () => {
    const scriptPath = path.resolve(
      process.cwd(),
      "skills",
      "sherpa-onnx-tts",
      "bin",
      "sherpa-onnx-tts",
    );
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      'Missing runtime/model directory.\n\nUsage: sherpa-onnx-tts [--runtime-dir <dir>] [--model-dir <dir>] [--model-file <file>] [--tokens-file <file>] [--data-dir <dir>] [--output <file>] "text"\n\nRequired env (or flags):\n  SHERPA_ONNX_RUNTIME_DIR\n  SHERPA_ONNX_MODEL_DIR\n',
    );
  });
});
