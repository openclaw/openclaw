import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { gitReleaseSlot } from "../../infra/git-release-paths.js";
import { createGitReleaseDirs, publishGitRelease } from "../../infra/git-release.js";
import { pkgQueryResult } from "../../infra/update-freebsd-pkg-ownership.test-support.js";
import * as exec from "../../process/exec.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import {
  exposeGlobalPackageThroughRelease,
  resolveGitReleaseCheckout,
  retireStandaloneGitWrapper,
} from "./update-command-git.js";

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
    using _ =
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

    const retiring = withMockedPlatform(platform, () => retire([base], assertCurrent));
    const result =
      change === "revoked finalizer"
        ? await expect(retiring).rejects.toThrow("finalizer revoked")
        : await retiring;
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
    if (change !== "revoked finalizer") {
      expect(result).toMatchObject({ error: expect.stringContaining("Could not retire") });
    }
    expect(assertCurrent).toHaveBeenCalledTimes(change === "revoked finalizer" ? 1 : 0);
  });

  it("preserves a pkg-owned legacy wrapper even when its contents match", async () => {
    const { wrapper, original, retire } = await fixture("freebsd");
    using _ = vi
      .spyOn(exec, "runCommandBuffered")
      .mockResolvedValue(pkgQueryResult(`${wrapper}\n`));

    await withMockedPlatform("freebsd", () =>
      expect(retire()).rejects.toThrow("installed by FreeBSD pkg"),
    );
    await expect(fs.readFile(wrapper, "utf8")).resolves.toBe(original);
  });
  it("removes only the installer wrapper for the previous checkout", async () => {
    const { base: home, root: oldRoot, wrapper, retire } = await fixture();
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
  });

  it("removes only the exact PowerShell installer wrapper on Windows", async () => {
    const { wrapper, write, retire } = await fixture("win32");
    await expect(retire()).resolves.toEqual({});
    await expect(fs.stat(wrapper)).rejects.toMatchObject({ code: "ENOENT" });

    await write("@echo off\r\necho unrelated\r\n");
    await expect(retire()).resolves.toEqual({});
    await expect(fs.readFile(wrapper, "utf8")).resolves.toContain("unrelated");
  });

  it("points the installer wrapper at the release launcher, so `openclaw gateway` on PATH starts a pending release", async () => {
    const base = dirs.make("openclaw-wrapper-release-");
    const checkout = path.join(base, "checkout");
    const wrapper = path.join(base, "openclaw");
    await fs.writeFile(
      wrapper,
      `#!/usr/bin/env bash\nset -euo pipefail\nexec ${process.execPath} ${checkout}/dist/entry.js "$@"\n`,
      { mode: 0o755 },
    );
    const prefix = path.join(base, "state", "git-install");
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(base, "state"));
    const release = async (name: string) => {
      const { releaseRoot } = await createGitReleaseDirs(prefix);
      await fs.mkdir(path.join(releaseRoot, "dist"), { recursive: true });
      for (const entry of ["index.js", "entry.js"]) {
        await fs.writeFile(
          path.join(releaseRoot, "dist", entry),
          `console.log("${name} ${entry}");\n`,
        );
      }
      return releaseRoot;
    };
    await publishGitRelease({ prefix, releaseRoot: await release("old"), trial: false });
    const slot = gitReleaseSlot(prefix);
    await expect(
      retireStandaloneGitWrapper({
        previousRoot: checkout,
        replacementRoot: slot,
        searchDirs: [base],
      }),
    ).resolves.toEqual({});
    // A `--no-restart` update leaves the new release pending for the next Gateway start.
    await publishGitRelease({
      prefix,
      releaseRoot: await release("new"),
      trial: true,
      pending: true,
    });
    const run = (...args: string[]) =>
      spawnSync("bash", [wrapper, ...args], { encoding: "utf8" }).stdout;

    expect(run("gateway", "status")).toBe("old entry.js\n");
    expect(run("gateway", "run", "--help")).toBe("old entry.js\n");
    expect(run("--", "gateway", "run")).toBe("new index.js\n");
    expect(run("gateway", "--port", "18789")).toBe("new index.js\n");
    expect(run("--version")).toBe("new entry.js\n");

    // A later switch back to npm retires the wrapper this install's launcher now runs.
    await expect(
      retireStandaloneGitWrapper({ previousRoot: checkout, searchDirs: [base] }),
    ).resolves.toEqual({});
    await expect(fs.access(wrapper)).rejects.toThrow();
    vi.unstubAllEnvs();
  });
});

describe.skipIf(process.platform === "win32")("resolveGitReleaseCheckout", () => {
  it("finds the checkout from a release worktree, as a release-driven update starts there", async () => {
    const base = await fs.realpath(dirs.make("openclaw-release-checkout-"));
    const checkout = path.join(base, "checkout");
    const git = (cwd: string, ...args: string[]) =>
      spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    await fs.mkdir(checkout);
    git(checkout, "init", "-q");
    git(
      checkout,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "x",
    );
    const release = path.join(base, "state", "git-install", "releases", "r1", "openclaw");
    expect(git(checkout, "worktree", "add", "-q", "--detach", release).status).toBe(0);

    await expect(resolveGitReleaseCheckout(release, release, 10_000)).resolves.toBe(checkout);
  });
});

describe.skipIf(process.platform === "win32")("exposeGlobalPackageThroughRelease", () => {
  async function install(base: string) {
    const prefix = path.join(base, "state", "git-install");
    const { releaseRoot } = await createGitReleaseDirs(prefix);
    await fs.mkdir(path.join(releaseRoot, "dist"), { recursive: true });
    await fs.writeFile(path.join(releaseRoot, "dist", "entry.js"), 'console.log("release");\n');
    await publishGitRelease({ prefix, releaseRoot, trial: false });
    const checkout = path.join(base, "checkout");
    await fs.mkdir(path.join(checkout, "dist"), { recursive: true });
    await fs.writeFile(path.join(checkout, "openclaw.mjs"), 'console.log("checkout");\n');
    const globalRoot = path.join(base, "lib", "node_modules");
    await fs.mkdir(globalRoot, { recursive: true });
    return { slot: gitReleaseSlot(prefix), checkout, globalRoot };
  }
  const start = (entry: string, ...args: string[]) =>
    spawnSync(process.execPath, [entry, ...args], { encoding: "utf8" }).stdout;

  it("replaces an npm link to the checkout without writing the checkout", async () => {
    const base = dirs.make("openclaw-npm-entry-");
    const { slot, checkout, globalRoot } = await install(base);
    const packageRoot = path.join(globalRoot, "openclaw");
    await fs.symlink(checkout, packageRoot);

    await expect(exposeGlobalPackageThroughRelease(packageRoot, slot, checkout)).resolves.toBe(
      undefined,
    );

    expect((await fs.lstat(packageRoot)).isDirectory()).toBe(true);
    expect(start(path.join(packageRoot, "openclaw.mjs"), "--version")).toBe("release\n");
    expect(await fs.readFile(path.join(checkout, "openclaw.mjs"), "utf8")).toBe(
      'console.log("checkout");\n',
    );
    expect((await fs.readdir(globalRoot)).filter((name) => name !== "openclaw")).toEqual([]);
  });

  it("writes through a link to another directory, as a pnpm store path", async () => {
    const base = dirs.make("openclaw-npm-entry-");
    const { slot, checkout, globalRoot } = await install(base);
    const store = path.join(base, "store", "openclaw");
    await fs.mkdir(store, { recursive: true });
    const packageRoot = path.join(globalRoot, "openclaw");
    await fs.symlink(store, packageRoot);

    await exposeGlobalPackageThroughRelease(packageRoot, slot, checkout);

    expect((await fs.lstat(packageRoot)).isSymbolicLink()).toBe(true);
    expect(start(path.join(store, "openclaw.mjs"), "--version")).toBe("release\n");
  });
});
