import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, type Mock } from "vitest";
import type { describeVideoFile, transcribeAudioFile } from "../media-understanding/runtime.js";
import { runCap } from "./capability-cli.test-harness.js";

export function registerMediaInputCapabilityCliTests(fixtures: {
  mocks: {
    describeVideoFile: Mock<typeof describeVideoFile>;
    transcribeAudioFile: Mock<typeof transcribeAudioFile>;
    runtime: { log: Mock };
  };
  tempDirs: { make: (prefix: string) => string };
  firstJsonOutput: () => unknown;
  expectRuntimeErrorContains: (expected: string) => void;
}): void {
  const { mocks, tempDirs, firstJsonOutput, expectRuntimeErrorContains } = fixtures;

  it.skipIf(process.platform === "win32").each([
    ["audio", "transcribe", "memo.wav"],
    ["video", "describe", "clip.mp4"],
  ] as const)("reads the selected %s when a symlink precedes ..", async (kind, action, name) => {
    const root = await fs.realpath(tempDirs.make("infer-media-parent-"));
    const physical = path.join(root, "physical");
    const nested = path.join(physical, "nested");
    const selected = path.join(physical, name);
    await fs.mkdir(nested, { recursive: true });
    await fs.symlink(nested, path.join(root, "link"), "dir");
    await fs.writeFile(path.join(physical, "payload.bin"), "selected input bytes");
    await fs.symlink("payload.bin", selected);
    await fs.writeFile(path.join(root, name), "lexical decoy bytes");
    const runtime = kind === "audio" ? mocks.transcribeAudioFile : mocks.describeVideoFile;
    runtime.mockImplementationOnce(async ({ filePath }: { filePath: string }) => ({
      text: await fs.readFile(filePath, "utf8"),
    }));

    await runCap("infer", kind, action, "--file", `${root}/link/../${name}`, "--json");

    expect(firstJsonOutput()).toMatchObject({
      outputs: [{ path: selected, text: "selected input bytes" }],
    });
    expect(runtime).toHaveBeenCalledWith(expect.objectContaining({ filePath: selected }));
  });

  it.skipIf(process.platform === "win32").each([
    ["memo.wav/", "Expected a regular media file"],
    ["memo.wav/.", "Expected a regular media file"],
    ["memo.wav/..", "Expected a regular media file"],
    ["absent/../memo.wav", "ENOENT"],
  ])("rejects an invalid physical media path: %s", async (suffix, error) => {
    const root = tempDirs.make("infer-media-invalid-path-");
    await fs.writeFile(path.join(root, "memo.wav"), "lexical decoy bytes");
    const file = `${root}/../${path.basename(root)}/${suffix}`;
    await expect(runCap("infer", "audio", "transcribe", "--file", file)).rejects.toThrow("exit 1");
    expectRuntimeErrorContains(error);
    expect(mocks.transcribeAudioFile).not.toHaveBeenCalled();
  });

  it("reports actual audio attribution and forwards request hints", async () => {
    mocks.transcribeAudioFile.mockResolvedValueOnce({
      text: "meeting notes",
      provider: "fixture-asr",
      model: "fixture-actual-model",
    });
    await runCap(
      "infer",
      "audio",
      "transcribe",
      "--file",
      "memo.m4a",
      "--model",
      "openai/whisper-1",
      "--language",
      "en",
      "--prompt",
      "Focus on names",
    );
    expect(mocks.transcribeAudioFile).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ language: "en", prompt: "Focus on names" }),
    );
    const output = mocks.runtime.log.mock.calls.at(-1)?.[0];
    expect(output).toContain("provider: fixture-asr");
    expect(output).toContain("model: fixture-actual-model");
    expect(output).toContain(path.resolve("memo.m4a"));
    expect(output).toContain("meeting notes");
  });
}
