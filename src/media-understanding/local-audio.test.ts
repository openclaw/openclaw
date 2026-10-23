import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as executablePath from "../infra/executable-path.js";
import { runExec } from "../process/exec.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { inspectLocalAudioSelection, recordLocalAudioBackendObservation } from "./local-audio.js";

const { readdir } = vi.hoisted(() => ({
  readdir: vi.fn<(directory: fsSync.PathLike) => Promise<string[]>>(async () => []),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir, default: { ...actual, readdir } };
});
vi.mock(import("../process/exec.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  runExec: vi.fn(async () => ({ stdout: "", stderr: "" })),
}));

const tempDirs = createTempDirTracker();
const sherpaFiles = ["tokens.txt", "encoder.onnx", "decoder.onnx", "joiner.onnx"];
const originalEnv = process.env;
function inspect(env: NodeJS.ProcessEnv = {}) {
  process.env = env;
  return inspectLocalAudioSelection();
}
type Selection = Awaited<ReturnType<typeof inspectLocalAudioSelection>>;
const whisperCandidate = (selection: Selection) =>
  selection.candidates.find(({ id }) => id === "whisper-cli");

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
  vi.resetAllMocks();
  process.env = originalEnv;
  tempDirs.cleanup();
});

it("prepares Whisper model files only for a resolved command", async () => {
  const root = tempDirs.make("openclaw-local-audio-preparation-");
  const modelPath = path.join(root, "whisper-model.bin");
  await fs.writeFile(modelPath, "synthetic model");
  for (const name of sherpaFiles) {
    await fs.writeFile(path.join(root, name), "synthetic model");
  }
  const stat = vi.spyOn(fsSync, "statSync");
  vi.spyOn(executablePath, "resolveExecutableFromPathEnv").mockImplementation((name) =>
    name === "sherpa-onnx-offline" ? path.join(root, name) : undefined,
  );
  readdir.mockResolvedValue(["ggml-base.en.bin"]);
  const selection = await inspect({ WHISPER_CPP_MODEL: modelPath, SHERPA_ONNX_MODEL_DIR: root });
  expect(selection.selected).toMatchObject({ id: "sherpa-onnx-offline", ready: true });
  expect(whisperCandidate(selection)?.ready).toBe(false);
  expect(
    stat.mock.calls.filter(([file]) => String(file).endsWith("whisper-model.bin")),
  ).toHaveLength(0);
  expect(readdir).not.toHaveBeenCalled();
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

  const selection = await inspect({ HOME: tempDir, PATH: "~/bin", WHISPER_CPP_MODEL: modelPath });

  expect(selection.selected).toMatchObject({
    id: "whisper-cli",
    entry: { command: commandPath },
  });
});

it.each([
  { installed: true, ready: true, reason: undefined },
  { installed: false, ready: false, reason: "model file not found" },
])(
  "reports installed Whisper model readiness: $installed",
  async ({ installed, ready, reason }) => {
    const tempDir = await whisperCommand();
    readdir.mockImplementation(async (directory) =>
      installed && directory === "/opt/homebrew/share/whisper-cpp"
        ? ["for-tests-ggml-tiny.bin", "ggml-tiny.bin", "ggml-base.en.bin", "notes.txt"]
        : [],
    );
    const selection = await inspect({ PATH: tempDir });
    const whisper = whisperCandidate(selection);
    expect(whisper?.ready).toBe(ready);
    if (installed) {
      expect(whisper?.entry?.args).toContain("/opt/homebrew/share/whisper-cpp/ggml-base.en.bin");
    } else {
      expect(whisper?.reason).toBe(reason);
    }
  },
);

it("discovers Windows commands through case-insensitive PATH and PATHEXT values", async () => {
  const availableDirectory = tempDirs.make("openclaw-local-audio-windows-");
  const commandPath = path.join(availableDirectory, "whisper.audio");
  await fs.writeFile(commandPath, "synthetic executable");
  await withMockedPlatform("win32", async () => {
    for (const env of [
      { Path: path.join(availableDirectory, "missing"), pAtHeXt: ".AUDIO" },
      { Path: availableDirectory, pAtHeXt: ".MISSING" },
    ]) {
      expect((await inspect(env)).selected).toBeUndefined();
    }
    expect((await inspect({ Path: availableDirectory, pAtHeXt: ".AUDIO" })).selected).toMatchObject(
      { id: "whisper", entry: { command: commandPath } },
    );
  });
});

it("does not rank Metal-capable whisper ahead of sherpa until a run observes Metal", async () => {
  const { modelPath, sherpaDir } = await localModels();
  vi.spyOn(fs, "realpath").mockResolvedValue(
    "/opt/homebrew/Cellar/whisper-cpp/1.9.1/bin/whisper-cli",
  );
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
  vi.spyOn(executablePath, "resolveExecutableFromPathEnv").mockImplementation((name) =>
    name === "whisper-cli"
      ? "/opt/homebrew/bin/whisper-cli"
      : name === "sherpa-onnx-offline"
        ? "/usr/local/bin/sherpa-onnx-offline"
        : undefined,
  );
  const inspectBackend = () =>
    inspect({ WHISPER_CPP_MODEL: modelPath, SHERPA_ONNX_MODEL_DIR: sherpaDir });
  const args = ["-m", modelPath, "-otxt", "-of", "{{OutputBase}}", "-nt", "{{MediaPath}}"];
  const observe = (output: string, command = "/opt/homebrew/bin/whisper-cli") =>
    recordLocalAudioBackendObservation({ command, args, output });

  const selection = await inspectBackend();

  expect(selection.selected).toMatchObject({ id: "sherpa-onnx-offline", requestedBackend: "cpu" });
  expect(whisperCandidate(selection)).toMatchObject({
    capableBackend: "metal",
    observedBackend: undefined,
  });
  expect(selection.entries.map((entry) => entry.command)).toEqual([
    "/usr/local/bin/sherpa-onnx-offline",
    "/opt/homebrew/bin/whisper-cli",
  ]);
  expect(selection.entries.flatMap((entry) => entry.args ?? [])).toContain("{{AttachmentPath}}");

  observe("whisper_backend_init_gpu: using MTL0 backend", "/custom/bin/whisper-cli");
  const mismatchedCommandSelection = await inspectBackend();
  expect(mismatchedCommandSelection.selected).toMatchObject({ id: "sherpa-onnx-offline" });

  observe("whisper_backend_init_gpu: using MTL0 backend");
  const observedSelection = await inspectBackend();
  expect(observedSelection.selected).toMatchObject({
    id: "whisper-cli",
    capableBackend: "metal",
    observedBackend: "metal",
  });

  for (const failedBackend of ["Metal", "MTL0", "CUDA0"]) {
    expect(
      observe(
        [
          `whisper_backend_init_gpu: using ${failedBackend} backend`,
          `whisper_backend_init_gpu: failed to initialize ${failedBackend} backend`,
        ].join("\n"),
      ),
    ).toBe("cpu");
    const failedAccelerationSelection = await inspectBackend();
    expect(failedAccelerationSelection.selected).toMatchObject({ id: "sherpa-onnx-offline" });
    expect(whisperCandidate(failedAccelerationSelection)).toMatchObject({ observedBackend: "cpu" });
  }
});

it("reports Parakeet as MLX-capable without treating capability as observation", async () => {
  const { modelPath: whisperModel, sherpaDir } = await localModels();

  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
  vi.spyOn(executablePath, "resolveExecutableFromPathEnv").mockImplementation(
    (name) => `/usr/local/bin/${name}`,
  );
  const selection = await inspect({
    WHISPER_CPP_MODEL: whisperModel,
    SHERPA_ONNX_MODEL_DIR: sherpaDir,
  });

  expect(selection.selected).toMatchObject({ id: "sherpa-onnx-offline", requestedBackend: "cpu" });
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
  const root = tempDirs.make("openclaw-local-audio-backend-");
  const modelPath = path.join(root, "model.bin");
  await fs.writeFile(modelPath, "model");
  const command = path.join(root, "whisper-cli.exe");
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.spyOn(executablePath, "resolveExecutableFromPathEnv").mockImplementation((name) =>
    name === "whisper-cli" ? command : undefined,
  );
  const cuda = { args: [], output: "whisper_backend_init_gpu: using CUDA0 backend" };
  recordLocalAudioBackendObservation({
    ...cuda,
    command: path.join(root, "other", "whisper-cli.exe"),
  });
  expect(
    (await inspect({ WHISPER_CPP_MODEL: modelPath })).selected?.observedBackend,
  ).toBeUndefined();
  recordLocalAudioBackendObservation({ ...cuda, command });
  expect((await inspect({ WHISPER_CPP_MODEL: modelPath })).selected).toMatchObject({
    observedBackend: "cuda",
    entry: { command },
  });
  recordLocalAudioBackendObservation({
    command,
    args: ["--no-gpu"],
    output: "whisper_backend_init: using CPU backend",
  });
  expect((await inspect({ WHISPER_CPP_MODEL: modelPath })).selected?.observedBackend).toBe("cuda");
});

it("reports a dynamically linked CUDA runtime as capable but unobserved", async () => {
  const tempDir = tempDirs.make("openclaw-local-audio-");
  const whisperModel = path.join(tempDir, "whisper.bin");
  await fs.writeFile(whisperModel, "model");

  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.spyOn(process, "arch", "get").mockReturnValue("x64");
  vi.spyOn(executablePath, "resolveExecutableFromPathEnv").mockImplementation((name) =>
    name === "whisper-cli" ? "/usr/local/cuda/bin/whisper-cli" : undefined,
  );
  vi.mocked(runExec).mockResolvedValueOnce({
    stdout: "libggml-cuda.so => /usr/local/lib/libggml-cuda.so",
    stderr: "",
  });
  const selection = await inspect({ WHISPER_CPP_MODEL: whisperModel });

  expect(selection.selected).toMatchObject({ id: "whisper-cli", capableBackend: "cuda" });
  expect(selection.selected).toHaveProperty("observedBackend", undefined);
});
