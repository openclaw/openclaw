import * as childProcess from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isPrivateDirectoryCreationRefused } from "./private-directory-creation.js";
import {
  createPrivateSqliteDirectory,
  createPrivateSqliteTempDirectorySync,
  resolvePrivateSqliteSnapshotStagingRoot,
} from "./sqlite-private-directory.js";
import * as tmpOpenClawDir from "./tmp-openclaw-dir.js";
import {
  createPrivateWindowsDirectory,
  createPrivateWindowsFile,
} from "./windows-private-directory.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn(actual.execFile),
    execFileSync: vi.fn(actual.execFileSync),
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});
function captureFailure(create: () => unknown): unknown {
  try {
    return create();
  } catch (error) {
    return error;
  }
}

it.each([
  [undefined, "sqlite-local-app-data", "sqlite-local-app-data"],
  ["relative/cache", "sqlite-local-app-data", "sqlite-local-app-data"],
  [undefined, undefined, "sqlite-home/AppData/Local"],
  [undefined, "relative/local-app-data", "sqlite-home/AppData/Local"],
  ["sqlite-xdg-cache", "sqlite-local-app-data", "sqlite-xdg-cache"],
] as const)(
  "selects the Windows cache for XDG=%s and LOCALAPPDATA=%s",
  (xdgCacheHome, localAppData, expectedRoot) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const resolveTempRoot = vi
      .spyOn(tmpOpenClawDir, "resolvePreferredOpenClawTmpDir")
      .mockImplementation((options) => options?.preferredDir ?? "");

    const resolveRoot = (root: string | undefined) =>
      root?.startsWith("sqlite-") ? path.resolve(root) : root;
    expect(
      resolvePrivateSqliteSnapshotStagingRoot({
        HOME: path.resolve("sqlite-home"),
        LOCALAPPDATA: resolveRoot(localAppData),
        XDG_CACHE_HOME: resolveRoot(xdgCacheHome),
      }),
    ).toBe(path.join(path.resolve(expectedRoot), "openclaw"));
    expect(resolveTempRoot.mock.calls[0]?.[0]?.tmpdir?.()).toBe(path.resolve(expectedRoot));
  },
);

describe.skipIf(process.platform === "win32")("private creation adapter on the native host", () => {
  it.each(["parent-file", "existing-directory"] as const)(
    "preserves the semantic %s error and records a confirmed refusal",
    (kind) => {
      const root = tempDirs.make("openclaw-private-preflight-");
      const parent = path.join(root, "parent");
      const directory = kind === "parent-file" ? path.join(parent, "child") : parent;
      if (kind === "parent-file") {
        fs.writeFileSync(parent, "preserved");
      } else {
        fs.mkdirSync(parent);
      }
      const failure = captureFailure(() => createPrivateWindowsDirectory(directory));
      expect(failure).toMatchObject({
        code: kind === "parent-file" ? "not-file" : "already-exists",
      });
      expect(isPrivateDirectoryCreationRefused(failure)).toBe(true);
      if (kind === "parent-file") {
        expect(fs.readFileSync(parent, "utf8")).toBe("preserved");
      } else {
        expect(fs.statSync(parent).isDirectory()).toBe(true);
      }
    },
  );

  it("does not call a failed dispatched creation a confirmed refusal", () => {
    const root = tempDirs.make("openclaw-private-dispatched-");
    const directory = path.join(root, "created");
    const failure = new Error("creation lost its completion receipt");
    const mkdir = fs.mkdirSync;
    vi.spyOn(fs, "mkdirSync").mockImplementation((target, options) => {
      const result = mkdir(target, options);
      if (String(target) === directory) {
        throw failure;
      }
      return result;
    });
    const thrown = captureFailure(() => createPrivateWindowsDirectory(directory));
    expect(thrown).toBe(failure);
    expect(isPrivateDirectoryCreationRefused(thrown)).toBe(false);
    expect(fs.statSync(directory).isDirectory()).toBe(true);
  });

  it("returns an owned private descriptor and preserves an existing file", () => {
    const root = tempDirs.make("openclaw-private-owner-");
    const file = path.join(root, "private");
    using owner = createPrivateWindowsFile(file);
    expect(fs.fstatSync(owner.fd).mode & 0o777).toBe(0o600);
    fs.writeSync(owner.fd, "winner");
    owner.close();
    owner.close();
    expect(() => createPrivateWindowsFile(file)).toThrow(
      expect.objectContaining({ code: "already-exists" }),
    );
    expect(fs.readFileSync(file, "utf8")).toBe("winner");
    expect(fs.statSync(file).nlink).toBe(1);
  });
});

function expectPrivateAcl(filename: string, kind: "Directory" | "File") {
  const script = [
    `$acl = [IO.${kind}]::GetAccessControl('${filename.replaceAll("'", "''")}')`,
    "$user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "@{ protected = $acl.AreAccessRulesProtected; owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; user = $user; rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object { @{ sid = $_.IdentityReference.Value; rights = [int]$_.FileSystemRights; inheritance = [int]$_.InheritanceFlags; inherited = $_.IsInherited; allow = [int]$_.AccessControlType } }) } | ConvertTo-Json -Depth 4 -Compress",
  ].join("; ");
  const acl = JSON.parse(
    childProcess.execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8" },
    ),
  );
  expect(acl).toMatchObject({ protected: true, owner: acl.user });
  expect(acl.rules.map((rule: { sid: string }) => rule.sid).toSorted()).toEqual(
    [acl.user, "S-1-5-18", "S-1-5-32-544"].toSorted((left, right) => left.localeCompare(right)),
  );
  for (const rule of acl.rules) {
    expect(rule).toMatchObject({
      rights: 2032127,
      inherited: false,
      allow: 0,
      ...(kind === "Directory" ? { inheritance: 3 } : {}),
    });
  }
}

function writePrivateFile(filename: string, content: string) {
  using file = createPrivateWindowsFile(filename);
  fs.writeSync(file.fd, content);
  file.close();
  expect(fs.readFileSync(filename, "utf8")).toBe(content);
}

describe.runIf(process.platform === "win32")("private SQLite directory creation on Windows", () => {
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
    expect(await fsp.readFile(path.join(workerPath, "worker.sqlite"), "utf8")).toBe("worker");
    expect(childProcess.execFile).not.toHaveBeenCalled();
    expect(childProcess.execFileSync).not.toHaveBeenCalled();

    for (const directory of [asyncPath, syncPath, workerPath]) {
      expectPrivateAcl(directory, "Directory");
      await fsp.writeFile(path.join(directory, "synthetic.sqlite"), "synthetic");
      const listing = childProcess.execFileSync("icacls.exe", [directory], { encoding: "utf8" });
      expect(listing).toContain("(OI)(CI)(F)");
      expect(listing).not.toContain("(I)");
    }
  });

  it.each([null, 201, 202, 220, 280])(
    "creates reopenable private files with parent length %s",
    (parentLength) => {
      const root = tempDirs.make("openclaw-sqlite-private-long-");
      const parent =
        parentLength === null ? root : path.join(root, "p".repeat(parentLength - root.length - 1));
      if (parentLength !== null) {
        fs.mkdirSync(parent, { recursive: true });
        const directory = createPrivateSqliteTempDirectorySync(parent, "long-");
        expect(fs.statSync(directory).isDirectory()).toBe(true);
      }
      const filename = path.join(parent, "private.sqlite");
      writePrivateFile(filename, "private");
      if (parentLength === null) {
        expect(fs.statSync(filename).nlink).toBe(1);
        expect(fs.readdirSync(root)).toEqual(["private.sqlite"]);
      } else {
        expect(filename.length).toBe(parentLength + 15);
      }
    },
  );

  it("protects a new file before its published-name descriptor opens and preserves an existing winner", () => {
    const directory = tempDirs.make("openclaw-private-file-");
    const file = path.join(directory, "private.sqlite");
    const open = fs.openSync;
    let inspected = false;
    const spy = vi.spyOn(fs, "openSync").mockImplementation((pathname, flags, mode) => {
      if (path.basename(String(pathname)) === "private.sqlite") {
        expectPrivateAcl(file, "File");
        inspected = true;
      }
      return open(pathname, flags, mode);
    });
    using created = createPrivateWindowsFile(file);
    expect(inspected).toBe(true);
    fs.writeSync(created.fd, "winner");
    fs.fsyncSync(created.fd);
    spy.mockRestore();
    created.close();
    expect(() => createPrivateWindowsFile(file)).toThrow(
      expect.objectContaining({ code: "already-exists" }),
    );
    expect(fs.readFileSync(file, "utf8")).toBe("winner");
    expect(fs.statSync(file).nlink).toBe(1);
  });

  it("rejects a replacement published name without returning or removing the successor", () => {
    const root = tempDirs.make("openclaw-private-file-replaced-");
    const file = path.join(root, "private.sqlite");
    const retained = path.join(root, "retained.sqlite");
    const open = fs.openSync;
    let replaced = false;
    vi.spyOn(fs, "openSync").mockImplementation((pathname, flags, mode) => {
      if (!replaced && path.resolve(String(pathname)) === path.resolve(file)) {
        replaced = true;
        fs.renameSync(file, retained);
        fs.writeFileSync(file, "successor");
      }
      return open(pathname, flags, mode);
    });
    expect(() => createPrivateWindowsFile(file)).toThrow(
      expect.objectContaining({ code: "helper-failed" }),
    );
    expect(replaced).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("successor");
    expect(fs.readFileSync(retained, "utf8")).toBe("");
  });

  it("rejects existing files and junctions without modifying them", async () => {
    const root = tempDirs.make("openclaw-sqlite-private-existing-");
    const directory = path.join(root, "private");
    await createPrivateSqliteDirectory(directory);
    const file = path.join(root, "file");
    await fsp.writeFile(file, "keep");
    const junction = path.join(root, "junction");
    await fsp.symlink(directory, junction, "junction");
    for (const existing of [file, junction]) {
      await expect(createPrivateSqliteDirectory(existing)).rejects.toMatchObject({
        code: "already-exists",
      });
    }
    expect(await fsp.readFile(file, "utf8")).toBe("keep");
    expect((await fsp.lstat(junction)).isSymbolicLink()).toBe(true);
  });

  it("reports native failure when the parent is a regular file", async () => {
    const root = tempDirs.make("openclaw-sqlite-private-failure-");
    const regularFile = path.join(root, "parent-file");
    await fsp.writeFile(regularFile, "not a directory");
    const failure = await createPrivateSqliteDirectory(path.join(regularFile, "child")).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: "not-file" });
    expect(isPrivateDirectoryCreationRefused(failure)).toBe(true);
  });
});
