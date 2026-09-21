import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as fsSafe from "./fs-safe.js";
import {
  copyUpdateCandidatePluginTrees,
  prepareUpdateCandidatePluginTrees,
} from "./update-candidate-plugin-tree.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

async function fixture(hardlink = false) {
  const root = await fs.realpath(dirs.make("candidate-plugin-copy-"));
  const source = path.join(root, "source");
  const targetStateDir = path.join(root, "snapshot");
  const candidateRoot = path.join(root, "candidate");
  const destination = path.join(targetStateDir, "plugin");
  await fs.mkdir(source);
  await fs.mkdir(candidateRoot);
  const file = path.join(source, "payload.txt");
  await fs.writeFile(file, "inventoried plugin bytes");
  await fs.chmod(file, 0o444);
  if (hardlink) {
    await fs.link(file, `${file}.linked`);
  }
  const plan = await prepareUpdateCandidatePluginTrees({
    roots: new Map([[source, destination]]),
    project: (entry) => path.join(destination, path.relative(source, entry)),
    targetStateDir,
    candidateRoot,
  });
  return {
    file,
    destination,
    plan,
    copy: () => copyUpdateCandidatePluginTrees(plan, { targetStateDir, candidateRoot }),
  };
}

function atCopyMutation(mutate: () => void) {
  const openRoot = fsSafe.root;
  vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
    const root = await openRoot(...args);
    const copyIn = root.copyIn.bind(root);
    vi.spyOn(root, "copyIn").mockImplementation((relative, source, options) =>
      copyIn(relative, source, {
        ...options,
        assertBeforeMutation: () => {
          mutate();
          options?.assertBeforeMutation?.();
        },
      }),
    );
    return root;
  });
}

it("copies a nonempty plugin without native support or sharing its source inode", async () => {
  const f = await fixture(true);
  const linked = `${f.file}.linked`;
  const before = await fs.stat(f.file, { bigint: true });
  vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
  try {
    // FreeBSD has no fs-safe native binding. Exercise its real portable backend.
    expect(getFsSafeNativeConfig().mode).toBe("off");
    await f.copy();
  } finally {
    vi.unstubAllEnvs();
  }
  const copied = path.join(f.destination, "payload.txt");
  const after = await fs.stat(f.file, { bigint: true });
  const snapshot = await fs.stat(copied, { bigint: true });
  expect(await fs.readFile(copied, "utf8")).toBe("inventoried plugin bytes");
  expect(await fs.readFile(linked, "utf8")).toBe("inventoried plugin bytes");
  expect(after).toMatchObject({
    ino: before.ino,
    mode: before.mode,
    size: before.size,
    mtimeNs: before.mtimeNs,
    ctimeNs: before.ctimeNs,
  });
  expect(snapshot.ino).not.toBe(before.ino);
  expect(snapshot.nlink).toBe(1n);
  if (process.platform !== "win32") {
    expect(snapshot.mode & 0o777n).toBe(0o444n);
  }
  expect(await fs.readdir(f.destination)).toEqual(["payload.txt", "payload.txt.linked"]);
});

it.each(["file", "symlink"] as const)(
  "preserves a %s that appears after missing-entry planning and cleans copy staging",
  async (kind) => {
    const f = await fixture();
    const target = path.join(f.destination, "payload.txt");
    let inserted = false;
    atCopyMutation(() => {
      if (inserted) {
        return;
      }
      inserted = true;
      if (kind === "file") {
        fsSync.writeFileSync(target, "existing private bytes", { flag: "wx" });
      } else {
        fsSync.symlinkSync(f.file, target);
      }
    });
    await expect(f.copy()).rejects.toThrow();
    expect(inserted).toBe(true);
    expect(await fs.readdir(f.destination)).toEqual(["payload.txt"]);
    expect(await fs.readFile(f.file, "utf8")).toBe("inventoried plugin bytes");
    if (kind === "file") {
      expect(await fs.readFile(target, "utf8")).toBe("existing private bytes");
    } else {
      expect(await fs.readlink(target)).toBe(f.file);
    }
  },
);

it.each(["mode", "same-size content with changed mtime", "identity"] as const)(
  "refuses %s changes at the copy mutation boundary before exposing plugin bytes",
  async (change) => {
    const f = await fixture();
    let mutated = false;
    atCopyMutation(() => {
      if (mutated) {
        return;
      }
      mutated = true;
      if (change === "identity") {
        fsSync.renameSync(f.file, `${f.file}.original`);
        fsSync.writeFileSync(f.file, "inventoried plugin bytes", { mode: 0o444 });
      } else if (change === "mode") {
        fsSync.chmodSync(f.file, 0o600);
      } else {
        const before = fsSync.lstatSync(f.file, { bigint: true });
        fsSync.chmodSync(f.file, 0o600);
        fsSync.writeFileSync(f.file, "altered but equal bytes!");
        fsSync.chmodSync(f.file, 0o444);
        // A same-tick rewrite can retain its timestamps; force a real fingerprint change.
        fsSync.utimesSync(f.file, before.atime, new Date(before.mtime.getTime() + 60_000));
        const changed = fsSync.lstatSync(f.file, { bigint: true });
        expect(changed).toMatchObject({
          dev: before.dev,
          ino: before.ino,
          size: before.size,
          mode: before.mode,
        });
        expect(changed.mtimeNs).not.toBe(before.mtimeNs);
      }
    });
    await expect(f.copy()).rejects.toThrow("changed after snapshot inventory");
    expect(mutated).toBe(true);
    expect(await fs.readdir(f.destination)).toEqual([]);
  },
);
