import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { captureEnv } from "../test-utils/env.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import {
  detectGlobalInstallManagerForRoot,
  resolveGlobalInstallTarget,
  resolveNpmGlobalPrefixLayoutFromPrefix,
  type CommandRunner,
} from "./update-global.js";

describe("custom npm global installation ownership", () => {
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;
  afterEach(() => {
    envSnapshot?.restore();
    envSnapshot = undefined;
  });

  it.each(["linux", "darwin", "win32"] as const)(
    "recognizes a custom npm prefix from its OpenClaw launcher on %s without prefix env",
    async (platform) => {
      await withMockedPlatform(platform, async () => {
        await withTestDir({ prefix: "openclaw-update-custom-prefix-" }, async (base) => {
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
              '@ECHO off\r\nSET dp0=%~dp0\r\n"%_prog%" "%dp0%\\node_modules\\openclaw\\openclaw.mjs" %*\r\n',
            );
          } else {
            await fs.symlink(
              "../lib/node_modules/openclaw/openclaw.mjs",
              path.join(layout.binDir, "openclaw"),
            );
          }
          const otherRoot = path.join(
            base,
            ".nvm",
            "versions",
            "node",
            "v26.8.2",
            "lib",
            "node_modules",
          );
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
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "confirms an npmrc prefix using the launcher's Node",
    async () => {
      await withTestDir({ prefix: "openclaw-update-npm-prefix-probe-" }, async (base) => {
        const prefix = path.join(base, ".npm-global");
        const pkgRoot = path.join(prefix, "lib", "node_modules", "openclaw");
        const nodeBin = path.join(base, ".nvm", "versions", "node", "v26.8.2", "bin");
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
      });
    },
  );
});
