import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { describe, expect, it, vi } from "vitest";
import { backupVerifyCommand } from "../commands/backup-verify.js";
import type { RuntimeEnv } from "../runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createBackupArchive } from "./backup-create.js";

describe("backup hardlink traversal", () => {
  it("completes and verifies a dense hardlink tree without emitting Link entries", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-hardlink-tree-",
        scenario: "minimal",
      },
      async (state) => {
        const sourceDir = state.statePath(
          "agents",
          "main",
          "agent",
          "codex-home",
          "home",
          ".cache",
          "pnpm",
        );
        const targetPath = path.join(sourceDir, "target.txt");
        await fs.mkdir(sourceDir, { recursive: true });
        await fs.writeFile(targetPath, "backup payload");
        await Promise.all(
          Array.from({ length: 8 }, (_, index) =>
            fs.link(targetPath, path.join(sourceDir, `hardlink-${index}.txt`)),
          ),
        );

        const result = await createBackupArchive({
          output: state.path("backup.tar.gz"),
          includeWorkspace: false,
        });
        const entries: Array<{ path: string; type: string }> = [];
        await tar.t({
          file: result.archivePath,
          gzip: true,
          onentry: (entry) => {
            if (entry.path.includes("/.cache/pnpm/")) {
              entries.push({ path: entry.path, type: entry.type });
            }
            entry.resume();
          },
        });

        expect(entries.filter((entry) => entry.type === "File")).toHaveLength(9);
        expect(entries.filter((entry) => entry.type === "Link")).toHaveLength(0);
        const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        await expect(
          backupVerifyCommand(runtime, { archive: result.archivePath }),
        ).resolves.toMatchObject({
          ok: true,
        });
      },
    );
  }, 30_000);
});
