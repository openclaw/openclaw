import { execFileSync } from "node:child_process";
import { once } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  recordArchiveSymbolicLink,
  type BackupSymbolicLink,
} from "./backup-archive-path-policy.js";
import { walkBackupTar } from "./backup-tar-walk.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, constants: { ...actual.constants, O_NOFOLLOW: 0 } };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.skipIf(process.platform === "win32")(
  "rejects a raced FIFO before waiting for a writer or emitting its header",
  async () => {
    const source = path.join(tempDirs.make("backup-fifo-swap-"), "payload.txt");
    await fs.writeFile(source, "original payload");
    const nativeOpen = fs.open;
    let writerNeeded = false;
    let writerTimer: ReturnType<typeof setTimeout> | undefined;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (args[0] === source) {
        await fs.rename(source, `${source}.original`);
        execFileSync("mkfifo", [source]);
        // Release the old blocking reader so RED can fail without leaking a worker.
        writerTimer = setTimeout(() => {
          writerNeeded = true;
          const writer = fsSync.openSync(
            source,
            fsSync.constants.O_WRONLY | fsSync.constants.O_NONBLOCK,
          );
          fsSync.closeSync(writer);
        }, 500);
      }
      return await nativeOpen(...args);
    });
    const chunks: Buffer[] = [];
    try {
      await expect(collectArchive(source, chunks)).rejects.toThrow(
        "Backup source changed while opening",
      );
      expect(writerNeeded).toBe(false);
      expect(chunks).toEqual([]);
    } finally {
      clearTimeout(writerTimer);
    }
  },
);

async function collectArchive(
  source: string,
  chunks: Buffer[],
  callbacks: Partial<Pick<Parameters<typeof walkBackupTar>[0], "onEntry" | "onVanished">> = {},
) {
  for await (const chunk of walkBackupTar({
    tar,
    paths: [source],
    skip: () => false,
    filter: () => true,
    onEntry: (_source, header) => {
      header.path = "payload";
    },
    onVanished: () => {
      throw new Error("unexpected missing entry");
    },
    onProgress: () => {},
    ...callbacks,
  })) {
    chunks.push(chunk);
  }
}

async function writeSource(root: string, body: string) {
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, "keep.txt");
  await fs.writeFile(file, body);
  return file;
}

it("archives a source whose exact file ID exceeds Number precision", async () => {
  const source = path.join(tempDirs.make("backup-exact-identity-"), "payload.txt");
  const payload = "exact file identity";
  await fs.writeFile(source, payload);
  const ino = (1n << 63n) + 1n;
  function setInode<T extends { ino: number | bigint }>(stat: T): T {
    Object.defineProperty(stat, "ino", { value: typeof stat.ino === "bigint" ? ino : Number(ino) });
    return stat;
  }
  const lstat = fs.lstat;
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
    const observed = await lstat(...args);
    return args[0] === source ? setInode(observed) : observed;
  });
  const open = fs.open;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] === source) {
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementation(async (options) => setInode(await stat(options)));
    }
    return handle;
  });
  const chunks: Buffer[] = [];
  await collectArchive(source, chunks);
  const entries: Array<Promise<{ path: string; body: string }>> = [];
  const parser = new tar.Parser({
    onReadEntry(entry) {
      entries.push(entry.concat().then((body) => ({ path: entry.path, body: body.toString() })));
    },
  });
  const done = once(parser, "end");
  parser.end(Buffer.concat(chunks));
  await done;
  expect(await Promise.all(entries)).toEqual([{ path: "payload", body: payload }]);
});

it.each([
  { encoding: "header", target: String.raw`C:\external\workspace` },
  { encoding: "PAX", target: "C:\\external\\" + "workspace".repeat(15) },
])("records Windows $encoding link targets matching tar readback", async ({ target }) => {
  const source = path.join(tempDirs.make("backup-windows-link-"), "link");
  await fs.symlink(target, source, process.platform === "win32" ? "junction" : "file");
  const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const manifestLinks: BackupSymbolicLink[] = [];
  const chunks: Buffer[] = [];
  const state = { sourcePath: "C:\\state", archivePath: "backup/payload/state" };
  try {
    await collectArchive(source, chunks, {
      onEntry: (_source, header) => {
        header.path = "backup/payload/state/link";
        const { external, ...link } = recordArchiveSymbolicLink({
          archiveRoot: "backup",
          entryPath: header.path,
          linkpath: header.linkpath,
          platform: process.platform,
          state,
          assets: [state],
          hasExternalLinkReport: true,
        });
        if (external) {
          manifestLinks.push(link);
        }
      },
    });
  } finally {
    platform.mockRestore();
  }
  // Tar captures its platform at import time; a fresh reader exercises its Windows mode.
  const readback = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { Parser } from "tar";
    const links = [];
    const parser = new Parser({ onReadEntry(entry) {
      links.push({ entryPath: entry.path, linkpath: entry.linkpath });
      entry.resume();
    }});
    parser.on("end", () => process.stdout.write(JSON.stringify(links)));
    process.stdin.pipe(parser);
  `,
    ],
    {
      input: Buffer.concat(chunks),
      env: { ...process.env, TESTING_TAR_FAKE_PLATFORM: "win32" },
      encoding: "utf8",
    },
  );
  expect(JSON.parse(readback)).toEqual([
    { entryPath: "backup/payload/state/link", linkpath: target.replaceAll("\\", "/") },
  ]);
  expect(manifestLinks).toEqual(JSON.parse(readback));
});

it
  .skipIf(process.platform === "win32")
  .each(["readdir", "open", "leaf-open-without-nofollow", "unlinked-leaf-open"] as const)(
  "refuses a source replaced by an external symlink during %s",
  async (operation) => {
    const temp = tempDirs.make("backup-directory-swap-");
    const root = path.join(temp, "source");
    const directory = path.join(root, "changing");
    const outside = path.join(temp, "outside");
    const selected = await writeSource(directory, "selected bytes");
    const external = await writeSource(outside, "out-of-scope bytes");
    let swapped = false;
    const swap = async () => {
      if (swapped) {
        return;
      }
      await fs.rename(directory, path.join(temp, "retired"));
      await fs.symlink(outside, directory, "dir");
      swapped = true;
    };
    if (operation === "readdir") {
      const readdir = fs.readdir;
      vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
        if (args[0] === directory) {
          await swap();
        }
        return await readdir(...args);
      });
    } else {
      const open = fs.open;
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        if (args[0] === selected) {
          if (operation === "leaf-open-without-nofollow" || operation === "unlinked-leaf-open") {
            const replacement = path.join(temp, "replacement-link");
            await fs.symlink(external, replacement);
            await fs.rename(replacement, args[0]);
            swapped = true;
            // Windows lacks O_NOFOLLOW; keep a real handle with that open behavior.
            const handle = await open(args[0], "r");
            if (operation === "unlinked-leaf-open") {
              await fs.unlink(args[0]);
            }
            return handle;
          }
          await swap();
        }
        return await open(...args);
      });
    }
    const chunks: Buffer[] = [];
    await expect(collectArchive(root, chunks)).rejects.toThrow(
      /Backup (directory changed|source became a symbolic link|source identity changed)/u,
    );
    expect(swapped).toBe(true);
    expect(Buffer.concat(chunks).includes(Buffer.from("out-of-scope bytes"))).toBe(false);
  },
);

it("refuses a required root removed during a descendant open", async () => {
  const temp = tempDirs.make("backup-root-removal-");
  const root = path.join(temp, "source");
  const file = await writeSource(root, "selected bytes");
  const open = fs.open;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    if (args[0] === file) {
      await fs.rename(root, path.join(temp, "retired"));
    }
    return await open(...args);
  });
  const onVanished = vi.fn();
  const chunks: Buffer[] = [];
  await expect(collectArchive(root, chunks, { onVanished })).rejects.toMatchObject({
    code: "ENOENT",
    path: root,
  });
  expect(onVanished).toHaveBeenCalledWith(file);
  expect(Buffer.concat(chunks).length).toBeGreaterThan(0);
});
