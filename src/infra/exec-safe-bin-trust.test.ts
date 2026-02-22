import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import {
  buildTrustedSafeBinDirs,
  getTrustedSafeBinDirs,
  isTrustedSafeBinPath,
} from "./exec-safe-bin-trust.js";

describe("exec safe bin trust", () => {
  it("builds trusted dirs from defaults and explicit extra dirs", () => {
    const dirs = buildTrustedSafeBinDirs({
      baseDirs: ["/usr/bin"],
      extraDirs: ["/custom/bin", "/alt/bin", "/custom/bin"],
    });

    expect(dirs.has(path.resolve("/usr/bin"))).toBe(true);
    expect(dirs.has(path.resolve("/custom/bin"))).toBe(true);
    expect(dirs.has(path.resolve("/alt/bin"))).toBe(true);
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
});
