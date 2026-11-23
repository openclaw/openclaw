import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { backupVerifyCommand } from "../commands/backup-verify.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import { createBackupArchive } from "./backup-create.js";
import { listArchiveEntries, withIsolatedBackupState } from "./backup-create.test-support.js";

describe("legacy bundled-plugin dependency cache", () => {
  it.runIf(process.platform !== "win32")(
    "leaves the cache and its package links out of the bounded manifest",
    async () => {
      await withIsolatedBackupState(
        { layout: "state-only", scenario: "minimal" },
        async (state) => {
          // Releases before 2026.5.2 mirrored package files into this cache as absolute links.
          const mirror = state.statePath("plugin-runtime-deps", "openclaw-2026.4.29-abc", "dist");
          await fs.mkdir(mirror, { recursive: true });
          for (const name of ["entry.js", "chunk-a.js", "chunk-b.js"]) {
            await fs.symlink(state.path("install", "dist", name), path.join(mirror, name));
          }
          await fs.symlink(state.path("elsewhere"), state.statePath("outside"));
          const result = await createBackupArchive({ output: state.path("backup.tar.gz") });
          const external = [
            { entryPath: expect.stringMatching(/\/outside$/u), linkpath: state.path("elsewhere") },
          ];
          expect(result.externalSymbolicLinks).toEqual(external);
          expect(result.skipped).toContainEqual(
            expect.objectContaining({
              sourcePath: expect.stringMatching(/\/plugin-runtime-deps$/u),
              reason: "regenerable",
            }),
          );
          const entries = await listArchiveEntries(result.archivePath);
          expect(entries.some((entry) => entry.includes("/plugin-runtime-deps"))).toBe(false);
          const verified = await backupVerifyCommand(createTestRuntime(), {
            archive: result.archivePath,
          });
          expect(verified.externalSymbolicLinks).toEqual(external);
        },
      );
    },
  );
});
