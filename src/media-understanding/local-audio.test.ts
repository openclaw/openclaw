import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { inspectLocalAudioSelection } from "./local-audio.js";

const tempDirs = createTempDirTracker();
const sherpaFiles = ["tokens.txt", "encoder.onnx", "decoder.onnx", "joiner.onnx"];

async function localModels() {
  const root = tempDirs.make("openclaw-local-audio-");
  const modelPath = path.join(root, "whisper.bin");
  const sherpaDir = path.join(root, "sherpa");
  await fs.writeFile(modelPath, "model");
  await fs.mkdir(sherpaDir);
  await Promise.all(sherpaFiles.map((name) => fs.writeFile(path.join(sherpaDir, name), "model")));
  return { modelPath, sherpaDir };
}

async function whisperCommand() {
  const root = tempDirs.make("openclaw-local-audio-");
  const command = path.join(root, "whisper-cli");
  await fs.writeFile(command, "#!/bin/sh\n");
  await fs.chmod(command, 0o755);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  tempDirs.cleanup();
});

describe("local audio selection", () => {
  it("prepares Whisper model files only for a resolved command", async () => {
    const root = tempDirs.make("openclaw-local-audio-preparation-");
    const modelPath = path.join(root, "whisper-model.bin");
    await fs.writeFile(modelPath, "synthetic model");
    for (const name of sherpaFiles) {
      await fs.writeFile(path.join(root, name), "synthetic model");
    }
    const stat = vi.spyOn(fsSync, "statSync");
    const listDirectory = vi.fn(async () => ["ggml-base.en.bin"]);
    const selection = await inspectLocalAudioSelection({
      env: { WHISPER_CPP_MODEL: modelPath, SHERPA_ONNX_MODEL_DIR: root },
      resolveBinary: async (name) =>
        name === "sherpa-onnx-offline" ? path.join(root, name) : null,
      listDirectory,
    });
    expect(selection.selected).toMatchObject({ id: "sherpa-onnx-offline", ready: true });
    expect(selection.candidates.find((candidate) => candidate.id === "whisper-cli")?.ready).toBe(
      false,
    );
    expect(
      stat.mock.calls.filter(([file]) => String(file).endsWith("whisper-model.bin")),
    ).toHaveLength(0);
    expect(listDirectory).not.toHaveBeenCalled();
  });

  it("expands home-directory shorthand in PATH entries containing delimiters", async () => {
    const homeName = `home${path.delimiter}extra`;
    const tempDir = path.join(tempDirs.make("openclaw-local-audio-"), homeName);
    await fs.mkdir(tempDir);
    const binDir = path.join(tempDir, "bin");
    const modelPath = path.join(tempDir, "whisper.bin");
    const commandPath = path.join(binDir, "whisper-cli");
    await fs.mkdir(binDir);
    await fs.writeFile(modelPath, "model");
    await fs.writeFile(commandPath, "#!/bin/sh\n");
    await fs.chmod(commandPath, 0o755);

    const selection = await inspectLocalAudioSelection({
      env: {
        HOME: tempDir,
        PATH: "~/bin",
        WHISPER_CPP_MODEL: modelPath,
      },
      platform: process.platform,
      arch: process.arch,
      inspectLinkedLibraries: async () => null,
    });

    expect(selection.selected).toMatchObject({
      id: "whisper-cli",
      resolvedCommand: commandPath,
      entry: { command: commandPath },
    });
  });

  it("discovers installed whisper models and prefers non-tiny over the tiny fixture", async () => {
    const tempDir = await whisperCommand();

    const selection = await inspectLocalAudioSelection({
      env: { PATH: tempDir },
      platform: process.platform,
      arch: process.arch,
      inspectLinkedLibraries: async () => null,
      listDirectory: async (dirPath) =>
        dirPath === "/opt/homebrew/share/whisper-cpp"
          ? ["for-tests-ggml-tiny.bin", "ggml-tiny.bin", "ggml-base.en.bin", "notes.txt"]
          : [],
    });

    const whisper = selection.candidates.find((candidate) => candidate.id === "whisper-cli");
    expect(whisper?.ready).toBe(true);
    expect(whisper?.entry?.args).toContain("/opt/homebrew/share/whisper-cpp/ggml-base.en.bin");
  });

  it("reports whisper as not ready when no ggml model is installed", async () => {
    const tempDir = await whisperCommand();

    const selection = await inspectLocalAudioSelection({
      env: { PATH: tempDir },
      platform: process.platform,
      arch: process.arch,
      inspectLinkedLibraries: async () => null,
      listDirectory: async () => [],
    });

    const whisper = selection.candidates.find((candidate) => candidate.id === "whisper-cli");
    expect(whisper?.ready).toBe(false);
    expect(whisper?.reason).toBe("model file not found");
  });

  it("discovers Windows commands through case-insensitive PATH and PATHEXT values", async () => {
    const availableDirectory = tempDirs.make("openclaw-local-audio-windows-");
    const commandPath = path.join(availableDirectory, "whisper.audio");
    await fs.writeFile(commandPath, "synthetic executable");
    await withMockedPlatform("win32", async () => {
      const inspect = (env: NodeJS.ProcessEnv) =>
        inspectLocalAudioSelection({ env, listDirectory: async () => [] });
      for (const env of [
        { Path: path.join(availableDirectory, "missing"), pAtHeXt: ".AUDIO" },
        { Path: availableDirectory, pAtHeXt: ".MISSING" },
      ]) {
        expect((await inspect(env)).selected).toBeUndefined();
      }
      expect(
        (await inspect({ Path: availableDirectory, pAtHeXt: ".AUDIO" })).selected,
      ).toMatchObject({ id: "whisper", resolvedCommand: commandPath });
    });
  });

  it("does not rank Metal-capable whisper ahead of sherpa until a run observes Metal", async () => {
    // Backend observations belong to this case, not the other selection fixtures.
    vi.resetModules();
    const { inspectLocalAudioSelection: inspectSelection, recordLocalAudioBackendObservation } =
      await import("./local-audio.js");
    const { modelPath, sherpaDir } = await localModels();
    const inspect = () =>
      inspectSelection({
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
    const selection = await inspect();

    expect(selection.selected).toMatchObject({
      id: "sherpa-onnx-offline",
      requestedBackend: "cpu",
    });
    const capableWhisper = selection.candidates.find((candidate) => candidate.id === "whisper-cli");
    expect(capableWhisper).toMatchObject({ capableBackend: "metal" });
    expect(capableWhisper).toHaveProperty("observedBackend", undefined);
    expect(selection.entries.map((entry) => entry.command)).toEqual([
      "/usr/local/bin/sherpa-onnx-offline",
      "/opt/homebrew/bin/whisper-cli",
    ]);
    expect(selection.entries.flatMap((entry) => entry.args ?? [])).toContain("{{AttachmentPath}}");

    recordLocalAudioBackendObservation({
      command: "/custom/bin/whisper-cli",
      args: ["-m", modelPath, "-otxt", "-of", "{{OutputBase}}", "-nt", "{{MediaPath}}"],
      output: "whisper_backend_init_gpu: using MTL0 backend",
    });
    const mismatchedCommandSelection = await inspect();
    expect(mismatchedCommandSelection.selected).toMatchObject({ id: "sherpa-onnx-offline" });

    recordLocalAudioBackendObservation({
      command: "/opt/homebrew/bin/whisper-cli",
      args: ["-m", modelPath, "-otxt", "-of", "{{OutputBase}}", "-nt", "{{MediaPath}}"],
      output: "whisper_backend_init_gpu: using MTL0 backend",
    });
    const observedSelection = await inspect();
    expect(observedSelection.selected).toMatchObject({
      id: "whisper-cli",
      capableBackend: "metal",
      observedBackend: "metal",
    });

    for (const failedBackend of ["Metal", "MTL0", "CUDA0"]) {
      expect(
        recordLocalAudioBackendObservation({
          command: "/opt/homebrew/bin/whisper-cli",
          args: ["-m", modelPath, "-otxt", "-of", "{{OutputBase}}", "-nt", "{{MediaPath}}"],
          output: [
            `whisper_backend_init_gpu: using ${failedBackend} backend`,
            `whisper_backend_init_gpu: failed to initialize ${failedBackend} backend`,
          ].join("\n"),
        }),
      ).toBe("cpu");
      const failedAccelerationSelection = await inspect();
      expect(failedAccelerationSelection.selected).toMatchObject({ id: "sherpa-onnx-offline" });
      expect(
        failedAccelerationSelection.candidates.find((candidate) => candidate.id === "whisper-cli"),
      ).toMatchObject({ observedBackend: "cpu" });
    }
  });

  it("reports Parakeet as MLX-capable without treating capability as observation", async () => {
    const { modelPath: whisperModel, sherpaDir } = await localModels();

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
      "/usr/local/bin/sherpa-onnx-offline",
      "/usr/local/bin/whisper-cli",
      "/usr/local/bin/parakeet-mlx",
      "/usr/local/bin/whisper",
    ]);
  });

  it("reads observations from the exact Windows whisper-cli.exe executable", async () => {
    vi.resetModules();
    const { inspectLocalAudioSelection: inspectSelection, recordLocalAudioBackendObservation } =
      await import("./local-audio.js");
    const root = tempDirs.make("openclaw-local-audio-backend-");
    const modelPath = path.join(root, "model.bin");
    await fs.writeFile(modelPath, "model");
    const command = path.join(root, "whisper-cli.exe");
    const options = {
      env: { WHISPER_CPP_MODEL: modelPath },
      platform: "win32" as const,
      resolveBinary: async (name: string) => (name === "whisper-cli" ? command : null),
      inspectLinkedLibraries: async () => null,
    };
    recordLocalAudioBackendObservation({
      command: path.join(root, "other", "whisper-cli.exe"),
      args: [],
      output: "whisper_backend_init_gpu: using CUDA0 backend",
    });
    expect((await inspectSelection(options)).selected?.observedBackend).toBeUndefined();
    recordLocalAudioBackendObservation({
      command,
      args: [],
      output: "whisper_backend_init_gpu: using CUDA0 backend",
    });
    expect((await inspectSelection(options)).selected).toMatchObject({
      observedBackend: "cuda",
      entry: { command },
    });
    recordLocalAudioBackendObservation({
      command,
      args: ["--no-gpu"],
      output: "whisper_backend_init: using CPU backend",
    });
    expect((await inspectSelection(options)).selected?.observedBackend).toBe("cuda");
  });

  it("reports a dynamically linked CUDA runtime as capable but unobserved", async () => {
    const tempDir = tempDirs.make("openclaw-local-audio-");
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
