import fs from "node:fs/promises";
import { vi } from "vitest";
import type { WorktreeFilesystemBackend } from "./filesystem-backend.types.js";

export function createCopyWorktreeBackend(): WorktreeFilesystemBackend {
  return {
    id: "btrfs",
    estimateCloneBytes: (_entries, indexBytes) => 16 * 1024 ** 2 + 2 * indexBytes,
    createTemplate: vi.fn(async (destination, options) => {
      options.commitGuard();
      await fs.mkdir(destination);
    }),
    cloneTemplate: vi.fn(async (source, destination, options) => {
      options.commitGuard();
      await fs.cp(source, destination, { recursive: true, verbatimSymlinks: true });
    }),
  };
}
