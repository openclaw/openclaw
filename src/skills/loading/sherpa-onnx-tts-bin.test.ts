// Sherpa ONNX TTS binary tests cover bundled skill binary references and availability.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDirSync } from "../../test-helpers/temp-dir.js";

describe("skills/sherpa-onnx-tts bin script", () => {
  it.skipIf(process.platform === "win32").each(["flags", "env"])(
    "preserves literal runtime and model directories from %s",
    (source) => {
      withTempDirSync({ prefix: "sherpa-paths-" }, (root) => {
        const runtimeDir = path.join(root, "runtime ");
        const modelDir = path.join(root, "model ");
        const binary = path.join(runtimeDir, "bin", "sherpa-onnx-offline-tts");
        fs.mkdirSync(path.dirname(binary), { recursive: true });
        fs.mkdirSync(path.join(modelDir, "espeak-ng-data"), { recursive: true });
        fs.writeFileSync(path.join(modelDir, "voice.onnx"), "model fixture");
        fs.writeFileSync(path.join(modelDir, "tokens.txt"), "tokens fixture");
        fs.writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
        const env = Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith("SHERPA_ONNX_")),
        );
        if (source === "env") {
          env.SHERPA_ONNX_RUNTIME_DIR = runtimeDir;
          env.SHERPA_ONNX_MODEL_DIR = modelDir;
        }
        const output = path.join(root, "speech .wav");
        const result = spawnSync(
          process.execPath,
          [
            path.resolve("skills/sherpa-onnx-tts/bin/sherpa-onnx-tts"),
            ...(source === "flags" ? ["--runtime-dir", runtimeDir, "--model-dir", modelDir] : []),
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
            `--vits-model=${path.join(modelDir, "voice.onnx")}`,
            `--vits-tokens=${path.join(modelDir, "tokens.txt")}`,
            `--vits-data-dir=${path.join(modelDir, "espeak-ng-data")}`,
            `--output-filename=${output}`,
            "Hello.",
            "",
          ].join("\n"),
        );
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
