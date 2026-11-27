import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeOutputAsset } from "./media-output.js";

describe("writeOutputAsset", () => {
  const dirs = useAutoCleanupTempDirTracker(afterEach);

  it("keeps a requested .opus extension for Ogg-contained Opus bytes", async () => {
    // Regression for #206612: sniffing Opus-in-Ogg bytes used to collapse to the same
    // generic "audio/ogg" as every other Ogg payload, so a requested .opus output was
    // silently renamed to .ogg and the path the caller asked for never existed.
    const dir = dirs.make("openclaw-media-output-");
    const buffer = Buffer.concat([
      Buffer.from("OggS", "ascii"),
      Buffer.alloc(24),
      Buffer.from("OpusHead", "ascii"),
    ]);
    const outputPath = path.join(dir, "voice.opus");

    const written = await writeOutputAsset({
      buffer,
      outputPath,
      outputIndex: 0,
      outputCount: 1,
      subdir: "tts",
    });

    expect(written.path).toBe(outputPath);
    await expect(fs.readFile(outputPath)).resolves.toEqual(buffer);
    await expect(fs.access(path.join(dir, "voice.ogg"))).rejects.toThrow();
  });

  it("still renames a genuine mismatch, such as a requested .opus holding Ogg Vorbis bytes", async () => {
    const dir = dirs.make("openclaw-media-output-");
    const buffer = Buffer.concat([
      Buffer.from("OggS", "ascii"),
      Buffer.alloc(24),
      Buffer.from("\x01vorbis", "ascii"),
      Buffer.alloc(1),
    ]);
    const outputPath = path.join(dir, "voice.opus");

    const written = await writeOutputAsset({
      buffer,
      outputPath,
      outputIndex: 0,
      outputCount: 1,
      subdir: "tts",
    });

    expect(written.path).toBe(path.join(dir, "voice.ogg"));
  });
});
