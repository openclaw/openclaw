import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, type Mock } from "vitest";
import type { describeVideoFile, transcribeAudioFile } from "../media-understanding/runtime.js";
import { runCap } from "./capability-cli.test-harness.js";

/** Audio and video `--file` paths resolve through symlinked parents the way the OS does. */
export function registerMediaPathCapabilityCliTests({
  mocks,
  tempDirs,
  firstJsonOutput,
}: {
  mocks: {
    transcribeAudioFile: Mock<typeof transcribeAudioFile>;
    describeVideoFile: Mock<typeof describeVideoFile>;
  };
  tempDirs: { make: (prefix: string) => string };
  firstJsonOutput: () => Record<string, unknown> | undefined;
}): void {
  it.skipIf(process.platform === "win32").each([
    ["audio", "transcribe", "memo.wav"],
    ["video", "describe", "clip.mp4"],
  ] as const)("reads the selected %s through a symlink parent", async (kind, action, name) => {
    const root = await fs.realpath(tempDirs.make("infer-media-parent-"));
    const physical = path.join(root, "physical");
    const selected = path.join(physical, name);
    await fs.mkdir(path.join(physical, "nested"), { recursive: true });
    await fs.symlink(path.join(physical, "nested"), path.join(root, "link"), "dir");
    await fs.writeFile(path.join(physical, "payload.bin"), "selected input bytes");
    await fs.symlink("payload.bin", selected);
    await fs.writeFile(path.join(root, name), "lexical decoy bytes");
    const runtime = kind === "audio" ? mocks.transcribeAudioFile : mocks.describeVideoFile;
    runtime.mockImplementationOnce(async ({ filePath }) => ({
      text: await fs.readFile(filePath, "utf8"),
    }));
    await runCap("infer", kind, action, "--file", `${root}/link/../${name}`, "--json");
    expect(firstJsonOutput()).toMatchObject({
      outputs: [{ path: selected, text: "selected input bytes" }],
    });
  });

  it
    .skipIf(process.platform === "win32")
    .each(["missing/../memo.wav", "link/../memo.wav/", "link/../memo.wav/."])(
    "rejects %s before transcription, as the filesystem does",
    async (input) => {
      const root = await fs.realpath(tempDirs.make("infer-media-malformed-"));
      await fs.mkdir(path.join(root, "physical", "nested"), { recursive: true });
      await fs.symlink(path.join(root, "physical", "nested"), path.join(root, "link"), "dir");
      await fs.writeFile(path.join(root, "physical", "memo.wav"), "selected input bytes");
      await fs.writeFile(path.join(root, "memo.wav"), "lexical decoy bytes");
      await expect(
        runCap("infer", "audio", "transcribe", "--file", `${root}/${input}`, "--json"),
      ).rejects.toThrow("exit 1");
      expect(mocks.transcribeAudioFile).not.toHaveBeenCalled();
    },
  );
}
