import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { testApi as backupCreateInternals } from "./backup-create.js";

describe("writeArchiveStreamToFile", () => {
  it("closes a partial archive before propagating a stream error", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-stream-"));
    const archivePath = path.join(tempDir, "partial.tar.gz");
    const archiveStream = new PassThrough();
    try {
      const writePromise = backupCreateInternals.writeArchiveStreamToFile({
        archivePath,
        archiveStream,
      });
      archiveStream.write("partial archive");
      archiveStream.destroy(new Error("injected tar read failure"));

      await expect(writePromise).rejects.toThrow("injected tar read failure");
      await expect(fs.rm(archivePath)).resolves.toBeUndefined();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
