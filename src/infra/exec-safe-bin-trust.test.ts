import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import {
  buildTrustedSafeBinDirs,
  getTrustedSafeBinDirs,
  isTrustedSafeBinPath,
  listWritableExplicitTrustedSafeBinDirs,
} from "./exec-safe-bin-trust.js";

// Mirror the runtime FS probe from exec-safe-bin-trust.ts so test
// expectations stay consistent regardless of platform or volume format.
function isCaseInsensitiveFs(): boolean {
  try {
    const tmpDir = os.tmpdir();
    const original = fsSync.statSync(tmpDir);
    const flipped = (() => {
      try {
        return fsSync.statSync(tmpDir.toUpperCase());
      } catch {
        return null;
      }
    })();
    if (!flipped) {
      return false;
    }
    return original.ino === flipped.ino && original.dev === flipped.dev;
  } catch {
    return false;
  }
}

const CASE_INSENSITIVE = isCaseInsensitiveFs();

// Normalize a path the same way the trust module does.
const normalizePath = (p: string) =>
  CASE_INSENSITIVE ? path.resolve(p).toLowerCase() : path.resolve(p);

describe("exec safe bin trust", () => {
  it("keeps default trusted dirs limited to immutable system paths", () => {
    const dirs = getTrustedSafeBinDirs({ refresh: true });

    expect(dirs.has(normalizePath("/bin"))).toBe(true);
    expect(dirs.has(normalizePath("/usr/bin"))).toBe(true);
    expect(dirs.has(normalizePath("/usr/local/bin"))).toBe(false);
    expect(dirs.has(normalizePath("/opt/homebrew/bin"))).toBe(false);
  });

  it("builds trusted dirs from defaults and explicit extra dirs", () => {
    const dirs = buildTrustedSafeBinDirs({
      baseDirs: ["/usr/bin"],
      extraDirs: ["/custom/bin", "/alt/bin", "/custom/bin"],
    });

    expect(dirs.has(normalizePath("/usr/bin"))).toBe(true);
    expect(dirs.has(normalizePath("/custom/bin"))).toBe(true);
    expect(dirs.has(normalizePath("/alt/bin"))).toBe(true);
    expect(dirs.size).toBe(3);
  });

  it("memoizes trusted dirs per explicit trusted-dir snapshot", () => {
    const a = getTrustedSafeBinDirs({
      extraDirs: ["/first/bin"],
      refresh: true,
    });
    const b = getTrustedSafeBinDirs({
      extraDirs: ["/first/bin"],
    });
    const c = getTrustedSafeBinDirs({
      extraDirs: ["/second/bin"],
    });

    expect(a).toBe(b);
    expect(c).not.toBe(b);
  });

  it("validates resolved paths using injected trusted dirs", () => {
    const trusted = new Set([normalizePath("/usr/bin")]);
    expect(
      isTrustedSafeBinPath({
        resolvedPath: "/usr/bin/jq",
        trustedDirs: trusted,
      }),
    ).toBe(true);
    expect(
      isTrustedSafeBinPath({
        resolvedPath: "/tmp/evil/jq",
        trustedDirs: trusted,
      }),
    ).toBe(false);
  });

  it.runIf(CASE_INSENSITIVE)(
    "matches trusted dirs case-insensitively on case-insensitive filesystems",
    () => {
      const input = path.join(path.sep, "Users", "Dev", "Custom", "bin");
      const dirs = buildTrustedSafeBinDirs({
        baseDirs: [],
        extraDirs: [input],
      });
      // Trusted dir should be stored lowercased on case-insensitive FS
      expect(dirs.has(path.resolve(input).toLowerCase())).toBe(true);
      expect(dirs.has(path.resolve(input))).toBe(false);
    },
  );

  it.runIf(CASE_INSENSITIVE)(
    "isTrustedSafeBinPath matches regardless of resolvedPath case on case-insensitive filesystems",
    () => {
      // Simulate: normalizeConfiguredSafeBins lowercases bin paths,
      // but resolvedPath might retain original case from the filesystem.
      const scriptsDir = path.join(path.sep, "Users", "Dev", "scripts");
      const dirs = buildTrustedSafeBinDirs({
        baseDirs: [],
        extraDirs: [scriptsDir],
      });
      expect(
        isTrustedSafeBinPath({
          resolvedPath: path.join(scriptsDir.toLowerCase(), "my-tool.sh"),
          trustedDirs: dirs,
        }),
      ).toBe(true);
      expect(
        isTrustedSafeBinPath({
          resolvedPath: path.join(path.sep, "Users", "Dev", "Scripts", "my-tool.sh"),
          trustedDirs: dirs,
        }),
      ).toBe(true);
    },
  );

  it("does not trust PATH entries by default", () => {
    const injected = `/tmp/openclaw-path-injected-${Date.now()}`;

    withEnv({ PATH: `${injected}${path.delimiter}${process.env.PATH ?? ""}` }, () => {
      const refreshed = getTrustedSafeBinDirs({ refresh: true });
      expect(refreshed.has(normalizePath(injected))).toBe(false);
    });
  });

  it("flags explicitly trusted dirs that are group/world writable", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-safe-bin-trust-"));
    try {
      await fs.chmod(dir, 0o777);
      const hits = listWritableExplicitTrustedSafeBinDirs([dir]);
      const expectedDir = CASE_INSENSITIVE ? path.resolve(dir).toLowerCase() : path.resolve(dir);
      expect(hits).toEqual([
        {
          dir: expectedDir,
          groupWritable: true,
          worldWritable: true,
        },
      ]);
    } finally {
      await fs.chmod(dir, 0o755).catch(() => undefined);
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
