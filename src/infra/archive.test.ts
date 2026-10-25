import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import * as tar from "tar";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { withRealpathSymlinkRebindRace } from "../test-utils/symlink-rebind-race.js";
import { createZipCentralDirectoryArchive } from "../test-utils/zip-central-directory-fixture.js";
import { extractArchive, resolvePackedRootDir, type ExtractArchiveOptions } from "./archive.js";

const fixtureRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-archive-" });
const directorySymlinkType = process.platform === "win32" ? "junction" : undefined;
const ARCHIVE_EXTRACT_TIMEOUT_MS = 15_000;

async function withArchiveCase(
  ext: "zip" | "tar",
  run: (params: { workDir: string; archivePath: string; extractDir: string }) => Promise<void>,
) {
  const workDir = await fixtureRootTracker.make(ext);
  const archivePath = path.join(workDir, `bundle.${ext}`);
  const extractDir = path.join(workDir, "extract");
  await fs.mkdir(extractDir, { recursive: true });
  await run({ workDir, archivePath, extractDir });
}

async function writeArchive(
  ext: "zip" | "tar",
  workDir: string,
  archivePath: string,
  fileName = "package/hello.txt",
  content = "hi",
) {
  if (ext === "zip") {
    const zip = new JSZip();
    zip.file(fileName, content);
    await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
    return;
  }

  const input = path.join(workDir, "input");
  await fs.mkdir(path.dirname(path.join(input, fileName)), { recursive: true });
  await fs.writeFile(path.join(input, fileName), content);
  await tar.c({ cwd: input, file: archivePath }, [fileName.split("/")[0]!]);
}

async function createDirectorySymlink(targetDir: string, linkPath: string) {
  await fs.symlink(targetDir, linkPath, directorySymlinkType);
}

function extract(
  archivePath: string,
  destDir: string,
  options: Partial<ExtractArchiveOptions> = {},
) {
  return extractArchive({
    archivePath,
    destDir,
    timeoutMs: ARCHIVE_EXTRACT_TIMEOUT_MS,
    ...options,
  });
}

async function expectRejectedCode(promise: Promise<unknown>, expected: string | RegExp) {
  await expect(promise).rejects.toHaveProperty(
    "code",
    typeof expected === "string" ? expected : expect.stringMatching(expected),
  );
}

async function expectPathMissing(filePath: string) {
  await expectRejectedCode(fs.stat(filePath), "ENOENT");
}

beforeAll(() => fixtureRootTracker.setup());
afterAll(() => fixtureRootTracker.cleanup());

describe("archive utils", () => {
  it("rejects the returned promise when an option getter throws", async () => {
    const failure = new Error("archive kind unavailable");
    await expect(
      extractArchive({
        archivePath: "/unused/archive.tar",
        destDir: "/unused/extracted",
        timeoutMs: ARCHIVE_EXTRACT_TIMEOUT_MS,
        get kind(): never {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
  });

  it.each(
    (["zip", "tar"] as const).flatMap((ext) =>
      [undefined, true, false].map((durable) => ({ ext, durable })),
    ),
  )("extracts $ext archives with durable=$durable", async ({ ext, durable }) => {
    await withArchiveCase(ext, async ({ workDir, archivePath, extractDir }) => {
      await writeArchive(ext, workDir, archivePath);
      const extractedPath = path.join(await fs.realpath(extractDir), "package", "hello.txt");
      let fileSyncs = 0;
      const originalOpen = fs.open;
      const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await originalOpen(...args);
        if (String(args[0]) === extractedPath) {
          const sync = handle.sync.bind(handle);
          handle.sync = async () => {
            fileSyncs++;
            await sync();
          };
        }
        return handle;
      });
      try {
        await extractArchive(
          Object.freeze(
            new (class {
              get archivePath() {
                return archivePath;
              }
              get destDir() {
                return extractDir;
              }
              get timeoutMs() {
                return ARCHIVE_EXTRACT_TIMEOUT_MS;
              }
              get durable() {
                return durable;
              }
            })(),
          ),
        );
      } finally {
        openSpy.mockRestore();
      }
      expect(fileSyncs > 0).toBe(durable !== false);
      const rootDir = await resolvePackedRootDir(extractDir);
      const content = await fs.readFile(path.join(rootDir, "hello.txt"), "utf-8");
      expect(content).toBe("hi");
    });
  });

  it.each([{ ext: "zip" as const }, { ext: "tar" as const }])(
    "rejects $ext extraction when destination dir is a symlink",
    async ({ ext }) => {
      await withArchiveCase(ext, async ({ workDir, archivePath, extractDir }) => {
        const realExtractDir = path.join(workDir, "real-extract");
        await fs.mkdir(realExtractDir, { recursive: true });
        await writeArchive(ext, workDir, archivePath);
        await fs.rm(extractDir, { recursive: true, force: true });
        await createDirectorySymlink(realExtractDir, extractDir);

        await expectRejectedCode(extract(archivePath, extractDir), "destination-symlink");

        await expectPathMissing(path.join(realExtractDir, "package", "hello.txt"));
      });
    },
  );

  it.each([{ createFolders: true }, { createFolders: false }])(
    "rejects zip path traversal (zip slip, createFolders=$createFolders)",
    async ({ createFolders }) => {
      await withArchiveCase("zip", async ({ archivePath, extractDir }) => {
        const zip = new JSZip();
        zip.file("../b/evil.txt", "pwnd", { createFolders });
        await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));

        await expect(extract(archivePath, extractDir)).rejects.toThrow(
          /(escapes destination|absolute)/i,
        );
        await expectPathMissing(path.join(extractDir, "b", "evil.txt"));
      });
    },
  );

  it.each(["zip", "tar"] as const)(
    "rejects %s entries traversing destination symlinks",
    async (ext) => {
      await withArchiveCase(ext, async ({ workDir, archivePath, extractDir }) => {
        const outsideDir = path.join(workDir, "outside");
        await fs.mkdir(outsideDir, { recursive: true });
        await createDirectorySymlink(outsideDir, path.join(extractDir, "escape"));

        await writeArchive(ext, workDir, archivePath, "escape/pwn.txt", "owned");

        await expectRejectedCode(extract(archivePath, extractDir), "destination-symlink-traversal");

        await expectPathMissing(path.join(outsideDir, "pwn.txt"));
      });
    },
  );

  it("does not clobber an out-of-destination file during a zip symlink-rebind race", async () => {
    await withArchiveCase("zip", async ({ workDir, archivePath, extractDir }) => {
      const outsideDir = path.join(workDir, "outside");
      await fs.mkdir(outsideDir, { recursive: true });
      const slotDir = path.join(extractDir, "slot");
      await fs.mkdir(slotDir, { recursive: true });

      const outsideTarget = path.join(outsideDir, "target.txt");
      await fs.writeFile(outsideTarget, "SAFE");

      const zip = new JSZip();
      zip.file("slot/target.txt", "owned");
      await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));

      let rejected = false;
      try {
        await withRealpathSymlinkRebindRace({
          shouldFlip: (realpathInput) => realpathInput === slotDir,
          symlinkPath: slotDir,
          symlinkTarget: outsideDir,
          timing: "after-realpath",
          realpathApi: "native-sync",
          run: async () => {
            await extract(archivePath, extractDir);
          },
        });
      } catch (error) {
        rejected = true;
        const code = (error as { code?: unknown }).code;
        expect(String(code)).toMatch(/destination-symlink-traversal|not-file/);
      }

      expect((await fs.lstat(slotDir)).isSymbolicLink()).toBe(true);
      await expect(fs.readFile(outsideTarget, "utf8")).resolves.toBe("SAFE");
      if (!rejected) {
        await expect(fs.readFile(path.join(slotDir, "target.txt"), "utf8")).resolves.toBe("owned");
      }
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects zip extraction when a hardlink appears during destination verification",
    async () => {
      await withArchiveCase("zip", async ({ workDir, archivePath, extractDir }) => {
        const outsideDir = path.join(workDir, "outside");
        await fs.mkdir(outsideDir, { recursive: true });
        const outsideAlias = path.join(outsideDir, "payload.bin");
        const extractedPath = path.join(extractDir, "package", "payload.bin");

        const zip = new JSZip();
        zip.file("package/payload.bin", "owned");
        await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
        const extractedRealPath = path.join(
          await fs.realpath(extractDir),
          "package",
          "payload.bin",
        );

        const realLstat = fsSync.lstatSync.bind(fsSync);
        let linked = false;
        const lstatSpy = vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
          const observed = realLstat(...args);
          if (!linked && String(args[0]) === extractedRealPath) {
            fsSync.linkSync(extractedRealPath, outsideAlias);
            linked = true;
            return realLstat(...args);
          }
          return observed;
        });

        try {
          await expectRejectedCode(
            extract(archivePath, extractDir),
            /^(?:destination-symlink-traversal|hardlink)$/u,
          );
        } finally {
          lstatSpy.mockRestore();
        }

        // The raced alias points at attacker-supplied archive bytes. The rejected
        // extraction preserves the published destination rather than unlinking an
        // entry it can no longer prove it owns; truncating the inode would instead
        // mutate a path outside that boundary.
        await expect(fs.readFile(outsideAlias, "utf8")).resolves.toBe("owned");
        await expect(fs.readFile(extractedPath, "utf8")).resolves.toBe("owned");
        expect((await fs.stat(extractedPath)).nlink).toBe(2);
      });
    },
  );

  it.each([{ ext: "zip" as const }, { ext: "tar" as const }])(
    "rejects $ext archives that exceed extracted size budget",
    async ({ ext }) => {
      await withArchiveCase(ext, async ({ workDir, archivePath, extractDir }) => {
        await writeArchive(ext, workDir, archivePath, "package/big.txt", "x".repeat(64));

        await expect(
          extract(archivePath, extractDir, { limits: { maxExtractedBytes: 32 } }),
        ).rejects.toThrow("archive extracted size exceeds limit");
      });
    },
  );

  it.each([{ ext: "zip" as const }, { ext: "tar" as const }])(
    "rejects $ext archives that exceed archive size budget",
    async ({ ext }) => {
      await withArchiveCase(ext, async ({ workDir, archivePath, extractDir }) => {
        await writeArchive(ext, workDir, archivePath, "package/file.txt", "ok");
        const stat = await fs.stat(archivePath);

        await expect(
          extract(archivePath, extractDir, {
            limits: { maxArchiveBytes: Math.max(1, stat.size - 1) },
          }),
        ).rejects.toThrow("archive size exceeds limit");
      });
    },
  );

  it("rejects zip archives whose actual central directory exceeds the entry limit before parsing", async () => {
    await withArchiveCase("zip", async ({ archivePath, extractDir }) => {
      const archiveBytes = createZipCentralDirectoryArchive({
        actualEntryCount: 2,
        declaredEntryCount: 1,
      });
      await fs.writeFile(archivePath, archiveBytes);

      await expect(extract(archivePath, extractDir, { limits: { maxEntries: 1 } })).rejects.toThrow(
        "archive entry count exceeds limit",
      );
      expect(await fs.readdir(extractDir)).toEqual([]);
    });
  });

  it.each(["relative", "absolute"] as const)("rejects tar %s path traversal", async (kind) => {
    await withArchiveCase("tar", async ({ workDir, archivePath, extractDir }) => {
      const inputDir = path.join(workDir, "input");
      const absolute = kind === "absolute";
      const outsideFile = path.join(absolute ? inputDir : workDir, "outside.txt");
      await fs.mkdir(inputDir, { recursive: true });
      await fs.writeFile(outsideFile, absolute ? "owned" : "pwnd");
      await tar.c({ cwd: inputDir, file: archivePath, preservePaths: absolute }, [
        absolute ? outsideFile : "../outside.txt",
      ]);
      await fs.writeFile(outsideFile, "outside sentinel");
      await expectRejectedCode(extract(archivePath, extractDir), "entry-path");
      expect(await fs.readdir(extractDir)).toEqual([]);
      expect(await fs.readFile(outsideFile, "utf8")).toBe("outside sentinel");
    });
  });
});
