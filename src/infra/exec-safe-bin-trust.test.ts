import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { withEnv } from "../test-utils/env.js";
import {
  buildTrustedSafeBinDirs,
  classifyRiskyExplicitSafeBinTrustedDir,
  getTrustedSafeBinDirs,
  isTrustedSafeBinPath,
  listWritableExplicitTrustedSafeBinDirs,
} from "./exec-safe-bin-trust.js";

describe("exec safe bin trust", () => {
  it("keeps default trusted dirs limited to immutable system paths", () => {
    const dirs = getTrustedSafeBinDirs({ refresh: true });

    expect(dirs.has(path.resolve("/bin"))).toBe(true);
    expect(dirs.has(path.resolve("/usr/bin"))).toBe(true);
    expect(dirs.has(path.resolve("/usr/local/bin"))).toBe(false);
    expect(dirs.has(path.resolve("/opt/homebrew/bin"))).toBe(false);
  });

  it("builds trusted dirs from defaults and explicit immutable extra dirs", () => {
    const dirs = buildTrustedSafeBinDirs({
      baseDirs: ["/usr/bin"],
      extraDirs: ["/custom/bin", "/alt/bin", "/custom/bin"],
    });

    expect(dirs.has(path.resolve("/usr/bin"))).toBe(true);
    expect(dirs.has(path.resolve("/custom/bin"))).toBe(true);
    expect(dirs.has(path.resolve("/alt/bin"))).toBe(true);
    expect(dirs.size).toBe(3);
  });

  it("filters mutable extra dirs from safe-bin trust", () => {
    const dirs = buildTrustedSafeBinDirs({
      baseDirs: ["/usr/bin"],
      extraDirs: [
        "/usr/local/bin",
        "/snap/bin",
        "/home/test/.nvm/versions/node/v22/bin",
        "./scripts",
        "/custom/bin",
      ],
    });

    expect(dirs.has(path.resolve("/usr/bin"))).toBe(true);
    expect(dirs.has(path.resolve("/custom/bin"))).toBe(true);
    expect(dirs.has(path.resolve("/usr/local/bin"))).toBe(false);
    expect(dirs.has(path.resolve("/snap/bin"))).toBe(false);
    expect(dirs.has(path.resolve("/home/test/.nvm/versions/node/v22/bin"))).toBe(false);
    expect(Array.from(dirs)).not.toContain(path.resolve("./scripts"));
  });

  it("rejects raw relative trusted-dir entries before resolution", () => {
    const dirs = buildTrustedSafeBinDirs({
      baseDirs: ["/usr/bin"],
      extraDirs: ["./scripts"],
    });

    expect(Array.from(dirs)).toEqual([path.resolve("/usr/bin")]);
  });

  it("classifies explicit mutable trusted-dir candidates", () => {
    expect(classifyRiskyExplicitSafeBinTrustedDir("/usr/local/bin")).toContain("mutable");
    expect(classifyRiskyExplicitSafeBinTrustedDir("/snap/bin")).toContain("mutable");
    expect(
      classifyRiskyExplicitSafeBinTrustedDir("/home/test/.nvm/versions/node/v22/bin"),
    ).toContain("home-scoped");
    expect(classifyRiskyExplicitSafeBinTrustedDir("./scripts")).toContain("workspace-scoped");
    expect(classifyRiskyExplicitSafeBinTrustedDir("/usr/libexec")).toBeNull();
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
    const trusted = new Set([path.resolve("/usr/bin")]);
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

  it("does not trust PATH entries by default", () => {
    const injected = `/tmp/openclaw-path-injected-${Date.now()}`;

    withEnv({ PATH: `${injected}${path.delimiter}${process.env.PATH ?? ""}` }, () => {
      const refreshed = getTrustedSafeBinDirs({ refresh: true });
      expect(refreshed.has(path.resolve(injected))).toBe(false);
    });
  });

  it("flags explicitly trusted dirs that are group/world writable", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withTempDir({ prefix: "openclaw-safe-bin-trust-" }, async (dir) => {
      try {
        await fs.chmod(dir, 0o777);
        const hits = listWritableExplicitTrustedSafeBinDirs([dir]);
        expect(hits).toEqual([
          {
            dir: path.resolve(dir),
            groupWritable: true,
            worldWritable: true,
          },
        ]);
      } finally {
        await fs.chmod(dir, 0o755).catch(() => undefined);
      }
    });
  });
});
