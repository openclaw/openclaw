import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearLocalAudioInspectionCacheForTests,
  inspectLocalAudioSelection,
  recordLocalAudioBackendObservation,
} from "./local-audio.js";

let tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-local-audio-"));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  clearLocalAudioInspectionCacheForTests();
  await Promise.all(tempDirs.map(async (tempDir) => await fs.rm(tempDir, { recursive: true })));
  tempDirs = [];
});

describe("local audio selection", () => {
  it("does not rank Metal-capable whisper ahead of sherpa until a run observes Metal", async () => {
    const tempDir = await createTempDir();
    const modelPath = path.join(tempDir, "whisper.bin");
    const sherpaDir = path.join(tempDir, "sherpa");
    await fs.writeFile(modelPath, "model");
    await fs.mkdir(sherpaDir);
    await Promise.all(
      ["tokens.txt", "encoder.onnx", "decoder.onnx", "joiner.onnx"].map(async (fileName) => {
        await fs.writeFile(path.join(sherpaDir, fileName), "model");
      }),
    );

    const selection = await inspectLocalAudioSelection({
      env: {
        WHISPER_CPP_MODEL: modelPath,
        SHERPA_ONNX_MODEL_DIR: sherpaDir,
      },
      platform: "darwin",
      arch: "arm64",
      resolveBinary: async (name) =>
        name === "whisper-cli"
          ? "/opt/homebrew/bin/whisper-cli"
          : name === "sherpa-onnx-offline"
            ? "/usr/local/bin/sherpa-onnx-offline"
            : null,
      resolveRealpath: async () => "/opt/homebrew/Cellar/whisper-cpp/1.9.1/bin/whisper-cli",
      inspectLinkedLibraries: async () => null,
    });

    expect(selection.selected).toMatchObject({
      id: "sherpa-onnx-offline",
      requestedBackend: "cpu",
    });
    const capableWhisper = selection.candidates.find((candidate) => candidate.id === "whisper-cli");
    expect(capableWhisper).toMatchObject({ capableBackend: "metal" });
    expect(capableWhisper).toHaveProperty("observedBackend", undefined);
    expect(selection.entries.map((entry) => entry.command)).toEqual([
      "sherpa-onnx-offline",
      "whisper-cli",
    ]);

    recordLocalAudioBackendObservation({
      command: "whisper-cli",
      args: ["-m", modelPath, "-otxt", "-of", "{{OutputBase}}", "-nt", "{{MediaPath}}"],
      output: "whisper_backend_init_gpu: using MTL0 backend",
    });
    const observedSelection = await inspectLocalAudioSelection({
      env: {
        WHISPER_CPP_MODEL: modelPath,
        SHERPA_ONNX_MODEL_DIR: sherpaDir,
      },
      platform: "darwin",
      arch: "arm64",
      resolveBinary: async (name) =>
        name === "whisper-cli"
          ? "/opt/homebrew/bin/whisper-cli"
          : name === "sherpa-onnx-offline"
            ? "/usr/local/bin/sherpa-onnx-offline"
            : null,
      resolveRealpath: async () => "/opt/homebrew/Cellar/whisper-cpp/1.9.1/bin/whisper-cli",
      inspectLinkedLibraries: async () => null,
    });
    expect(observedSelection.selected).toMatchObject({
      id: "whisper-cli",
      capableBackend: "metal",
      observedBackend: "metal",
    });
  });

  it("reports Parakeet as MLX-capable without treating capability as observation", async () => {
    const tempDir = await createTempDir();
    const whisperModel = path.join(tempDir, "whisper.bin");
    const sherpaDir = path.join(tempDir, "sherpa");
    await fs.writeFile(whisperModel, "model");
    await fs.mkdir(sherpaDir);
    await Promise.all(
      ["tokens.txt", "encoder.onnx", "decoder.onnx", "joiner.onnx"].map(async (fileName) => {
        await fs.writeFile(path.join(sherpaDir, fileName), "model");
      }),
    );

    const selection = await inspectLocalAudioSelection({
      env: {
        WHISPER_CPP_MODEL: whisperModel,
        SHERPA_ONNX_MODEL_DIR: sherpaDir,
      },
      platform: "darwin",
      arch: "arm64",
      resolveBinary: async (name) => `/usr/local/bin/${name}`,
      resolveRealpath: async (filePath) => filePath,
      inspectLinkedLibraries: async () => null,
    });

    expect(selection.selected).toMatchObject({
      id: "sherpa-onnx-offline",
      requestedBackend: "cpu",
    });
    const parakeet = selection.candidates.find((candidate) => candidate.id === "parakeet-mlx");
    expect(parakeet).toMatchObject({ capableBackend: "mlx" });
    expect(parakeet).not.toHaveProperty("observedBackend");
    expect(selection.entries.map((entry) => entry.command)).toEqual([
      "sherpa-onnx-offline",
      "whisper-cli",
      "parakeet-mlx",
      "whisper",
    ]);
  });

  it("keeps an unproven whisper runtime behind CPU sherpa", async () => {
    const tempDir = await createTempDir();
    const whisperModel = path.join(tempDir, "whisper.bin");
    const sherpaDir = path.join(tempDir, "sherpa");
    await fs.writeFile(whisperModel, "model");
    await fs.mkdir(sherpaDir);
    await Promise.all(
      ["tokens.txt", "encoder.onnx", "decoder.onnx", "joiner.onnx"].map(async (fileName) => {
        await fs.writeFile(path.join(sherpaDir, fileName), "model");
      }),
    );

    const selection = await inspectLocalAudioSelection({
      env: {
        WHISPER_CPP_MODEL: whisperModel,
        SHERPA_ONNX_MODEL_DIR: sherpaDir,
      },
      platform: "linux",
      arch: "x64",
      resolveBinary: async (name) =>
        name === "whisper-cli" || name === "sherpa-onnx-offline" ? `/usr/local/bin/${name}` : null,
      inspectLinkedLibraries: async () => "libggml-cpu.so",
    });

    expect(selection.selected).toMatchObject({
      id: "sherpa-onnx-offline",
      requestedBackend: "cpu",
    });
    expect(selection.entries.map((entry) => entry.command)).toEqual([
      "sherpa-onnx-offline",
      "whisper-cli",
    ]);
  });

  it("reports a dynamically linked CUDA runtime as capable but unobserved", async () => {
    const tempDir = await createTempDir();
    const whisperModel = path.join(tempDir, "whisper.bin");
    await fs.writeFile(whisperModel, "model");

    const selection = await inspectLocalAudioSelection({
      env: { WHISPER_CPP_MODEL: whisperModel },
      platform: "linux",
      arch: "x64",
      resolveBinary: async (name) => (name === "whisper-cli" ? "/usr/local/bin/whisper-cli" : null),
      inspectLinkedLibraries: async () => "libggml-cuda.so => /usr/local/lib/libggml-cuda.so",
    });

    expect(selection.selected).toMatchObject({
      id: "whisper-cli",
      capableBackend: "cuda",
    });
    expect(selection.selected).toHaveProperty("observedBackend", undefined);
  });
});
