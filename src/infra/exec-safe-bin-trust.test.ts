import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import {
  buildTrustedSafeBinDirs,
  getTrustedSafeBinDirs,
  isTrustedSafeBinPath,
} from "./exec-safe-bin-trust.js";

describe("exec safe bin trust", () => {
  it("builds trusted dirs from defaults and injected PATH", () => {
    const dirs = buildTrustedSafeBinDirs({
      pathEnv: "/custom/bin:/alt/bin:/custom/bin",
      delimiter: ":",
      baseDirs: ["/usr/bin"],
    });

    expect(dirs.has(path.resolve("/usr/bin"))).toBe(true);
    expect(dirs.has(path.resolve("/custom/bin"))).toBe(true);
    expect(dirs.has(path.resolve("/alt/bin"))).toBe(true);
    expect(dirs.size).toBe(3);
  });

  it("memoizes trusted dirs per PATH snapshot", () => {
    const a = getTrustedSafeBinDirs({
      pathEnv: "/first/bin",
      delimiter: ":",
      refresh: true,
    });
    const b = getTrustedSafeBinDirs({
      pathEnv: "/first/bin",
      delimiter: ":",
    });
    const c = getTrustedSafeBinDirs({
      pathEnv: "/second/bin",
      delimiter: ":",
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

  it("uses startup PATH snapshot when pathEnv is omitted", () => {
    const injected = `/tmp/openclaw-path-injected-${Date.now()}`;
    const initial = getTrustedSafeBinDirs({ refresh: true });

    withEnv({ PATH: `${injected}${path.delimiter}${process.env.PATH ?? ""}` }, () => {
      const refreshed = getTrustedSafeBinDirs({ refresh: true });
      expect(refreshed.has(path.resolve(injected))).toBe(false);
      expect([...refreshed].toSorted()).toEqual([...initial].toSorted());
    });
  });
});
