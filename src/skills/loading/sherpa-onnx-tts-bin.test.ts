// Sherpa ONNX TTS binary tests cover bundled skill binary references and availability.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
});
