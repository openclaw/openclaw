import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnv } from "../test-utils/env.js";
import { hasErrnoCode } from "./errno.js";
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
  it("prepares and evaluates safe-bin trust without synchronous filesystem calls", async () => {
    await withTestDir({ prefix: "openclaw-safe-bin-async-" }, async (dir) => {
      await fs.writeFile(path.join(dir, "wc"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const calls = (["statSync", "accessSync", "realpathSync"] as const).map((name) =>
        vi.spyOn(syncFs, name),
      );
      try {
        const trustedDirs = await getTrustedSafeBinDirs({ extraDirs: [dir], safeBins: ["wc"] });
        expect(
          await isTrustedSafeBinPath({ resolvedPath: path.join(dir, "wc"), trustedDirs }),
        ).toBe(true);
        await listWritableExplicitTrustedSafeBinDirs([dir]);
        expect(calls.map((call) => call.mock.calls.length)).toEqual([0, 0, 0]);
      } finally {
        calls.forEach((call) => call.mockRestore());
      }
    });
  });
  it("keeps default trusted dirs limited to immutable system paths", async () => {
    const dirs = await getTrustedSafeBinDirs();

    expect(
      ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"].map((dir) =>
        dirs.has(path.resolve(dir)),
      ),
    ).toEqual([true, true, false, false]);
  });

  it("builds trusted dirs from defaults and explicit extra dirs", async () => {
    const dirs = await getTrustedSafeBinDirs({
      extraDirs: ["/custom/bin", "/alt/bin", "/custom/bin"],
    });

    expect(dirs.has(path.resolve("/usr/bin"))).toBe(true);
    expect(dirs.has(path.resolve("/custom/bin"))).toBe(true);
    expect(dirs.has(path.resolve("/alt/bin"))).toBe(true);
    expect(dirs.size).toBe(4);
  });

  it("validates resolved paths using injected trusted dirs", async () => {
    const trusted = new Set([path.resolve("/usr/bin")]);
    expect(await trusts("/usr/bin/jq", trusted)).toBe(true);
    expect(await trusts("/tmp/evil/jq", trusted)).toBe(false);
  });

  it("matches trusted dirs through path-local case folding on case-insensitive filesystems", async ({
    skip,
  }) => {
    await withTestDir({ prefix: "OpenClaw-Safe-Bin-" }, async (dir) => {
      const swapped = swapAsciiCase(dir);
      if (swapped === dir) {
        skip("requires a path with case-distinct characters");
      }
      const originalStat = await fs.stat(dir);
      let swappedStat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        swappedStat = await fs.stat(swapped);
      } catch (error) {
        if (hasErrnoCode(error, "ENOENT")) {
          skip("requires a case-insensitive filesystem");
        }
        throw error;
      }
      if (originalStat.dev !== swappedStat.dev || originalStat.ino !== swappedStat.ino) {
        skip("requires case variants to refer to the same directory");
      }

      expect(
        await trusts(path.join(dir, "jq"), await getTrustedSafeBinDirs({ extraDirs: [swapped] })),
      ).toBe(true);
    });
  });

  it("keeps case-distinct trusted dirs separate on case-sensitive filesystems", async ({
    skip,
  }) => {
    await withTestDir({ prefix: "openclaw-safe-bin-case-" }, async (parent) => {
      const trustedDir = path.join(parent, "ToolBin");
      const untrustedDir = path.join(parent, "toolbin");
      await fs.mkdir(trustedDir);
      try {
        await fs.mkdir(untrustedDir);
      } catch (error) {
        if (hasErrnoCode(error, "EEXIST")) {
          skip("requires a case-sensitive filesystem");
        }
        throw error;
      }

      expect(
        await trusts(
          path.join(untrustedDir, "jq"),
          await getTrustedSafeBinDirs({ extraDirs: [trustedDir] }),
        ),
      ).toBe(false);
    });
  });

  it("does not trust PATH entries by default", async () => {
    const injected = `/tmp/openclaw-path-injected-${Date.now()}`;

    await withEnv({ PATH: `${injected}${path.delimiter}${process.env.PATH ?? ""}` }, async () => {
      const refreshed = await getTrustedSafeBinDirs();
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
        expect(await listWritableExplicitTrustedSafeBinDirs([dir])).toEqual([
          { dir: path.resolve(dir), worldWritable: true },
        ]);
      } finally {
        await fs.chmod(dir, 0o755).catch(() => undefined);
      }
    });
  });
});
