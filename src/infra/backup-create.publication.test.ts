import fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createBackupArchive } from "./backup-create.js";
import * as directoryDurability from "./directory-durability.js";

it("fails closed when the backup destination does not support hard links", async () => {
  const publicationSpy = vi
    .spyOn(directoryDurability, "publishFileExclusive")
    .mockRejectedValue(Object.assign(new Error("hard links unsupported"), { code: "EPERM" }));
  try {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-no-hardlinks-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        await fs.mkdir(outputDir, { recursive: true });

        await expect(
          createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: Date.UTC(2026, 4, 9, 12, 0, 0),
          }),
        ).rejects.toThrow(/requires hard-link support/iu);
        expect(publicationSpy).toHaveBeenCalledWith(
          expect.objectContaining({ strategy: "link-required" }),
        );
        await expect(fs.readdir(outputDir)).resolves.toEqual([]);
      },
    );
  } finally {
    publicationSpy.mockRestore();
  }
});
