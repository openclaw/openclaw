import * as childProcess from "node:child_process";
import { once } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isPrivateDirectoryCreationRefused } from "./private-directory-creation.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn(actual.execFile),
    execFileSync: vi.fn(actual.execFileSync),
  };
});

import {
  createPrivateSqliteDirectory,
  createPrivateSqliteTempDirectorySync,
} from "./sqlite-private-directory.js";
import { createPrivateWindowsFile } from "./windows-private-directory.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.runIf(process.platform === "win32")("private SQLite directory creation on Windows", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("creates protected directories without spawning PowerShell or a compiler", async () => {
    const root = tempDirs.make("openclaw-sqlite-private-directory-");
    const asyncPath = path.join(root, "private 测试");
    await createPrivateSqliteDirectory(asyncPath);
    const syncPath = createPrivateSqliteTempDirectorySync(root, "sync-");
    const workerPath = path.join(root, "worker");
    const worker = new Worker(
      `
      const { workerData } = require("node:worker_threads");
      const { createDirectorySync, createFileSync } = require(workerData.entry);
      createDirectorySync(workerData.directory, { private: true });
      const file = createFileSync(workerData.directory + "/worker.sqlite", { private: true });
      try { require("node:fs").writeSync(file.fd, "worker"); }
      finally { file.close(); }
    `,
      {
        eval: true,
        workerData: {
          entry: fileURLToPath(import.meta.resolve("@openclaw/fs-safe/advanced")),
          directory: workerPath,
        },
      },
    );
    expect((await once(worker, "exit"))[0]).toBe(0);
    expect(await fs.readFile(path.join(workerPath, "worker.sqlite"), "utf8")).toBe("worker");
    expect(childProcess.execFile).not.toHaveBeenCalled();
    expect(childProcess.execFileSync).not.toHaveBeenCalled();

    for (const directory of [asyncPath, syncPath, workerPath]) {
      const script = [
        `$acl = [IO.Directory]::GetAccessControl('${directory.replaceAll("'", "''")}')`,
        "$user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
        "$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))",
        "@{ protected = $acl.AreAccessRulesProtected; owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; user = $user; rules = @($rules | ForEach-Object { @{ sid = $_.IdentityReference.Value; rights = [int]$_.FileSystemRights; inheritance = [int]$_.InheritanceFlags; inherited = $_.IsInherited; allow = [int]$_.AccessControlType } }) } | ConvertTo-Json -Depth 4 -Compress",
      ].join("; ");
      const acl = JSON.parse(
        childProcess.execFileSync(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", script],
          {
            encoding: "utf8",
          },
        ),
      );
      expect(acl.protected).toBe(true);
      expect(acl.owner).toBe(acl.user);
      expect(acl.rules.map((rule: { sid: string }) => rule.sid).toSorted()).toEqual(
        [acl.user, "S-1-5-18", "S-1-5-32-544"].toSorted((left, right) => left.localeCompare(right)),
      );
      for (const rule of acl.rules) {
        expect(rule).toMatchObject({ rights: 2032127, inheritance: 3, inherited: false, allow: 0 });
      }
      await fs.writeFile(path.join(directory, "synthetic.sqlite"), "synthetic");
      const listing = childProcess.execFileSync("icacls.exe", [directory], { encoding: "utf8" });
      expect(listing).toContain("(OI)(CI)(F)");
      expect(listing).not.toContain("(I)");
    }
  });

  it.each([220, 280])("creates private paths with a %i-character parent", (parentLength) => {
    const root = tempDirs.make("openclaw-sqlite-private-long-");
    const parent = path.join(root, "p".repeat(parentLength - root.length - 1));
    fsSync.mkdirSync(parent, { recursive: true });
    const directory = createPrivateSqliteTempDirectorySync(parent, "long-");
    expect(fsSync.statSync(directory).isDirectory()).toBe(true);
    const filename = path.join(parent, "private.sqlite");
    expect(filename.length).toBe(parentLength + 15);
    const file = createPrivateWindowsFile(filename);
    try {
      fsSync.writeSync(file.fd, "long");
    } finally {
      file.close();
    }
    expect(fsSync.readFileSync(filename, "utf8")).toBe("long");
  });

  it("protects a new file before its published-name descriptor opens and preserves an existing winner", () => {
    const directory = tempDirs.make("openclaw-private-file-");
    const file = path.join(directory, "private.sqlite");
    const open = fsSync.openSync;
    let inspected = false;
    const spy = vi.spyOn(fsSync, "openSync").mockImplementation((pathname, flags, mode) => {
      if (path.basename(String(pathname)) === "private.sqlite") {
        const script = [
          `$acl = [IO.File]::GetAccessControl('${file.replaceAll("'", "''")}')`,
          "$user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
          "@{ protected = $acl.AreAccessRulesProtected; owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; user = $user; rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object { @{ sid = $_.IdentityReference.Value; rights = [int]$_.FileSystemRights; inherited = $_.IsInherited; allow = [int]$_.AccessControlType } }) } | ConvertTo-Json -Depth 4 -Compress",
        ].join("; ");
        const acl = JSON.parse(
          childProcess.execFileSync(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command", script],
            {
              encoding: "utf8",
            },
          ),
        );
        expect(acl.protected).toBe(true);
        expect(acl.owner).toBe(acl.user);
        expect(acl.rules.map((rule: { sid: string }) => rule.sid).toSorted()).toEqual(
          [acl.user, "S-1-5-18", "S-1-5-32-544"].toSorted((left, right) =>
            left.localeCompare(right),
          ),
        );
        for (const rule of acl.rules) {
          expect(rule).toMatchObject({ rights: 2032127, inherited: false, allow: 0 });
        }
        inspected = true;
      }
      return open(pathname, flags, mode);
    });
    let created: ReturnType<typeof createPrivateWindowsFile> | undefined;
    try {
      created = createPrivateWindowsFile(file);
      expect(inspected).toBe(true);
      fsSync.writeSync(created.fd, "winner");
      fsSync.fsyncSync(created.fd);
    } finally {
      spy.mockRestore();
      created?.close();
    }
    expect(() => createPrivateWindowsFile(file)).toThrow(
      expect.objectContaining({ code: "already-exists" }),
    );
    expect(fsSync.readFileSync(file, "utf8")).toBe("winner");
    expect(fsSync.statSync(file).nlink).toBe(1);
  });

  it("rejects a replacement published name without returning or removing the successor", () => {
    const root = tempDirs.make("openclaw-private-file-replaced-");
    const file = path.join(root, "private.sqlite");
    const retained = path.join(root, "retained.sqlite");
    const open = fsSync.openSync;
    let replaced = false;
    vi.spyOn(fsSync, "openSync").mockImplementation((pathname, flags, mode) => {
      if (!replaced && String(pathname) === path.toNamespacedPath(file)) {
        replaced = true;
        fsSync.renameSync(file, retained);
        fsSync.writeFileSync(file, "successor");
      }
      return open(pathname, flags, mode);
    });
    expect(() => createPrivateWindowsFile(file)).toThrow(
      expect.objectContaining({ code: "helper-failed" }),
    );
    expect(replaced).toBe(true);
    expect(fsSync.readFileSync(file, "utf8")).toBe("successor");
    expect(fsSync.readFileSync(retained, "utf8")).toBe("");
  });

  it("rejects concurrent creation, existing files, and junctions without modifying them", async () => {
    const root = tempDirs.make("openclaw-sqlite-private-existing-");
    const directory = path.join(root, "private");
    const attempts = await Promise.allSettled([
      createPrivateSqliteDirectory(directory),
      createPrivateSqliteDirectory(directory),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.find((attempt) => attempt.status === "rejected")).toMatchObject({
      reason: { code: "already-exists" },
    });
    const file = path.join(root, "file");
    await fs.writeFile(file, "keep");
    const junction = path.join(root, "junction");
    await fs.symlink(directory, junction, "junction");
    for (const existing of [file, junction]) {
      await expect(createPrivateSqliteDirectory(existing)).rejects.toMatchObject({
        code: "already-exists",
      });
    }
    expect(await fs.readFile(file, "utf8")).toBe("keep");
    expect((await fs.lstat(junction)).isSymbolicLink()).toBe(true);
  });

  it("reports native failure when the parent is a regular file", async () => {
    const root = tempDirs.make("openclaw-sqlite-private-failure-");
    const regularFile = path.join(root, "parent-file");
    await fs.writeFile(regularFile, "not a directory");
    const failure = await createPrivateSqliteDirectory(path.join(regularFile, "child")).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      code: "not-file",
    });
    expect(isPrivateDirectoryCreationRefused(failure)).toBe(true);
  });
});
