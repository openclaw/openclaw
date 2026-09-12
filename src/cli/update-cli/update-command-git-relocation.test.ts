import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import { prepareDirtyGitUpdateRelocation } from "./update-command-git-relocation.js";

const SHA = "a".repeat(40);
const commands = vi.hoisted(() => ({
  dirty: true,
  npmRoot: "/unused/lib/node_modules",
  npmHook: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("../../process/exec.js", async (load) => ({
  ...(await load<typeof import("../../process/exec.js")>()),
  runCommandWithTimeout: vi.fn(async (argv: string[]) => {
    if (argv.includes("status")) {
      return { code: 0, stdout: commands.dirty ? " M local.txt\n" : "", stderr: "" };
    }
    if (argv.includes("rev-parse")) {
      return { code: 0, stdout: SHA, stderr: "" };
    }
    if (argv[0] === "npm") {
      await commands.npmHook?.();
      return {
        code: 0,
        stdout: argv.includes("--version") ? "12.0.0" : commands.npmRoot,
        stderr: "",
      };
    }
    throw new Error(`Unexpected command: ${argv.join(" ")}`);
  }),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  commands.dirty = true;
  commands.npmHook = undefined;
});

async function fixture(base: string) {
  const windows = process.platform === "win32";
  commands.npmRoot = path.join(base, windows ? "prefix/node_modules" : "prefix/lib/node_modules");
  const root = path.join(base, "original");
  const bin = path.join(base, "prefix", ...(windows ? [] : ["bin"]));
  await fs.mkdir(path.join(root, "dist/control-ui/assets"), { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  for (const [file, value] of Object.entries({
    "package.json": JSON.stringify({ name: "openclaw", version: "2026.9.3" }),
    "local.txt": "operator edits\n",
    "dist/entry.js": "export {};\n",
    "dist/build-info.json": JSON.stringify({ commit: SHA, buildId: "previous-build" }),
    "dist/.buildstamp": JSON.stringify({ head: SHA }),
    "dist/.runtime-postbuildstamp": JSON.stringify({ head: SHA }),
    "dist/control-ui/index.html": '<script src="./assets/startup.js"></script>',
    "dist/control-ui/assets/startup.js": "export {};\n",
  })) {
    await fs.writeFile(path.join(root, file), value);
  }
  const launcher = path.join(bin, windows ? "openclaw.cmd" : "openclaw");
  const contents = windows
    ? `@echo off\r\nnode "${path.win32.join(root, "dist", "entry.js")}" %*\r\n`
    : `#!/usr/bin/env bash\nset -euo pipefail\nexec ${process.execPath} ${root}/dist/entry.js "$@"\n`;
  if (windows) {
    await fs.symlink(process.execPath, path.join(bin, "node.exe"));
    vi.stubEnv("PATHEXT", ".EXE");
  }
  await fs.writeFile(launcher, contents, { mode: 0o755 });
  vi.stubEnv("PATH", bin);
  vi.stubEnv("OPENCLAW_GIT_DIR", path.join(base, "fresh"));
  return { root, launcher, contents, bin, packageRoot: path.join(commands.npmRoot, "openclaw") };
}

async function exposeNpmLauncher(
  root: string,
  launcher: string,
  packageRoot: string,
  entry = "openclaw.mjs",
) {
  await fs.writeFile(path.join(root, entry), "#!/usr/bin/env node\n", { mode: 0o755 });
  await fs.mkdir(path.dirname(packageRoot), { recursive: true });
  await fs.symlink(root, packageRoot, process.platform === "win32" ? "junction" : "dir");
  await fs.unlink(launcher);
  if (process.platform === "win32") {
    await fs.writeFile(launcher, NPM_WINDOWS_SHIM);
  } else {
    await fs.symlink(path.join(packageRoot, entry), launcher);
  }
}

it.each(
  (
    [
      { platform: "posix", owner: "installer" },
      { platform: "posix", owner: "npm" },
      { platform: "posix", owner: "installer then npm" },
      { platform: "win32", owner: "npm" },
      { platform: "win32", owner: "installer then npm" },
    ] as const
  ).filter(({ platform }) => process.platform !== "win32" || platform === "win32"),
)(
  "preserves the checkout and pins the $platform $owner launcher prefix",
  async ({ platform, owner }) => {
    await withTestDir({ prefix: "dirty-dev-launcher-" }, (base) =>
      withMockedPlatform(platform === "posix" ? process.platform : platform, async () => {
        const { root: original, launcher, contents, packageRoot } = await fixture(base);
        commands.npmRoot = path.join(base, "unrelated/node_modules");
        let root = original;
        if (owner === "installer then npm") {
          const initial = await prepareDirtyGitUpdateRelocation({ root, timeoutMs: 1000 });
          await expect(initial?.assertCurrent()).resolves.toBeUndefined();
          root = path.join(base, "first-update");
          await fs.cp(original, root, { recursive: true });
        }
        if (owner !== "installer") {
          await exposeNpmLauncher(root, launcher, packageRoot);
        }
        const plan = await prepareDirtyGitUpdateRelocation({ root, timeoutMs: 1000 });
        expect(plan?.directory).toBe(path.join(base, "fresh"));
        expect(plan?.installTarget.packageRoot).toBe(packageRoot);
        await expect(plan?.assertCurrent()).resolves.toBeUndefined();
        expect(await fs.readFile(launcher, "utf8")).toBe(
          owner === "installer"
            ? contents
            : platform === "win32"
              ? NPM_WINDOWS_SHIM
              : "#!/usr/bin/env node\n",
        );
        expect(await fs.readFile(path.join(original, "local.txt"), "utf8")).toBe(
          "operator edits\n",
        );
        expect(await fs.readFile(path.join(root, "local.txt"), "utf8")).toBe("operator edits\n");
        await expect(fs.stat(path.join(base, "fresh"))).rejects.toMatchObject({ code: "ENOENT" });
      }),
    );
  },
);

describe.skipIf(process.platform === "win32")("dirty dev installation relocation", () => {
  it.each([
    "custom launcher",
    "custom executable",
    "custom symlink",
    "outside npm prefix",
    "other package",
    "inside source",
    "changed launcher",
    "changed Node executable",
  ])("refuses %s without touching source", async (kind) => {
    await withTestDir({ prefix: "dirty-dev-refusal-" }, async (base) => {
      const { root, launcher } = await fixture(base);
      if (kind === "custom launcher") {
        await fs.writeFile(launcher, "#!/bin/sh\necho custom\n");
      }
      if (kind === "custom executable") {
        const executable = path.join(base, "custom-program");
        await fs.writeFile(executable, "#!/bin/sh\necho custom\n", { mode: 0o755 });
        await fs.writeFile(
          launcher,
          `#!/usr/bin/env bash\nset -euo pipefail\nexec ${executable} ${root}/dist/entry.js "$@"\n`,
        );
      }
      if (kind === "custom symlink") {
        await exposeNpmLauncher(
          root,
          launcher,
          path.join(commands.npmRoot, "openclaw"),
          "custom.js",
        );
      }
      if (kind === "outside npm prefix") {
        await fs.writeFile(path.join(root, "openclaw.mjs"), "export {};\n", { mode: 0o755 });
        await fs.mkdir(commands.npmRoot, { recursive: true });
        await fs.symlink(root, path.join(commands.npmRoot, "openclaw"));
        const aliasBin = path.join(base, "custom-bin");
        await fs.mkdir(aliasBin);
        await fs.symlink(path.join(root, "openclaw.mjs"), path.join(aliasBin, "openclaw"));
        vi.stubEnv("PATH", aliasBin);
      }
      if (kind === "other package") {
        await fs.mkdir(path.join(base, "prefix/lib/node_modules/openclaw"), { recursive: true });
      }
      if (kind === "inside source") {
        vi.stubEnv("OPENCLAW_GIT_DIR", path.join(root, "nested"));
      }
      if (kind === "changed Node executable") {
        const nodeAlias = path.join(base, "node");
        const replacement = path.join(base, "replacement-node");
        await fs.writeFile(replacement, "#!/bin/sh\necho custom\n", { mode: 0o755 });
        await fs.symlink(process.execPath, nodeAlias);
        await fs.writeFile(
          launcher,
          `#!/usr/bin/env bash\nset -euo pipefail\nexec ${nodeAlias} ${root}/dist/entry.js "$@"\n`,
        );
        commands.npmHook = async () => {
          await fs.unlink(nodeAlias);
          await fs.symlink(replacement, nodeAlias);
        };
      }
      if (kind === "changed launcher") {
        commands.npmHook = () => fs.writeFile(launcher, "#!/bin/sh\necho replacement\n");
      }
      await expect(prepareDirtyGitUpdateRelocation({ root, timeoutMs: 1000 })).rejects.toThrow(
        kind === "changed Node executable"
          ? "active launcher changed"
          : "The original checkout was not changed",
      );
      expect(await fs.readFile(path.join(root, "local.txt"), "utf8")).toBe("operator edits\n");
    });
  });
  it("invalidates a plan when the global package symlink acquires another owner", async () => {
    await withTestDir({ prefix: "dirty-dev-owner-" }, async (base) => {
      const { root } = await fixture(base);
      const target = path.join(base, "prefix/lib/node_modules/openclaw");
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.symlink(root, target);
      const plan = await prepareDirtyGitUpdateRelocation({ root, timeoutMs: 1000 });
      await fs.unlink(target);
      await fs.symlink(base, target);
      await expect(plan?.assertCurrent()).rejects.toThrow("installation path changed");
    });
  });
  it("refuses to recover a different build of the same source commit", async () => {
    await withTestDir({ prefix: "dirty-dev-build-owner-" }, async (base) => {
      const { root } = await fixture(base);
      const plan = await prepareDirtyGitUpdateRelocation({ root, timeoutMs: 1000 });
      await fs.writeFile(
        path.join(root, "dist/build-info.json"),
        JSON.stringify({ commit: SHA, buildId: "replacement-build" }),
      );
      await expect(plan?.assertCurrent()).rejects.toThrow("previous built runtime changed");
    });
  });
  it.each(["appeared", "populated", "replaced"])(
    "refuses a fresh destination that was %s after planning",
    async (change) => {
      await withTestDir({ prefix: "dirty-dev-destination-" }, async (base) => {
        const { root } = await fixture(base);
        const destination = path.join(base, "fresh");
        if (change !== "appeared") {
          await fs.mkdir(destination);
        }
        const plan = await prepareDirtyGitUpdateRelocation({ root, timeoutMs: 1000 });
        if (change === "replaced") {
          await fs.rename(destination, path.join(base, "old-empty"));
        }
        if (change !== "populated") {
          await fs.mkdir(destination);
        }
        if (change === "populated") {
          await fs.writeFile(path.join(destination, "other-owner.txt"), "keep\n");
        }
        await expect(plan?.assertCurrent({ requireFreshDestination: true })).rejects.toThrow(
          "destination changed",
        );
      });
    },
  );
  it("leaves a clean checkout on its existing update route", async () => {
    commands.dirty = false;
    await expect(
      prepareDirtyGitUpdateRelocation({ root: "/unused", timeoutMs: 1000 }),
    ).resolves.toBeUndefined();
  });
});

// Generated with npm cmd-shim@8.0.0 from a bin with #!/usr/bin/env node.
const NPM_WINDOWS_SHIM =
  '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\openclaw\\openclaw.mjs" %*\r\n';

describe("Windows dirty dev installation relocation", () => {
  it.each(["custom commands", "wrong target", "changed contents", "changed Node", "changed entry"])(
    "refuses an npm shim with %s",
    async (change) => {
      await withTestDir({ prefix: "dirty-dev-npm-refusal-" }, (base) =>
        withMockedPlatform("win32", async () => {
          const { root, launcher, bin } = await fixture(base);
          await exposeNpmLauncher(root, launcher, path.join(commands.npmRoot, "openclaw"));
          if (change === "custom commands" || change === "wrong target") {
            await fs.writeFile(
              launcher,
              change === "custom commands"
                ? `echo custom setup\r\n${NPM_WINDOWS_SHIM}`
                : NPM_WINDOWS_SHIM.replace("openclaw.mjs", "custom.mjs"),
            );
            await expect(
              prepareDirtyGitUpdateRelocation({ root, timeoutMs: 1000 }),
            ).rejects.toThrow("custom or unrelated launcher");
          } else {
            const plan = await prepareDirtyGitUpdateRelocation({ root, timeoutMs: 1000 });
            if (change === "changed contents") {
              await fs.appendFile(launcher, "echo custom command\r\n");
            } else if (change === "changed entry") {
              const other = path.join(base, "custom.mjs");
              await fs.writeFile(other, "export {};\n");
              await fs.unlink(path.join(root, "openclaw.mjs"));
              await fs.symlink(other, path.join(root, "openclaw.mjs"));
            } else {
              await fs.unlink(path.join(bin, "node.exe"));
              await fs.writeFile(path.join(bin, "node.exe"), "replacement executable\n");
            }
            await expect(plan?.assertCurrent()).rejects.toThrow("active launcher changed");
          }
          expect(await fs.readFile(path.join(root, "local.txt"), "utf8")).toBe("operator edits\n");
        }),
      );
    },
  );
});
