import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { POSIX_OPENCLAW_TMP_DIR, resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";

type TmpDirOptions = NonNullable<Parameters<typeof resolvePreferredOpenClawTmpDir>[0]>;

function fallbackTmp(uid = 501) {
  return path.join("/var/fallback", `openclaw-${uid}`);
}

function fallbackTmpSafe(uid = 501) {
  return path.join("/var/fallback", `openclaw-${uid}-safe`);
}

function nodeErrorWithCode(code: string) {
  const err = new Error(code) as Error & { code?: string };
  err.code = code;
  return err;
}

function secureDirStat(uid = 501) {
  return {
    isDirectory: () => true,
    isSymbolicLink: () => false,
    uid,
    mode: 0o40700,
  };
}

function makeDirStat(params?: {
  isDirectory?: boolean;
  isSymbolicLink?: boolean;
  uid?: number;
  mode?: number;
}) {
  return {
    isDirectory: () => params?.isDirectory ?? true,
    isSymbolicLink: () => params?.isSymbolicLink ?? false,
    uid: params?.uid ?? 501,
    mode: params?.mode ?? 0o40700,
  };
}


function symlinkTmpDirLstat() {
  return vi.fn(() => makeDirStat({ isSymbolicLink: true, mode: 0o120777 }));
}

function expectFallsBackToOsTmpDir(params: { lstatSync: NonNullable<TmpDirOptions["lstatSync"]> }) {
  const { resolved, tmpdir } = resolveWithMocks({ lstatSync: params.lstatSync });
  expect(resolved).toBe(fallbackTmp());
  expect(tmpdir).toHaveBeenCalled();
}

function missingThenSecureLstat(uid = 501) {
  return vi
    .fn<NonNullable<TmpDirOptions["lstatSync"]>>()
    .mockImplementationOnce(() => {
      throw nodeErrorWithCode("ENOENT");
    })
    .mockImplementationOnce(() => secureDirStat(uid));
}

function resolveWithMocks(params: {
  lstatSync: NonNullable<TmpDirOptions["lstatSync"]>;
  fallbackLstatSync?: NonNullable<TmpDirOptions["lstatSync"]>;
  accessSync?: NonNullable<TmpDirOptions["accessSync"]>;
  chmodSync?: NonNullable<TmpDirOptions["chmodSync"]>;
  warn?: NonNullable<TmpDirOptions["warn"]>;
  uid?: number;
  tmpdirPath?: string;
}) {
  const uid = params.uid ?? 501;
  const fallbackPath = fallbackTmp(uid);
  const accessSync = params.accessSync ?? vi.fn();
  const chmodSync = params.chmodSync ?? vi.fn();
  const warn = params.warn ?? vi.fn();
  const wrappedLstatSync = vi.fn((target: string) => {
    if (target === POSIX_OPENCLAW_TMP_DIR) {
      return params.lstatSync(target);
    }
    if (target === fallbackPath) {
      if (params.fallbackLstatSync) {
        return params.fallbackLstatSync(target);
      }
      return secureDirStat(uid);
    }
    return secureDirStat(uid);
  }) as NonNullable<TmpDirOptions["lstatSync"]>;
  const mkdirSync = vi.fn();
  const getuid = vi.fn(() => uid);
  const tmpdir = vi.fn(() => params.tmpdirPath ?? "/var/fallback");
  const resolved = resolvePreferredOpenClawTmpDir({
    accessSync,
    chmodSync,
    lstatSync: wrappedLstatSync,
    mkdirSync,
    getuid,
    tmpdir,
    warn,
  });
  return { resolved, accessSync, lstatSync: wrappedLstatSync, mkdirSync, tmpdir };
}

describe("resolvePreferredOpenClawTmpDir", () => {
  it("prefers /tmp/openclaw when it already exists and is writable", () => {
    const lstatSync: NonNullable<TmpDirOptions["lstatSync"]> = vi.fn(() => ({
      isDirectory: () => true,
      isSymbolicLink: () => false,
      uid: 501,
      mode: 0o40700,
    }));
    const { resolved, accessSync, tmpdir } = resolveWithMocks({ lstatSync });

    expect(lstatSync).toHaveBeenCalledTimes(1);
    expect(accessSync).toHaveBeenCalledTimes(1);
    expect(resolved).toBe(POSIX_OPENCLAW_TMP_DIR);
    expect(tmpdir).not.toHaveBeenCalled();
  });

  it("prefers /tmp/openclaw when it does not exist but /tmp is writable", () => {
    const lstatSyncMock = missingThenSecureLstat();

    const { resolved, accessSync, mkdirSync, tmpdir } = resolveWithMocks({
      lstatSync: lstatSyncMock,
    });

    expect(resolved).toBe(POSIX_OPENCLAW_TMP_DIR);
    expect(accessSync).toHaveBeenCalledWith("/tmp", expect.any(Number));
    expect(mkdirSync).toHaveBeenCalledWith(POSIX_OPENCLAW_TMP_DIR, expect.any(Object));
    expect(tmpdir).not.toHaveBeenCalled();
  });

  it("falls back to os.tmpdir()/openclaw when /tmp/openclaw is not a directory", () => {
    const lstatSync = vi.fn(() => makeDirStat({ isDirectory: false, mode: 0o100644 }));
    const { resolved, tmpdir } = resolveWithMocks({ lstatSync });

    expect(resolved).toBe(fallbackTmp());
    expect(tmpdir).toHaveBeenCalled();
  });

  it("falls back to os.tmpdir()/openclaw when /tmp is not writable", () => {
    const accessSync = vi.fn((target: string) => {
      if (target === "/tmp") {
        throw new Error("read-only");
      }
    });
    const lstatSync = vi.fn(() => {
      throw nodeErrorWithCode("ENOENT");
    });
    const { resolved, tmpdir } = resolveWithMocks({
      accessSync,
      lstatSync,
    });

    expect(resolved).toBe(fallbackTmp());
    expect(tmpdir).toHaveBeenCalled();
  });

  it("falls back when /tmp/openclaw is a symlink", () => {
    expectFallsBackToOsTmpDir({ lstatSync: symlinkTmpDirLstat() });
  });

  it("falls back when /tmp/openclaw is not owned by the current user", () => {
    expectFallsBackToOsTmpDir({ lstatSync: vi.fn(() => makeDirStat({ uid: 0 })) });
  });

  it("falls back when /tmp/openclaw is group/other writable", () => {
    expectFallsBackToOsTmpDir({ lstatSync: vi.fn(() => makeDirStat({ mode: 0o40777 })) });
  });

  it("uses safe fallback path when primary fallback is a symlink", () => {
    const lstatSync = vi.fn(() => ({
      isDirectory: () => true,
      isSymbolicLink: () => true,
      uid: 501,
      mode: 0o120777,
    }));
    const fallbackLstatSync = vi.fn(() => ({
      isDirectory: () => true,
      isSymbolicLink: () => true,
      uid: 501,
      mode: 0o120777,
    }));

    const { resolved } = resolveWithMocks({
      lstatSync,
      fallbackLstatSync,
    });

    expect(resolved).toBe(fallbackTmpSafe());
  });

  it("creates fallback directory when missing, then validates ownership and mode", () => {
    const lstatSync = symlinkTmpDirLstat();
    const fallbackLstatSync = missingThenSecureLstat();

    const { resolved, mkdirSync } = resolveWithMocks({
      lstatSync,
      fallbackLstatSync,
    });

    expect(resolved).toBe(fallbackTmp());
    expect(mkdirSync).toHaveBeenCalledWith(fallbackTmp(), { recursive: true, mode: 0o700 });
  });

  it("returns primary fallback path when all fallback candidates are unsafe", () => {
    const lstatSync: NonNullable<TmpDirOptions["lstatSync"]> = vi.fn((target: string) => {
      if (
        target === POSIX_OPENCLAW_TMP_DIR ||
        target === fallbackTmp() ||
        target === fallbackTmpSafe()
      ) {
        return {
          isDirectory: () => true,
          isSymbolicLink: () => true,
          uid: 501,
          mode: 0o120777,
        };
      }
      return secureDirStat(501);
    });

    const { resolved } = resolveWithMocks({ lstatSync });

    expect(resolved).toBe(fallbackTmp());
  });
});
