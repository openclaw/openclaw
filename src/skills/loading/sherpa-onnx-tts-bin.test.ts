// Sherpa ONNX TTS binary tests cover bundled skill binary references and availability.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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

// The executable fixture uses a POSIX shebang; parser-only cases above remain portable.
it.skipIf(process.platform === "win32")(
  "rejects incomplete options before invocation and preserves paths and text",
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sherpa-argv-"));
    try {
      const runtime = path.join(root, "runtime space");
      const model = path.join(root, "model space");
      fs.mkdirSync(path.join(runtime, "bin"), { recursive: true });
      fs.mkdirSync(path.join(model, "espeak-ng-data"), { recursive: true });
      fs.writeFileSync(path.join(model, "model.onnx"), "");
      fs.writeFileSync(path.join(model, "tokens.txt"), "");
      const calls = path.join(root, "calls.json");
      fs.writeFileSync(
        path.join(runtime, "bin", "sherpa-onnx-offline-tts"),
        "#!" +
          process.execPath +
          "\nrequire('node:fs').writeFileSync(" +
          JSON.stringify(calls) +
          ", JSON.stringify(process.argv.slice(2)));",
        { mode: 0o755 },
      );
      const sentinel = path.join(root, "tts.wav");
      fs.writeFileSync(sentinel, "untouched");
      const run = (args: string[]) =>
        spawnSync(
          process.execPath,
          [path.resolve("skills/sherpa-onnx-tts/bin/sherpa-onnx-tts"), ...args],
          {
            cwd: root,
            encoding: "utf8",
            env: { ...process.env, SHERPA_ONNX_RUNTIME_DIR: runtime, SHERPA_ONNX_MODEL_DIR: model },
          },
        );
      for (const option of [
        "--runtime-dir",
        "--model-dir",
        "--model-file",
        "--tokens-file",
        "--data-dir",
        "--output",
        "-o",
        "--text",
      ]) {
        for (const suffix of [[], [""], ["--output", "other.wav"], ["-o", "other.wav"]]) {
          expect(
            run(["hello", option, ...suffix]).status,
            JSON.stringify([option, ...suffix]),
          ).toBe(1);
          expect(fs.existsSync(calls)).toBe(false);
          expect(fs.readFileSync(sentinel, "utf8")).toBe("untouched");
        }
      }
      for (const output of [[], ["--output", "output space.wav"], ["-o", "short.wav"]]) {
        expect(
          run([
            "--runtime-dir",
            runtime,
            "--model-dir",
            model,
            "--model-file",
            path.join(model, "model.onnx"),
            "--tokens-file",
            path.join(model, "tokens.txt"),
            "--data-dir",
            path.join(model, "espeak-ng-data"),
            ...output,
            "--text",
            "hello - world",
          ]).status,
        ).toBe(0);
        expect(JSON.parse(fs.readFileSync(calls, "utf8"))).toEqual([
          "--vits-model=" + path.join(model, "model.onnx"),
          "--vits-tokens=" + path.join(model, "tokens.txt"),
          "--vits-data-dir=" + path.join(model, "espeak-ng-data"),
          "--output-filename=" + path.join(root, output[1] ?? "tts.wav"),
          "hello - world",
        ]);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
