import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { pkgQueryResult } from "../../infra/update-freebsd-pkg-ownership.test-support.js";
import * as exec from "../../process/exec.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import { retireStandaloneGitWrapper } from "./update-command-git.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const installerWrapper = (root: string) =>
  `#!/usr/bin/env bash\nset -euo pipefail\nexec /usr/bin/node ${root.replaceAll(" ", "\\ ")}/dist/entry.js "$@"\n`;
async function fixture(platform: NodeJS.Platform = "linux") {
  const base = dirs.make("openclaw-wrapper-");
  const root = platform === "win32" ? "C:\\old checkout" : path.join(base, "old checkout");
  const wrapper = path.join(base, platform === "win32" ? "openclaw.cmd" : "openclaw");
  const original =
    platform === "win32"
      ? `@echo off\r\nnode "${path.win32.join(root, "dist", "entry.js")}" %*\r\n`
      : installerWrapper(root);
  const write = (contents: string) => fs.writeFile(wrapper, contents, { mode: 0o755 });
  await write(original);
  const retire = (searchDirs = [base], assertCurrent?: () => void) =>
    retireStandaloneGitWrapper({ previousRoot: root, platform, searchDirs, assertCurrent });
  return { base, root, wrapper, original, write, retire };
}

describe("retireStandaloneGitWrapper", () => {
  it.each([
    ...["replacement", "content change", "oversized file", "directory", "revoked finalizer"].map(
      (change) => ({ change, stage: "pkg inspection" }),
    ),
    ...["replacement", "revoked finalizer"].map((change) => ({ change, stage: "wrapper read" })),
  ])("preserves a wrapper after $change during $stage", async ({ change, stage }) => {
    const platform = stage === "pkg inspection" ? "freebsd" : "linux";
    const { base, wrapper, original, write, retire } = await fixture(platform);
    const replacement = "#!/bin/sh\necho replacement\n";
    let revoked = false;
    const assertCurrent = vi.fn(() => {
      if (revoked) {
        throw new Error("finalizer revoked");
      }
    });
    const changeWrapper = async () => {
      if (change === "replacement" || change === "directory") {
        await fs.rename(wrapper, path.join(base, "saved"));
        if (change === "directory") {
          await fs.mkdir(wrapper);
        } else {
          await write(original);
        }
      } else if (change === "oversized file" || change === "content change") {
        await write(change === "oversized file" ? "x".repeat(4097) : replacement);
      } else {
        revoked = true;
      }
    };
    const readFile = fs.readFile;
    const observation =
      stage === "pkg inspection"
        ? vi.spyOn(exec, "runCommandBuffered").mockImplementationOnce(async () => {
            await changeWrapper();
            return pkgQueryResult();
          })
        : vi.spyOn(fs, "readFile").mockImplementationOnce(async (file, options) => {
            const contents = await readFile(file, options);
            await changeWrapper();
            return contents;
          });
    try {
      const result = await withMockedPlatform(platform, () => retire([base], assertCurrent));
      if (change === "directory") {
        expect((await fs.lstat(wrapper)).isDirectory()).toBe(true);
      } else {
        await expect(fs.readFile(wrapper, "utf8")).resolves.toBe(
          change === "content change"
            ? replacement
            : change === "oversized file"
              ? "x".repeat(4097)
              : original,
        );
      }
      expect(result).toMatchObject({ error: expect.stringContaining("Could not retire") });
      expect(assertCurrent).toHaveBeenCalledTimes(change === "revoked finalizer" ? 1 : 0);
    } finally {
      observation.mockRestore();
    }
  });

  it("preserves a pkg-owned legacy wrapper even when its contents match", async () => {
    const { wrapper, original, retire } = await fixture("freebsd");
    const query = vi
      .spyOn(exec, "runCommandBuffered")
      .mockResolvedValue(pkgQueryResult(`${wrapper}\n`));
    try {
      await withMockedPlatform("freebsd", () =>
        expect(retire()).resolves.toMatchObject({
          error: expect.stringContaining("installed by FreeBSD pkg"),
        }),
      );
      await expect(fs.readFile(wrapper, "utf8")).resolves.toBe(original);
    } finally {
      query.mockRestore();
    }
  });
  it("removes only the installer wrapper for the previous checkout", async () => {
    const { base: home, root: oldRoot, wrapper, write, retire } = await fixture();
    const unrelatedWrapper = path.join(home, "earlier", "openclaw");
    const secondWrapper = path.join(home, "legacy", "bin", "openclaw");
    await Promise.all(
      [unrelatedWrapper, secondWrapper].map((file) =>
        fs.mkdir(path.dirname(file), { recursive: true }),
      ),
    );
    await fs.writeFile(unrelatedWrapper, "#!/usr/bin/env bash\necho unrelated\n", { mode: 0o755 });
    await fs.writeFile(secondWrapper, installerWrapper(oldRoot), { mode: 0o755 });
    await expect(
      retire([unrelatedWrapper, wrapper, secondWrapper].map((file) => path.dirname(file))),
    ).resolves.toEqual({});
    await expect(fs.readFile(unrelatedWrapper, "utf8")).resolves.toContain("unrelated");
    await expect(fs.stat(wrapper)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(secondWrapper)).rejects.toMatchObject({ code: "ENOENT" });

    await write("#!/usr/bin/env node\nimport '../lib/node_modules/openclaw/openclaw.mjs';\n");
    await expect(retire()).resolves.toEqual({});
    await expect(fs.stat(wrapper)).resolves.toBeDefined();
  });

  it("removes only the exact PowerShell installer wrapper on Windows", async () => {
    const { wrapper, write, retire } = await fixture("win32");
    await expect(retire()).resolves.toEqual({});
    await expect(fs.stat(wrapper)).rejects.toMatchObject({ code: "ENOENT" });

    await write("@echo off\r\necho unrelated\r\n");
    await expect(retire()).resolves.toEqual({});
    await expect(fs.readFile(wrapper, "utf8")).resolves.toContain("unrelated");
  });
});
