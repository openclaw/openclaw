import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { POSIX_ACTIVI_TMP_DIR, resolvePreferredActiviTmpDir } from "./tmp-activi-dir.js";

type TmpDirOptions = NonNullable<Parameters<typeof resolvePreferredActiviTmpDir>[0]>;

function fallbackTmp(uid = 501) {
  return path.join("/var/fallback", `activi-${uid}`);
}

function resolveWithMocks(params: {
  lstatSync: NonNullable<TmpDirOptions["lstatSync"]>;
  accessSync?: NonNullable<TmpDirOptions["accessSync"]>;
  uid?: number;
  tmpdirPath?: string;
}) {
  const accessSync = params.accessSync ?? vi.fn();
  const mkdirSync = vi.fn();
  const getuid = vi.fn(() => params.uid ?? 501);
  const tmpdir = vi.fn(() => params.tmpdirPath ?? "/var/fallback");
  const resolved = resolvePreferredActiviTmpDir({
    accessSync,
    lstatSync: params.lstatSync,
    mkdirSync,
    getuid,
    tmpdir,
  });
  return { resolved, accessSync, lstatSync: params.lstatSync, mkdirSync, tmpdir };
}

describe("resolvePreferredActiviTmpDir", () => {
  it("prefers /tmp/activi when it already exists and is writable", () => {
    const lstatSync: NonNullable<TmpDirOptions["lstatSync"]> = vi.fn(() => ({
      isDirectory: () => true,
      isSymbolicLink: () => false,
      uid: 501,
      mode: 0o40700,
    }));
    const { resolved, accessSync, tmpdir } = resolveWithMocks({ lstatSync });

    expect(lstatSync).toHaveBeenCalledTimes(1);
    expect(accessSync).toHaveBeenCalledTimes(1);
    expect(resolved).toBe(POSIX_ACTIVI_TMP_DIR);
    expect(tmpdir).not.toHaveBeenCalled();
  });

  it("prefers /tmp/activi when it does not exist but /tmp is writable", () => {
    const lstatSyncMock = vi.fn<NonNullable<TmpDirOptions["lstatSync"]>>(() => {
      const err = new Error("missing") as Error & { code?: string };
      err.code = "ENOENT";
      throw err;
    });

    // second lstat call (after mkdir) should succeed
    lstatSyncMock.mockImplementationOnce(() => {
      const err = new Error("missing") as Error & { code?: string };
      err.code = "ENOENT";
      throw err;
    });
    lstatSyncMock.mockImplementationOnce(() => ({
      isDirectory: () => true,
      isSymbolicLink: () => false,
      uid: 501,
      mode: 0o40700,
    }));

    const { resolved, accessSync, mkdirSync, tmpdir } = resolveWithMocks({
      lstatSync: lstatSyncMock,
    });

    expect(resolved).toBe(POSIX_ACTIVI_TMP_DIR);
    expect(accessSync).toHaveBeenCalledWith("/tmp", expect.any(Number));
    expect(mkdirSync).toHaveBeenCalledWith(POSIX_ACTIVI_TMP_DIR, expect.any(Object));
    expect(tmpdir).not.toHaveBeenCalled();
  });

  it("falls back to os.tmpdir()/activi when /tmp/activi is not a directory", () => {
    const lstatSync = vi.fn(() => ({
      isDirectory: () => false,
      isSymbolicLink: () => false,
      uid: 501,
      mode: 0o100644,
    })) as unknown as ReturnType<typeof vi.fn> & NonNullable<TmpDirOptions["lstatSync"]>;
    const { resolved, tmpdir } = resolveWithMocks({ lstatSync });

    expect(resolved).toBe(fallbackTmp());
    expect(tmpdir).toHaveBeenCalledTimes(1);
  });

  it("falls back to os.tmpdir()/activi when /tmp is not writable", () => {
    const accessSync = vi.fn((target: string) => {
      if (target === "/tmp") {
        throw new Error("read-only");
      }
    });
    const lstatSync = vi.fn(() => {
      const err = new Error("missing") as Error & { code?: string };
      err.code = "ENOENT";
      throw err;
    });
    const { resolved, tmpdir } = resolveWithMocks({
      accessSync,
      lstatSync,
    });

    expect(resolved).toBe(fallbackTmp());
    expect(tmpdir).toHaveBeenCalledTimes(1);
  });

  it("falls back when /tmp/activi is a symlink", () => {
    const lstatSync = vi.fn(() => ({
      isDirectory: () => true,
      isSymbolicLink: () => true,
      uid: 501,
      mode: 0o120777,
    }));

    const { resolved, tmpdir } = resolveWithMocks({ lstatSync });

    expect(resolved).toBe(fallbackTmp());
    expect(tmpdir).toHaveBeenCalledTimes(1);
  });

  it("falls back when /tmp/activi is not owned by the current user", () => {
    const lstatSync = vi.fn(() => ({
      isDirectory: () => true,
      isSymbolicLink: () => false,
      uid: 0,
      mode: 0o40700,
    }));

    const { resolved, tmpdir } = resolveWithMocks({ lstatSync });

    expect(resolved).toBe(fallbackTmp());
    expect(tmpdir).toHaveBeenCalledTimes(1);
  });

  it("falls back when /tmp/activi is group/other writable", () => {
    const lstatSync = vi.fn(() => ({
      isDirectory: () => true,
      isSymbolicLink: () => false,
      uid: 501,
      mode: 0o40777,
    }));
    const { resolved, tmpdir } = resolveWithMocks({ lstatSync });

    expect(resolved).toBe(fallbackTmp());
    expect(tmpdir).toHaveBeenCalledTimes(1);
  });
});
