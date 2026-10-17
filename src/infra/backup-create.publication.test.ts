import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expect, it, vi, afterEach, describe } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { backupCreateCommand } from "../commands/backup.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import {
  backupCase,
  isolateBackupScratch,
  createVerifiedBackup,
  restoreBackup,
  expectAbsent,
  writeFiles,
} from "./backup-create-family.test-support.js";
import { writeArchiveStreamToFile } from "./backup-create-stream.js";
import { createBackupArchive } from "./backup-create.js";
import { listArchiveEntryDetails } from "./backup-create.test-support.js";
import {
  createBackupScratchDirectory,
  finishBackupScratch,
  maintainBackupScratch,
} from "./backup-scratch.js";

function beforeCall<Args extends unknown[], Result>(
  run: (...args: Args) => Result,
  before: (target: Args[0]) => void,
) {
  return (...args: Args) => {
    before(args[0]);
    return run(...args);
  };
}

it(
  "reclaims an interrupted archive's scratch on the next backup run",
  backupCase({ prefix: "backup-scratch-next-run-" })(async (state) => {
    const scratchRoot = state.path("scratch");
    await fs.mkdir(scratchRoot);
    vi.stubEnv("TMPDIR", scratchRoot);
    const stale = await createBackupScratchDirectory(scratchRoot);
    const live = await createBackupScratchDirectory(scratchRoot);
    stale.release();
    try {
      await fs.writeFile(path.join(stale.directory, "config-0"), "abandoned");
      await fs.writeFile(path.join(live.directory, "config-0"), "active");
      await createBackupArchive({ output: state.path("backup.tar.gz"), onlyConfig: true });
      await expectAbsent(stale.directory);
      await expect(fs.readFile(path.join(live.directory, "config-0"), "utf8")).resolves.toBe(
        "active",
      );
    } finally {
      await finishBackupScratch(live);
      vi.unstubAllEnvs();
    }
  }),
);

it(
  "records failed scratch cleanup without failing the published backup",
  backupCase({ prefix: "backup-scratch-cleanup-" })(async (state) => {
    const scratchRoot = state.path("scratch");
    await fs.mkdir(scratchRoot);
    vi.stubEnv("TMPDIR", scratchRoot);
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
      await fs.access(result.archivePath);
      await expectAbsent(path.join(scratchRoot, scratch!, "owner.sqlite"));
      removal.mockRestore();
      const repaired = await maintainBackupScratch({ roots: [scratchRoot], repair: true });
      expect(repaired.reclaimed).toEqual([path.join(scratchRoot, scratch!)]);
      await expect(fs.readdir(scratchRoot)).resolves.toEqual([]);
    } finally {
      removal.mockRestore();
      vi.unstubAllEnvs();
    }
  }),
);

describe("backup traversal", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["lstat", "open"] as const)(
    "records a file vanishing before %s and restores survivors",
    backupCase({ layout: "split" })(async (state, operation: string) => {
      await state.writeConfig({ agents: { entries: { main: { workspace: state.workspaceDir } } } });
      const vanished = path.join(state.workspaceDir, "racing.json");
      await writeFiles(state.workspaceDir, {
        "racing.json": "temporary contents",
        "keep.txt": "durable contents",
      });
      let removed = false;
      const remove = (target: unknown) => {
        if (target === vanished && !removed) {
          fsSync.unlinkSync(vanished);
          removed = true;
        }
      };
      if (operation === "lstat") {
        // Keep the same race reproducible on both filesystem APIs used by the writers.
        const syncLstat = beforeCall(fsSync.lstat, remove);
        const lstat = beforeCall(fs.lstat, remove);
        vi.spyOn(fsSync, "lstat").mockImplementation(syncLstat);
        vi.spyOn(fs, "lstat").mockImplementation(lstat);
      } else {
        const syncOpen = beforeCall(fsSync.open, remove);
        const open = beforeCall(fs.open, remove);
        vi.spyOn(fsSync, "open").mockImplementation(syncOpen);
        vi.spyOn(fs, "open").mockImplementation(open);
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
    }),
  );

  it.each(["second workspace", "large inventory"])(
    "reports volatile paths: %s",
    backupCase({ layout: "split" })(async (state, mode: string) => {
      const second = mode === "second workspace";
      const workspace = second ? state.path("second-workspace") : state.workspaceDir;
      await fs.mkdir(workspace, { recursive: true });
      const main = { workspace: state.workspaceDir };
      const agents = second ? { main, second: { workspace } } : { main };
      await state.writeConfig({ agents: { entries: agents } });
      const transient = second
        ? ["pending.tmp", "queue.json.tmp.123.456"]
        : Array.from({ length: 9_000 }, (_, index) => `pending-${index}.tmp.123`);
      const files = transient.map((name) => path.join(workspace, name));
      for (let offset = 0; offset < files.length; offset += 64) {
        await Promise.all(files.slice(offset, offset + 64).map((file) => fs.writeFile(file, "")));
      }
      const sourceLink = path.join(workspace, "dangling-link");
      let linkpath = "";
      if (second) {
        await fs.writeFile(path.join(workspace, "keep.txt"), "keep.txt");
        await fs.symlink(
          state.path("missing-target"),
          sourceLink,
          process.platform === "win32" ? "junction" : "file",
        );
        linkpath = (await fs.readlink(sourceLink)).replaceAll(path.sep, "/");
      }
      const result = await createVerifiedBackup(state, { includeWorkspace: true, json: true });
      expect(result).toMatchObject({ verified: true, skippedVolatileCount: files.length });
      if (second) {
        const entries = await listArchiveEntryDetails(result.archivePath);
        const prefix = "/second-workspace/";
        const find = (name: string) => entries.find((entry) => entry.path.endsWith(prefix + name));
        expect(find("keep.txt")).toBeDefined();
        for (const name of transient) {
          expect(find(name)).toBeUndefined();
          expect(result.skipped).toContainEqual(
            expect.objectContaining({ sourcePath: path.join(workspace, name), reason: "volatile" }),
          );
        }
        const link = find("dangling-link");
        expect(link).toMatchObject({ type: "SymbolicLink", linkpath });
        expect(result.externalSymbolicLinks).toContainEqual({ entryPath: link!.path, linkpath });
      } else {
        expect(
          result.skipped
            .filter((entry) => entry.reason === "volatile")
            .map((entry) => entry.sourcePath)
            .toSorted(),
        ).toEqual(files.toSorted());
      }
    }),
  );

  it.each([
    "replace-before-open",
    "unlink-after-open",
    ...(fsSync.constants.O_NOFOLLOW ? ["replace-around-open" as const] : []),
  ] as const)(
    "archives a complete regular file through %s",
    backupCase({ layout: "split" })(async (state, mutation: string) => {
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
    }),
  );

  it.each(["ENOENT", "EACCES"])(
    "refuses missing required config or source I/O errors: %s",
    backupCase({})(async (state, code: string) => {
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
      await expectAbsent(output);
    }),
  );
});

describe("backup stream lifecycle", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  type ReportBackupProgress = Parameters<
    Parameters<typeof writeArchiveStreamToFile>[0]["createArchiveStream"]
  >[0];

  function startArchive() {
    const archivePath = path.join(tempDirs.make("openclaw-backup-stream-"), "partial.tar.gz");
    const archiveStream = new PassThrough();
    let progress: ReportBackupProgress | undefined;
    const writePromise = writeArchiveStreamToFile({
      archivePath,
      createArchiveStream: (report) => {
        progress = report;
        return archiveStream;
      },
      onPartialArchive: vi.fn(),
    });
    return {
      archivePath,
      archiveStream,
      writePromise,
      reportProgress: (...args: Parameters<ReportBackupProgress>) => progress?.(...args),
    };
  }

  it("removes the exclusive partial archive when its initial descriptor stat fails", async () => {
    vi.spyOn(fsSync, "fstatSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("fstat failed"), { code: "EIO" });
    });
    const { archivePath, archiveStream, writePromise } = startArchive();
    archiveStream.end("partial archive");
    await expect(writePromise).rejects.toThrow("fstat failed");
    await expect(fs.lstat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([false, true])("cleans a stalled archive (entry suffix=%s)", async (withEntry) => {
    vi.useFakeTimers();
    const { archivePath, archiveStream, writePromise, reportProgress } = startArchive();
    const expectedPath = `${"a".repeat(170)}/${"b".repeat(170)}/${"c".repeat(169)}`;
    if (withEntry) {
      reportProgress({ phase: "raw", entryPath: `/source/🤖${expectedPath}`, bytes: 16 });
    }
    archiveStream.write("partial archive");
    const reason = "Backup archive write stalled: no progress observed for 300000ms";
    const suffix = withEntry
      ? ` (phase=output, entry=${JSON.stringify(expectedPath)}, rawBytes=16, outputBytes=15)`
      : "";
    const rejection = expect(writePromise).rejects.toThrow(`${reason}${suffix}`);
    await vi.advanceTimersByTimeAsync(300_001);
    await rejection;
    expect(archiveStream.destroyed).toBe(true);
    await expect(fs.lstat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the archive alive through more than five minutes of one entry's raw bytes", async () => {
    vi.useFakeTimers();
    const { archivePath, archiveStream, writePromise, reportProgress } = startArchive();
    for (let elapsed = 0; elapsed < 360_000; elapsed += 60_000) {
      await vi.advanceTimersByTimeAsync(60_000);
      reportProgress({ phase: "raw", entryPath: "/source/large.pack", bytes: 16 });
    }
    archiveStream.end("archive after one large entry");

    await expect(writePromise).resolves.toMatchObject({ archivePath });
    await expect(fs.readFile(archivePath, "utf8")).resolves.toBe("archive after one large entry");
  });
});
