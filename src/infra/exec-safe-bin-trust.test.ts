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

describe("exec safe bin trust", () => {
  it("keeps default trusted dirs limited to immutable system paths", () => {
    const dirs = getTrustedSafeBinDirs({ refresh: true });
    const normalize = (p: string) =>
      process.platform === "darwin" || process.platform === "win32"
        ? path.resolve(p).toLowerCase()
        : path.resolve(p);

    expect(dirs.has(normalize("/bin"))).toBe(true);
    expect(dirs.has(normalize("/usr/bin"))).toBe(true);
    expect(dirs.has(normalize("/usr/local/bin"))).toBe(false);
    expect(dirs.has(normalize("/opt/homebrew/bin"))).toBe(false);
  });

  it("builds trusted dirs from defaults and explicit extra dirs", () => {
    const dirs = buildTrustedSafeBinDirs({
      baseDirs: ["/usr/bin"],
      extraDirs: ["/custom/bin", "/alt/bin", "/custom/bin"],
    });
    const normalize = (p: string) =>
      process.platform === "darwin" || process.platform === "win32"
        ? path.resolve(p).toLowerCase()
        : path.resolve(p);

    expect(dirs.has(normalize("/usr/bin"))).toBe(true);
    expect(dirs.has(normalize("/custom/bin"))).toBe(true);
    expect(dirs.has(normalize("/alt/bin"))).toBe(true);
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
    const normalize = (p: string) =>
      process.platform === "darwin" || process.platform === "win32"
        ? path.resolve(p).toLowerCase()
        : path.resolve(p);
    const trusted = new Set([normalize("/usr/bin")]);
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

  it.runIf(process.platform === "darwin" || process.platform === "win32")(
    "matches trusted dirs case-insensitively on case-insensitive filesystems",
    () => {
      const input = path.join(path.sep, "Users", "Dev", "Custom", "bin");
      const dirs = buildTrustedSafeBinDirs({
        baseDirs: [],
        extraDirs: [input],
      });
      // Trusted dir should be stored lowercased (with platform separators) on case-insensitive FS
      expect(dirs.has(path.resolve(input).toLowerCase())).toBe(true);
      expect(dirs.has(path.resolve(input))).toBe(false);
    },
  );

  it.runIf(process.platform === "darwin" || process.platform === "win32")(
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
      const normalize = (p: string) =>
        process.platform === "darwin" || process.platform === "win32"
          ? path.resolve(p).toLowerCase()
          : path.resolve(p);
      expect(refreshed.has(normalize(injected))).toBe(false);
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
      // After the win32 guard above, TS narrows out "win32". Cast to avoid
      // the TS2367 narrowing complaint while keeping the test correct on all platforms.
      const caseInsensitive = (["darwin", "win32"] as string[]).includes(process.platform);
      const expectedDir = caseInsensitive ? path.resolve(dir).toLowerCase() : path.resolve(dir);
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
