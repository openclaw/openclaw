import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { DEFAULT_POSIX_TMP_ROOT, resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";

type TmpDirOptions = NonNullable<Parameters<typeof resolvePreferredOpenClawTmpDir>[0]>;

const fallbackTmp = path.join("/var/fallback", "openclaw-501");

function nodeErrorWithCode(code: string) {
  return Object.assign(new Error(code), { code });
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

function resolveWithStats(
  preferred: ReturnType<typeof makeDirStat>,
  fallback = makeDirStat(),
  options: TmpDirOptions = {},
) {
  return resolvePreferredOpenClawTmpDir({
    accessSync: vi.fn(),
    lstatSync: (target) =>
      target === DEFAULT_POSIX_TMP_ROOT
        ? preferred
        : target === fallbackTmp
          ? fallback
          : makeDirStat(),
    mkdirSync: vi.fn(),
    getuid: () => 501,
    tmpdir: () => "/var/fallback",
    warn: vi.fn(),
    ...options,
  });
}

describe.skipIf(process.platform === "win32")("POSIX preferred temp directory selection", () => {
  it.each([
    ["private and writable", {}],
    ["not a directory", { isDirectory: false, mode: 0o100644 }],
    ["a symlink", { isSymbolicLink: true, mode: 0o120777 }],
    ["owned by another user", { uid: 0 }],
    ["group/other writable", { mode: 0o40777 }],
  ] as const)("selects a safe root when /tmp/openclaw is %s", (name, shape) => {
    expect(resolveWithStats(makeDirStat(shape))).toBe(
      name === "private and writable" ? DEFAULT_POSIX_TMP_ROOT : fallbackTmp,
    );
  });

  it("throws when fallback path is a symlink", () => {
    const symlink = makeDirStat({ isSymbolicLink: true, mode: 0o120777 });
    expect(() => resolveWithStats(symlink, symlink)).toThrow(/Unsafe fallback OpenClaw temp dir/);
  });
});

it("skips the POSIX preferred path on Windows even when /tmp is accessible (#60713)", () => {
  const winFallback = path.win32.join("C:\\Users\\u\\AppData\\Local\\Temp", "openclaw-501");
  const result = resolveWithStats(makeDirStat(), makeDirStat(), {
    platform: "win32",
    chmodSync: vi.fn(),
    tmpdir: () => "C:\\Users\\u\\AppData\\Local\\Temp",
    lstatSync: (target) => {
      if (target === DEFAULT_POSIX_TMP_ROOT || target === winFallback) {
        return makeDirStat();
      }
      throw nodeErrorWithCode("ENOENT");
    },
  });
  expect(result).toBe(winFallback);
});
describe.skipIf(process.platform === "win32")("POSIX temp directory admission and repair", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      vi.restoreAllMocks();
      cleanup();
    });
  });

  function fixture(route: "preferred" | "fallback") {
    const directory = tempDirs.make("openclaw-temp-repair-");
    const uid = process.getuid!();
    const preferredDir = path.join(directory, "preferred");
    const fallbackDir = path.join(directory, `openclaw-${uid}`);
    if (route === "fallback") {
      fs.writeFileSync(preferredDir, "not a directory");
    }
    const candidate = route === "preferred" ? preferredDir : fallbackDir;
    const warn = vi.fn();
    return {
      candidate,
      fallbackDir,
      uid,
      warn,
      resolve: () =>
        resolvePreferredOpenClawTmpDir({ preferredDir, tmpdir: () => directory, warn }),
    };
  }

  function expectPrivateDirectory(candidate: string, uid: number, identity?: fs.BigIntStats) {
    const stat = fs.lstatSync(candidate, { bigint: true });
    expect(stat.isDirectory()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.uid).toBe(BigInt(uid));
    expect(stat.mode & 0o7777n).toBe(0o700n);
    fs.accessSync(candidate, fs.constants.W_OK | fs.constants.X_OK);
    if (identity) {
      expect(stat).toMatchObject({ dev: identity.dev, ino: identity.ino });
    }
    return stat;
  }

  it.each(["preferred", "fallback"] as const)(
    "creates a missing %s directory with private ownership and mode",
    (route) => {
      const f = fixture(route);
      expect(fs.existsSync(f.candidate)).toBe(false);

      expect(f.resolve()).toBe(f.candidate);

      expectPrivateDirectory(f.candidate, f.uid);
    },
  );

  it.each(
    (["preferred", "fallback"] as const).flatMap((route) =>
      (["existing", "created"] as const).map((state) => ({ route, state })),
    ),
  )("repairs the same $state $route directory when its mode is too broad", ({ route, state }) => {
    const f = fixture(route);
    let admitted: fs.BigIntStats | undefined;
    const broaden = () => {
      fs.chmodSync(f.candidate, 0o775);
      admitted = fs.lstatSync(f.candidate, { bigint: true });
    };
    if (state === "existing") {
      fs.mkdirSync(f.candidate);
      broaden();
    } else {
      const mkdirSync = fs.mkdirSync;
      vi.spyOn(fs, "mkdirSync").mockImplementation((candidate, options) => {
        const created = mkdirSync(candidate, options);
        if (candidate === f.candidate) {
          // A concurrent actor broadens the new directory before final admission.
          broaden();
        }
        return created;
      });
    }

    expect(f.resolve()).toBe(f.candidate);

    expect(admitted).toBeDefined();
    expectPrivateDirectory(f.candidate, f.uid, admitted);
    expect(f.warn).toHaveBeenCalledExactlyOnceWith(
      `[openclaw] tightened permissions on temp dir: ${f.candidate}`,
    );
  });

  it.each(
    (["preferred", "fallback"] as const).flatMap((route) =>
      (["before-open", "denied-repaired", "denied-unsafe"] as const).map((phase) => ({
        route,
        phase,
      })),
    ),
  )("handles $phase competition on the $route directory", ({ route, phase }) => {
    const f = fixture(route);
    fs.mkdirSync(f.candidate);
    fs.chmodSync(f.candidate, 0o777);
    const admitted = fs.lstatSync(f.candidate, { bigint: true });
    const fchmodSync = fs.fchmodSync;
    const fchmod = vi.spyOn(fs, "fchmodSync");
    let attempts = 0;
    if (phase === "before-open") {
      const openSync = fs.openSync;
      vi.spyOn(fs, "openSync").mockImplementation((candidate, flags, mode) => {
        if (candidate === f.candidate) {
          fs.chmodSync(f.candidate, 0o700);
        }
        const fd = openSync(candidate, flags, mode);
        if (candidate === f.candidate) {
          attempts++;
        }
        return fd;
      });
    } else {
      fchmod.mockImplementation((fd, mode) => {
        const stat = fs.fstatSync(fd, { bigint: true });
        if (stat.dev !== admitted.dev || stat.ino !== admitted.ino) {
          return fchmodSync(fd, mode);
        }
        attempts++;
        if (phase === "denied-repaired") {
          fchmodSync(fd, 0o700);
        }
        throw nodeErrorWithCode(route === "preferred" ? "EPERM" : "EACCES");
      });
    }
    if (phase !== "denied-unsafe") {
      expect(f.resolve()).toBe(f.candidate);
      expectPrivateDirectory(f.candidate, f.uid, admitted);
    } else {
      if (route === "preferred") {
        expect(f.resolve()).toBe(f.fallbackDir);
        expectPrivateDirectory(f.fallbackDir, f.uid);
      } else {
        expect(f.resolve).toThrow(/Unsafe fallback OpenClaw temp dir/);
      }
      expect(fs.lstatSync(f.candidate, { bigint: true })).toMatchObject({
        dev: admitted.dev,
        ino: admitted.ino,
        mode: admitted.mode,
      });
    }
    if (phase === "before-open") {
      expect(fchmod).not.toHaveBeenCalled();
    }
    expect(attempts).toBe(1);
    expect(f.warn).not.toHaveBeenCalled();
  });
});
