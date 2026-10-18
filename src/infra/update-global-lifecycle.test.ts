import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { captureEnv } from "../test-utils/env.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import type { CommandRunner } from "./update-global-command-runner.js";
import {
  detectGlobalInstallManagerForRoot,
  globalInstallArgs,
  resolveGlobalInstallTarget,
} from "./update-global.js";
import { resolveNpmGlobalPrefixLayoutFromPrefix } from "./update-npm-prefix.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: vi.fn(() => "/tmp/openclaw-test-global-npmrc\n"),
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);

const installArgs = (spec: string, cwd?: string) => globalInstallArgs("npm", spec, null, null, cwd);

describe("npm global install lifecycle policy", () => {
  it("applies an unflagged npm policy to install argv", () => {
    expect(
      globalInstallArgs("npm", "openclaw@latest", null, null, null, "unflagged"),
    ).not.toContain("--allow-scripts=openclaw");
  });

  it("builds npm staged install argv with an explicit prefix", () => {
    expect(globalInstallArgs("npm", "openclaw@latest", null, "/tmp/stage")).toEqual(
      "npm i -g --allow-scripts=openclaw --prefix /tmp/stage openclaw@latest --no-fund --no-audit --loglevel=error --min-release-age=0".split(
        " ",
      ),
    );
  });

  const cwd = path.resolve("/tmp/openclaw-update-identity/work");
  const archive = path.resolve("/tmp/openclaw/a%2C#b.tar");
  it.each([
    [path.resolve("/tmp/openclaw-2026.7.2.tgz"), path.resolve("/tmp/openclaw-2026.7.2.tgz")],
    ["openclaw@npm:@vendor/openclaw@1.2.3", "@vendor/openclaw"],
    ["openclaw@npm:vendor-openclaw@1.2.3", "vendor-openclaw"],
    ["openclaw@npm:@vendor/client.tgz@1.2.3", "@vendor/client.tgz"],
    ["./openclaw-candidate", "./openclaw-candidate"],
    ["vendor/repo.tgz", "vendor/repo.tgz"],
    ["vendor/repo#release.tgz", "vendor/repo#release.tgz"],
    ["../candidate.tgz", path.resolve(cwd, "../candidate.tgz")],
    ["file:~/candidate.tgz", `file:${path.join(os.homedir(), "candidate.tgz")}`],
    [`file:///${archive.replaceAll("\\", "/").replace(/^\/+/u, "")}`, `file:${archive}`],
  ] as const)("allows only the resolved lifecycle identity for %s", (spec, identity) => {
    expect(installArgs(spec, cwd)).toEqual(
      expect.arrayContaining([spec, `--allow-scripts=${identity}`]),
    );
  });

  it.each([
    ["allow-scripts", true],
    ["allow-scripts-advisory", false],
  ] as const)("handles comma archive identities with npm policy %s", (policy, rejects) => {
    const commaCwd = path.resolve("/tmp/build,cache");
    const install = () =>
      globalInstallArgs("npm", path.join(commaCwd, "candidate.tgz"), null, null, commaCwd, policy);
    if (rejects) {
      expect(install).toThrow("without commas");
    } else {
      expect(install()).toContain("--allow-scripts=./candidate.tgz");
    }
  });
});

describe("custom npm global installation ownership", () => {
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;
  afterEach(() => {
    envSnapshot?.restore();
    envSnapshot = undefined;
  });

  it.each(["linux", "win32"] as const)(
    "recognizes a custom npm prefix from its OpenClaw launcher on %s without prefix env",
    async (platform) => {
      await withMockedPlatform(platform, async () => {
        const base = dirs.make("openclaw-update-custom-prefix-");

        envSnapshot = captureEnv(["NPM_CONFIG_PREFIX", "npm_config_prefix"]);
        delete process.env.NPM_CONFIG_PREFIX;
        delete process.env.npm_config_prefix;
        const prefix = path.join(base, ".npm-global");
        const layout = resolveNpmGlobalPrefixLayoutFromPrefix(prefix);
        const pkgRoot = path.join(layout.globalRoot, "openclaw");
        await fs.mkdir(pkgRoot, { recursive: true });
        await fs.mkdir(layout.binDir, { recursive: true });
        await fs.writeFile(path.join(pkgRoot, "openclaw.mjs"), "#!/usr/bin/env node\n");
        if (platform === "win32") {
          await fs.writeFile(
            path.join(layout.binDir, "openclaw.cmd"),
            [
              "SETLOCAL",
              "SET dp0=%~dp0",
              'SET "_prog=node"',
              'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\openclaw\\openclaw.mjs" %*',
              "",
            ].join("\r\n"),
          );
        } else {
          await fs.symlink(
            "../lib/node_modules/openclaw/openclaw.mjs",
            path.join(layout.binDir, "openclaw"),
          );
        }
        const otherRoot = path.join(base, ".nvm/versions/node/v26.8.2/lib/node_modules");
        const runCommand: CommandRunner = async (argv) => ({
          stdout: argv[1] === "--version" ? "12.0.0\n" : `${otherRoot}\n`,
          stderr: "",
          code: argv[0] === "npm" ? 0 : 1,
        });

        await expect(detectGlobalInstallManagerForRoot(runCommand, pkgRoot, 1000)).resolves.toBe(
          "npm",
        );
        await expect(
          resolveGlobalInstallTarget({ manager: "npm", runCommand, timeoutMs: 1000, pkgRoot }),
        ).resolves.toMatchObject({
          manager: "npm",
          globalRoot: layout.globalRoot,
          packageRoot: pkgRoot,
        });
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "confirms an npmrc prefix using the launcher's Node",
    async () => {
      const base = dirs.make("openclaw-update-npm-prefix-probe-");

      const prefix = path.join(base, ".npm-global");
      const pkgRoot = path.join(prefix, "lib/node_modules/openclaw");
      const nodeBin = path.join(base, ".nvm/versions/node/v26.8.2/bin");
      const npmCli = path.join(nodeBin, "npm-cli.js");
      await fs.mkdir(pkgRoot, { recursive: true });
      await fs.mkdir(nodeBin, { recursive: true });
      await fs.writeFile(npmCli, "#!/usr/bin/env node\n", { mode: 0o755 });
      await fs.symlink(npmCli, path.join(nodeBin, "npm"));
      envSnapshot = captureEnv(["PATH", "NPM_CONFIG_PREFIX", "npm_config_prefix"]);
      process.env.PATH = nodeBin;
      delete process.env.NPM_CONFIG_PREFIX;
      delete process.env.npm_config_prefix;
      const runCommand = vi.fn<CommandRunner>(async (argv) => ({
        stdout: argv.slice(-2).join(" ") === "prefix -g" ? `${prefix}\n` : "",
        stderr: "",
        code: 0,
      }));

      await expect(detectGlobalInstallManagerForRoot(runCommand, pkgRoot, 1000)).resolves.toBe(
        "npm",
      );
      expect(runCommand).toHaveBeenCalledWith(
        [process.execPath, npmCli, "prefix", "-g"],
        expect.objectContaining({ timeoutMs: 1000 }),
      );
    },
  );
});
