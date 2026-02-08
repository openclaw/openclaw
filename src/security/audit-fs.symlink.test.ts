import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { safeStat, inspectPathPermissions } from "./audit-fs.js";

const isWin = process.platform === "win32";

describe("safeStat symlink handling", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const d of dirs) {
      await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
    }
    dirs.length = 0;
  });

  it.skipIf(isWin)("returns target permissions for symlinks, not 0o777", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-symlink-test-"));
    dirs.push(tmp);

    const realFile = path.join(tmp, "real.json");
    fs.writeFileSync(realFile, "{}", "utf-8");
    fs.chmodSync(realFile, 0o600);

    const link = path.join(tmp, "link.json");
    fs.symlinkSync(realFile, link);

    const st = await safeStat(link);
    expect(st.ok).toBe(true);
    expect(st.isSymlink).toBe(true);
    // mode should reflect the target file (0o600), not the symlink (0o777)
    expect(st.mode! & 0o777).toBe(0o600);
  });

  it.skipIf(isWin)("preserves isSymlink for broken symlinks", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-symlink-test-"));
    dirs.push(tmp);

    const missingTarget = path.join(tmp, "gone.json");
    const link = path.join(tmp, "broken-link.json");
    fs.symlinkSync(missingTarget, link);

    const st = await safeStat(link);
    expect(st.ok).toBe(false);
    expect(st.isSymlink).toBe(true);
    expect(st.error).toBeDefined();
  });

  it.skipIf(isWin)("returns real file permissions for non-symlinks", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-symlink-test-"));
    dirs.push(tmp);

    const realFile = path.join(tmp, "real.json");
    fs.writeFileSync(realFile, "{}", "utf-8");
    fs.chmodSync(realFile, 0o644);

    const st = await safeStat(realFile);
    expect(st.ok).toBe(true);
    expect(st.isSymlink).toBe(false);
    expect(st.mode! & 0o777).toBe(0o644);
  });
});

describe("inspectPathPermissions symlink handling", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const d of dirs) {
      await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
    }
    dirs.length = 0;
  });

  it.skipIf(isWin)("does not flag symlink to 0o600 file as world/group readable", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-symlink-test-"));
    dirs.push(tmp);

    const realFile = path.join(tmp, "config.json");
    fs.writeFileSync(realFile, "{}", "utf-8");
    fs.chmodSync(realFile, 0o600);

    const link = path.join(tmp, "config-link.json");
    fs.symlinkSync(realFile, link);

    const perms = await inspectPathPermissions(link);
    expect(perms.ok).toBe(true);
    expect(perms.isSymlink).toBe(true);
    expect(perms.worldReadable).toBe(false);
    expect(perms.groupReadable).toBe(false);
    expect(perms.worldWritable).toBe(false);
    expect(perms.groupWritable).toBe(false);
  });

  it.skipIf(isWin)("flags symlink to 0o644 file as world/group readable", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-symlink-test-"));
    dirs.push(tmp);

    const realFile = path.join(tmp, "config.json");
    fs.writeFileSync(realFile, "{}", "utf-8");
    fs.chmodSync(realFile, 0o644);

    const link = path.join(tmp, "config-link.json");
    fs.symlinkSync(realFile, link);

    const perms = await inspectPathPermissions(link);
    expect(perms.ok).toBe(true);
    expect(perms.isSymlink).toBe(true);
    // Target is 0o644, so world-readable and group-readable
    expect(perms.worldReadable).toBe(true);
    expect(perms.groupReadable).toBe(true);
  });
});
