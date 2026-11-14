import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnv } from "../test-utils/env.js";
import {
  getTrustedSafeBinDirs,
  isTrustedSafeBinPath,
  listWritableExplicitTrustedSafeBinDirs,
} from "./exec-safe-bin-trust.js";

function swapAsciiCase(value: string): string {
  return value.replace(/[A-Za-z]/g, (char) => {
    const lower = char.toLowerCase();
    return char === lower ? char.toUpperCase() : lower;
  });
}
const trusts = (resolvedPath: string, trustedDirs: ReadonlySet<string>) =>
  isTrustedSafeBinPath({ resolvedPath, trustedDirs });

describe("exec safe bin trust", () => {
  it("keeps default trusted dirs limited to immutable system paths", () => {
    const dirs = getTrustedSafeBinDirs();

    expect(
      ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"].map((dir) =>
        dirs.has(path.resolve(dir)),
      ),
    ).toEqual([true, true, false, false]);
  });

  it("builds trusted dirs from defaults and explicit extra dirs", () => {
    const dirs = getTrustedSafeBinDirs({
      extraDirs: ["/custom/bin", "/alt/bin", "/custom/bin"],
    });

    expect(dirs.has(path.resolve("/usr/bin"))).toBe(true);
    expect(dirs.has(path.resolve("/custom/bin"))).toBe(true);
    expect(dirs.has(path.resolve("/alt/bin"))).toBe(true);
    expect(dirs.size).toBe(4);
  });

  it("validates resolved paths using injected trusted dirs", () => {
    const trusted = new Set([path.resolve("/usr/bin")]);
    expect(trusts("/usr/bin/jq", trusted)).toBe(true);
    expect(trusts("/tmp/evil/jq", trusted)).toBe(false);
  });

  it("matches trusted dirs through path-local case folding on case-insensitive filesystems", async () => {
    await withTestDir({ prefix: "OpenClaw-Safe-Bin-" }, async (dir) => {
      const swapped = swapAsciiCase(dir);
      if (swapped === dir) {
        return;
      }
      const originalStat = await fs.stat(dir);
      let swappedStat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        swappedStat = await fs.stat(swapped);
      } catch {
        return;
      }
      if (originalStat.dev !== swappedStat.dev || originalStat.ino !== swappedStat.ino) {
        return;
      }

      expect(trusts(path.join(dir, "jq"), getTrustedSafeBinDirs({ extraDirs: [swapped] }))).toBe(
        true,
      );
    });
  });

  it("keeps case-distinct trusted dirs separate on case-sensitive filesystems", async () => {
    await withTestDir({ prefix: "openclaw-safe-bin-case-" }, async (parent) => {
      const trustedDir = path.join(parent, "ToolBin");
      const untrustedDir = path.join(parent, "toolbin");
      await fs.mkdir(trustedDir);
      try {
        await fs.mkdir(untrustedDir);
      } catch {
        return;
      }

      expect(
        trusts(path.join(untrustedDir, "jq"), getTrustedSafeBinDirs({ extraDirs: [trustedDir] })),
      ).toBe(false);
    });
  });

  it("does not trust PATH entries by default", () => {
    const injected = `/tmp/openclaw-path-injected-${Date.now()}`;

    withEnv({ PATH: `${injected}${path.delimiter}${process.env.PATH ?? ""}` }, () => {
      const refreshed = getTrustedSafeBinDirs();
      expect(refreshed.has(path.resolve(injected))).toBe(false);
    });
  });

  it("flags explicitly trusted dirs that are group/world writable", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withTestDir({ prefix: "openclaw-safe-bin-trust-" }, async (dir) => {
      try {
        await fs.chmod(dir, 0o777);
        expect(listWritableExplicitTrustedSafeBinDirs([dir])).toEqual([
          { dir: path.resolve(dir), worldWritable: true },
        ]);
      } finally {
        await fs.chmod(dir, 0o755).catch(() => undefined);
      }
    });
  });
});
