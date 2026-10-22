import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi, afterEach, describe } from "vitest";
import { backupCreateCommand } from "../commands/backup.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import {
  createVerifiedBackup,
  isolateBackupScratch,
  restoreBackup,
  withBackupFixture,
} from "./backup-create-family.test-support.js";
import { createBackupArchive } from "./backup-create.js";
import { listArchiveEntryDetails } from "./backup-create.test-support.js";
import {
  createBackupScratchDirectory,
  finishBackupScratch,
  maintainBackupScratch,
} from "./backup-scratch.js";
import * as directoryDurability from "./directory-durability.js";

it("reclaims an interrupted archive's scratch on the next backup run", async () => {
  await withBackupFixture({ prefix: "backup-scratch-next-run-" }, async (state) => {
    await isolateBackupScratch(state);
    const scratchRoot = state.path("scratch");
    const stale = await createBackupScratchDirectory(scratchRoot);
    const live = await createBackupScratchDirectory(scratchRoot);
    stale.release();
    try {
      await fs.writeFile(path.join(stale.directory, "config-0"), "abandoned");
      await fs.writeFile(path.join(live.directory, "config-0"), "active");
      const result = await createBackupArchive({
        output: state.path("backup.tar.gz"),
        onlyConfig: true,
      });
      expect(result.warnings ?? []).toEqual([]);
      await expect(fs.stat(stale.directory)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readdir(scratchRoot)).resolves.toEqual([path.basename(live.directory)]);
      await expect(fs.readFile(path.join(live.directory, "config-0"), "utf8")).resolves.toBe(
        "active",
      );
    } finally {
      await finishBackupScratch(live);
      vi.unstubAllEnvs();
    }
  });
});

it("records failed scratch cleanup without failing the published backup", async () => {
  await withBackupFixture({ prefix: "backup-scratch-cleanup-" }, async (state) => {
    await isolateBackupScratch(state);
    const scratchRoot = state.path("scratch");
    const remove = fs.rmdir.bind(fs);
    const removal = vi.spyOn(fs, "rmdir").mockImplementation(async (target) => {
      if (path.dirname(String(target)) === scratchRoot) {
        throw Object.assign(new Error("synthetic cleanup denied"), { code: "EACCES" });
      }
      return remove(target);
    });
    try {
      const log = vi.fn();
      const result = await createBackupArchive({
        output: state.path("backup.tar.gz"),
        onlyConfig: true,
        log,
      });
      const [scratch] = await fs.readdir(scratchRoot);
      expect(scratch).toMatch(/^openclaw-backup-/u);
      const warning = expect.stringContaining(path.join(scratchRoot, scratch!));
      expect(result.warnings).toEqual(expect.arrayContaining([warning]));
      expect(log).toHaveBeenCalledWith(warning);
      await expect(fs.stat(result.archivePath)).resolves.toMatchObject({
        size: expect.any(Number),
      });
      await expect(fs.stat(path.join(scratchRoot, scratch!, "owner.sqlite"))).rejects.toMatchObject(
        {
          code: "ENOENT",
        },
      );
      removal.mockRestore();
      const repaired = await maintainBackupScratch({ roots: [scratchRoot], repair: true });
      expect(repaired.reclaimed).toEqual([path.join(scratchRoot, scratch!)]);
      await expect(fs.readdir(scratchRoot)).resolves.toEqual([]);
    } finally {
      removal.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

it.each(["EPERM", "EXDEV"])("fails closed without hard-link support (%s)", async (code) => {
  const publicationSpy = vi
    .spyOn(directoryDurability, "publishFileExclusive")
    .mockRejectedValue(Object.assign(new Error("hard links unsupported"), { code }));
  try {
    await withBackupFixture({ prefix: "openclaw-backup-no-hardlinks-" }, async (state) => {
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
    });
  } finally {
    publicationSpy.mockRestore();
  }
});

describe("backup traversal", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["lstat", "open"] as const)(
    "records a file vanishing before %s and restores survivors",
    async (operation) => {
      await withBackupFixture({ layout: "split" }, async (state) => {
        await state.writeConfig({
          agents: { entries: { main: { workspace: state.workspaceDir } } },
        });
        const vanished = path.join(state.workspaceDir, "racing.json");
        const survivor = path.join(state.workspaceDir, "keep.txt");
        await fs.writeFile(vanished, "temporary contents");
        await fs.writeFile(survivor, "durable contents");
        let removed = false;
        const remove = (target: unknown) => {
          if (target === vanished && !removed) {
            fsSync.unlinkSync(vanished);
            removed = true;
          }
        };
        if (operation === "lstat") {
          // Keep the same race reproducible on both filesystem APIs used by the writers.
          const callbackLstat = fsSync.lstat;
          vi.spyOn(fsSync, "lstat").mockImplementation((...args) => {
            remove(args[0]);
            return callbackLstat(...args);
          });
          const original = fs.lstat;
          vi.spyOn(fs, "lstat").mockImplementation((...args) => {
            remove(args[0]);
            return original(...args);
          });
        } else {
          const callbackOpen = fsSync.open;
          vi.spyOn(fsSync, "open").mockImplementation((...args) => {
            remove(args[0]);
            return callbackOpen(...args);
          });
          const original = fs.open;
          vi.spyOn(fs, "open").mockImplementation((...args) => {
            remove(args[0]);
            return original(...args);
          });
        }
        const runtime = createTestRuntime();
        const result = await createVerifiedBackup(state, { includeWorkspace: true }, runtime);
        expect(removed).toBe(true);
        expect(result.skipped).toContainEqual(
          expect.objectContaining({ sourcePath: vanished, reason: "vanished" }),
        );
        expect(result.warnings).toContain(`Skipped vanished entry (ENOENT): ${vanished}`);
        expect(runtime.log).toHaveBeenCalledWith(
          expect.stringContaining(`Skipped vanished entry (ENOENT): ${vanished}`),
        );
        const entries = await listArchiveEntryDetails(result.archivePath);
        expect(entries.some((entry) => entry.path.endsWith("/racing.json"))).toBe(false);
        const keep = entries.find((entry) => entry.path.endsWith("/keep.txt"));
        expect(keep).toBeDefined();
        const restored = await restoreBackup(state, result, runtime);
        expect(await fs.readFile(path.join(restored.targetPath, keep!.path), "utf8")).toBe(
          "durable contents",
        );
      });
    },
  );

  it("reports transient files in a second workspace and preserves its dangling absolute link", async () => {
    await withBackupFixture({ layout: "split" }, async (state) => {
      const second = state.path("second-workspace");
      await fs.mkdir(second);
      await state.writeConfig({
        agents: {
          entries: { main: { workspace: state.workspaceDir }, second: { workspace: second } },
        },
      });
      const transient = ["pending.tmp", "queue.json.tmp.123.456"];
      for (const name of [...transient, "keep.txt"]) {
        await fs.writeFile(path.join(second, name), name);
      }
      const dangling = state.path("missing-target");
      const sourceLink = path.join(second, "dangling-link");
      await fs.symlink(dangling, sourceLink, process.platform === "win32" ? "junction" : "file");
      const linkpath = (await fs.readlink(sourceLink)).replaceAll(path.sep, "/");
      const result = await createVerifiedBackup(state, { includeWorkspace: true, json: true });
      const entries = await listArchiveEntryDetails(result.archivePath);
      expect(entries.some((entry) => entry.path.endsWith("/second-workspace/keep.txt"))).toBe(true);
      for (const name of transient) {
        expect(entries.some((entry) => entry.path.endsWith(`/second-workspace/${name}`))).toBe(
          false,
        );
        expect(result.skipped).toContainEqual(
          expect.objectContaining({ sourcePath: path.join(second, name), reason: "volatile" }),
        );
      }
      expect(result.skippedVolatileCount).toBe(2);
      const link = entries.find((entry) => entry.path.endsWith("/second-workspace/dangling-link"));
      expect(link).toMatchObject({ type: "SymbolicLink", linkpath });
      expect(result.externalSymbolicLinks).toContainEqual({
        entryPath: link!.path,
        linkpath,
      });
    });
  });

  it.each([
    "replace-before-open",
    "unlink-after-open",
    ...(fsSync.constants.O_NOFOLLOW ? ["replace-around-open" as const] : []),
  ] as const)("archives a complete regular file through %s", async (mutation) => {
    await withBackupFixture({ layout: "split" }, async (state) => {
      // Keep concurrent backups out of this fixture's warning inventory.
      await isolateBackupScratch(state);
      await state.writeConfig({ agents: { entries: { main: { workspace: state.workspaceDir } } } });
      const source = path.join(state.workspaceDir, "current.txt");
      const replacement = state.path("replacement");
      await fs.writeFile(source, "before");
      await fs.writeFile(replacement, "after");
      const open = fs.open;
      let mutated = false;
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        if (args[0] !== source || mutated) {
          return await open(...args);
        }
        mutated = true;
        if (mutation !== "unlink-after-open") {
          await fs.rename(replacement, source);
          const handle = await open(...args);
          if (mutation === "replace-around-open") {
            await fs.writeFile(replacement, "latest");
            await fs.rename(replacement, source);
          }
          return handle;
        }
        const handle = await open(...args);
        await fs.unlink(source);
        return handle;
      });
      const runtime = createTestRuntime();
      const archive = await createVerifiedBackup(state, { includeWorkspace: true }, runtime);
      const restored = await restoreBackup(state, archive, runtime);
      const archivedEntry = (await listArchiveEntryDetails(archive.archivePath)).find((entry) =>
        entry.path.endsWith("/current.txt"),
      );
      expect(mutated).toBe(true);
      expect(await fs.readFile(path.join(restored.targetPath, archivedEntry!.path), "utf8")).toBe(
        mutation === "unlink-after-open" ? "before" : "after",
      );
      expect(archive.warnings ?? []).toEqual([]);
    });
  });

  it.each(["ENOENT", "EACCES"])(
    "refuses missing required config or source I/O errors: %s",
    async (code) => {
      await withBackupFixture({}, async (state) => {
        await state.writeConfig({});
        const source =
          code === "ENOENT" ? state.configPath : await state.writeText("keep.txt", "data");
        const open = fs.open;
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          if (args[0] === source) {
            throw Object.assign(new Error(`injected ${code}`), { code, path: source });
          }
          return await open(...args);
        });
        const output = state.path("backup.tar.gz");
        await expect(
          backupCreateCommand(createTestRuntime(), { output, onlyConfig: code === "ENOENT" }),
        ).rejects.toThrow(
          code === "ENOENT" ? "Required backup source disappeared" : `injected ${code}`,
        );
        await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
  );

  it("reports many volatile paths without overflowing the restore manifest", async () => {
    await withBackupFixture({ layout: "split" }, async (state) => {
      await state.writeConfig({ agents: { entries: { main: { workspace: state.workspaceDir } } } });
      const files = Array.from({ length: 9_000 }, (_, index) =>
        path.join(state.workspaceDir, `pending-${index}.tmp.123`),
      );
      for (let offset = 0; offset < files.length; offset += 64) {
        await Promise.all(files.slice(offset, offset + 64).map((file) => fs.writeFile(file, "")));
      }
      const result = await createVerifiedBackup(state, { includeWorkspace: true, json: true });
      expect(result.verified).toBe(true);
      expect(result.skippedVolatileCount).toBe(files.length);
      expect(
        result.skipped
          .filter((entry) => entry.reason === "volatile")
          .map((entry) => entry.sourcePath)
          .toSorted(),
      ).toEqual(files.toSorted());
    });
  });
});
