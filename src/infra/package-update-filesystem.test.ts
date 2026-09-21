import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { copyPackagePathEntry } from "./package-update-filesystem.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.runIf(process.platform === "darwin").each([0o700, 0o755])(
  "preserves symlink mode %s without following its target",
  async (mode) => {
    const root = dirs.make("package-launcher-mode-");
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    const target = path.join(root, "target");
    await fs.writeFile(target, "target contents", { mode: 0o640 });
    await fs.symlink("target", source);
    await fs.lchmod(source, mode);
    const targetStat = await fs.stat(target);
    const symlink = fs.symlink.bind(fs);
    vi.spyOn(fs, "symlink").mockImplementation(async (...args) => {
      await symlink(...args);
      await fs.lchmod(args[1], mode === 0o700 ? 0o755 : 0o700);
    });

    await copyPackagePathEntry(source, destination);
    expect(await fs.readlink(destination)).toBe("target");
    expect((await fs.lstat(destination)).mode).toBe((await fs.lstat(source)).mode);
    expect((await fs.stat(target)).mode).toBe(targetStat.mode);
    expect(await fs.readFile(target, "utf8")).toBe("target contents");
    await fs.unlink(target);
    await copyPackagePathEntry(source, destination);
    expect((await fs.lstat(destination)).mode).toBe((await fs.lstat(source)).mode);
    expect(await fs.readlink(destination)).toBe("target");
  },
);

it.runIf(process.platform === "darwin").each([
  { operation: "lchmod", code: "EPERM", continues: true },
  { operation: "lchown", code: "EPERM", continues: true },
  { operation: "lchmod", code: "ENOSYS", continues: true },
  { operation: "lchmod", code: "EIO", continues: false },
] as const)(
  "handles symlink $operation failure $code without following the target",
  async ({ operation, code, continues }) => {
    const root = dirs.make("package-launcher-metadata-");
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    await fs.symlink("missing", source);
    await fs.writeFile(destination, "live launcher");
    vi.spyOn(fs, operation).mockRejectedValueOnce(
      Object.assign(new Error("link metadata denied"), { code }),
    );

    if (continues) {
      await expect(copyPackagePathEntry(source, destination)).resolves.toEqual({
        ownershipPreserved: operation !== "lchown",
      });
      expect(await fs.readlink(destination)).toBe("missing");
    } else {
      await expect(copyPackagePathEntry(source, destination)).rejects.toThrow(
        "link metadata denied",
      );
      expect(await fs.readFile(destination, "utf8")).toBe("live launcher");
    }
    expect((await fs.readdir(root)).toSorted()).toEqual(["destination", "source"]);
  },
);

it("keeps the live launcher intact when its replacement copy is interrupted", async () => {
  const root = dirs.make("package-launcher-copy-");
  const source = path.join(root, "retained-launcher");
  const destination = path.join(root, "live-launcher");
  await fs.writeFile(source, "previous launcher\n");
  await fs.writeFile(destination, "candidate launcher\n");
  const copy = vi.spyOn(fs, "copyFile").mockImplementationOnce(async (_source, staged) => {
    await fs.writeFile(staged, "partial launcher");
    throw new Error("interrupted launcher copy");
  });

  await expect(copyPackagePathEntry(source, destination)).rejects.toThrow(
    "interrupted launcher copy",
  );
  expect(await fs.readFile(destination, "utf8")).toBe("candidate launcher\n");
  expect((await fs.readdir(root)).toSorted()).toEqual(["live-launcher", "retained-launcher"]);

  copy.mockRestore();
  await copyPackagePathEntry(source, destination);
  expect(await fs.readFile(destination, "utf8")).toBe("previous launcher\n");
});

it("retains an occupied obsolete backup without multiplying retries by directory depth", async () => {
  const root = dirs.make("package-backup-occupied-");
  const backup = path.join(root, ".openclaw.package-backup-fixture");
  const locked = path.join(backup, "nested", "native.node");
  await fs.mkdir(path.dirname(locked), { recursive: true });
  await fs.writeFile(locked, "occupied native module");
  const current = path.join(root, "openclaw");
  await fs.mkdir(current);
  await fs.writeFile(path.join(current, "package.json"), "current installation");
  // Start before Node lazily captures fs.unlink for its real recursive-removal
  // implementation. The occupied leaf is the only fake: traversal, retirement,
  // rename, error handling, and preserved bytes use the real filesystem/owner.
  const script = `
    const fs = require('node:fs');
    const timers = require('node:timers');
    const input = JSON.parse(process.argv[1]);
    let attempts = 0, scheduledDelayMs = 0;
    const unlink = fs.unlink;
    const timeout = timers.setTimeout;
    fs.unlink = function (target, callback) {
      if (String(target) === input.locked) {
        attempts++;
        return queueMicrotask(() => callback(Object.assign(new Error('occupied'), {code:'EBUSY'})));
      }
      return Reflect.apply(unlink, this, arguments);
    };
    timers.setTimeout = function (fn, delay, ...args) {
      if (fn.name === '_rimraf') {
        scheduledDelayMs += delay;
        return setImmediate(fn, ...args);
      }
      return timeout(fn, delay, ...args);
    };
    (async () => {
      await import('./scripts/tsx.mjs');
      const { discardPackageUpdateBackup } = await import(input.module);
      const message = await discardPackageUpdateBackup(input.backup, 'old package', input.root);
      console.log(JSON.stringify({attempts, scheduledDelayMs, message}));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "-e",
      script,
      JSON.stringify({
        root,
        backup,
        locked,
        module: new URL("./package-update-filesystem.ts", import.meta.url).href,
      }),
    ],
    { cwd: process.cwd(), timeout: 30_000 },
  );
  const observed = JSON.parse(stdout.trim());
  expect(observed.attempts).toBe(1);
  expect(observed.scheduledDelayMs).toBe(0);
  const retained = path.join(root, ".openclaw-package-backup-fixture");
  expect(observed.message).toBe(`preserved old package at ${retained} for delayed cleanup`);
  expect(await fs.readFile(path.join(retained, "nested", "native.node"), "utf8")).toBe(
    "occupied native module",
  );
  expect(await fs.readFile(path.join(current, "package.json"), "utf8")).toBe(
    "current installation",
  );
});
