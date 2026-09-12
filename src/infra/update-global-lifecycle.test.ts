import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { captureEnv } from "../test-utils/env.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import {
  detectGlobalInstallManagerForRoot,
  globalInstallArgs,
  globalInstallFallbackArgs,
  resolveGlobalInstallTarget,
  resolveNpmGlobalPrefixLayoutFromPrefix,
  type CommandRunner,
} from "./update-global.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: vi.fn(() => "/tmp/openclaw-test-global-npmrc\n"),
}));

describe("npm global install lifecycle policy", () => {
  it("applies an unflagged npm policy to primary and retry argv", () => {
    expect(
      globalInstallArgs("npm", "openclaw@latest", null, null, null, "unflagged"),
    ).not.toContain("--allow-scripts=openclaw");
    expect(
      globalInstallFallbackArgs("npm", "openclaw@latest", null, null, null, "unflagged"),
    ).toEqual(expect.arrayContaining(["--omit=optional"]));
    expect(
      globalInstallFallbackArgs("npm", "openclaw@latest", null, null, null, "unflagged"),
    ).not.toContain("--allow-scripts=openclaw");
  });

  it("builds npm staged install argv with an explicit prefix", () => {
    expect(globalInstallArgs("npm", "openclaw@latest", null, "/tmp/stage")).toEqual([
      "npm",
      "i",
      "-g",
      "--allow-scripts=openclaw",
      "--prefix",
      "/tmp/stage",
      "openclaw@latest",
      "--no-fund",
      "--no-audit",
      "--loglevel=error",
      "--min-release-age=0",
    ]);
    expect(globalInstallFallbackArgs("npm", "openclaw@latest", null, "/tmp/stage")).toEqual([
      "npm",
      "i",
      "-g",
      "--allow-scripts=openclaw",
      "--prefix",
      "/tmp/stage",
      "openclaw@latest",
      "--omit=optional",
      "--no-fund",
      "--no-audit",
      "--loglevel=error",
      "--min-release-age=0",
    ]);
  });

  it("omits npm's lifecycle allowlist before npm 11.16", () => {
    expect(
      globalInstallArgs("npm", "openclaw@latest", null, null, null, "unflagged"),
    ).not.toContain("--allow-scripts=openclaw");
  });

  it("allows only the resolved npm candidate lifecycle identity", () => {
    const archive = path.resolve("/tmp/openclaw-2026.7.2.tgz");
    expect(globalInstallArgs("npm", archive)).toContain(`--allow-scripts=${archive}`);
    expect(globalInstallArgs("npm", "openclaw@npm:@vendor/openclaw@1.2.3")).toContain(
      "--allow-scripts=@vendor/openclaw",
    );
    expect(globalInstallArgs("npm", "openclaw@npm:vendor-openclaw@1.2.3")).toContain(
      "--allow-scripts=vendor-openclaw",
    );
    expect(globalInstallArgs("npm", "openclaw@npm:@vendor/client.tgz@1.2.3")).toContain(
      "--allow-scripts=@vendor/client.tgz",
    );
    expect(globalInstallArgs("npm", "./openclaw-candidate")).toContain(
      "--allow-scripts=./openclaw-candidate",
    );
    for (const spec of ["vendor/repo.tgz", "vendor/repo#release.tgz"]) {
      expect(globalInstallArgs("npm", spec)).toContain(`--allow-scripts=${spec}`);
    }
  });

  it("keeps commas in ancestor directories out of npm's lifecycle policy", () => {
    expect(
      globalInstallArgs(
        "npm",
        "/tmp/build,cache/openclaw-candidate",
        null,
        null,
        "/tmp/build,cache",
      ),
    ).toContain("--allow-scripts=./openclaw-candidate");
  });

  it.each(["absolute", "relative", "file:absolute", "file:relative"])(
    "uses the absolute npm tarball identity for %s input",
    (form) => {
      const cwd = path.resolve("/tmp/openclaw-update-identity/work");
      const candidate = path.resolve(cwd, "../candidate.tgz");
      const protocol = form.startsWith("file:") ? "file:" : "";
      const spec = `${protocol}${form.endsWith("relative") ? "../candidate.tgz" : candidate}`;
      for (const buildArgs of [globalInstallArgs, globalInstallFallbackArgs]) {
        const args = buildArgs("npm", spec, null, null, cwd);
        expect(args).toContain(`--allow-scripts=${protocol}${candidate}`);
        expect(args).toContain(spec);
      }
    },
  );

  it("rejects comma tarball identities before building npm install commands", () => {
    const cwd = path.resolve("/tmp/build,cache");
    for (const buildArgs of [globalInstallArgs, globalInstallFallbackArgs]) {
      expect(() => buildArgs("npm", path.join(cwd, "candidate.tgz"), null, null, cwd)).toThrow(
        "without commas",
      );
    }
  });

  it.each([
    "file:/../candidate.tgz",
    "file:///../candidate.tgz",
    "file:~/candidate.tgz",
    "file:/~/candidate.tgz",
    "file:///~/candidate.tgz",
    "file:./~/candidate.tgz",
  ])("preserves npm's local archive resolution for %s", (spec) => {
    const cwd = path.resolve("/tmp/openclaw-update-identity/work");
    const expected = spec.includes("~")
      ? path.join(os.homedir(), "candidate.tgz")
      : path.resolve(cwd, "../candidate.tgz");
    expect(globalInstallArgs("npm", spec, null, null, cwd)).toContain(
      `--allow-scripts=file:${expected}`,
    );
  });

  it.each(["tgz", "tar.gz", "tar"])(
    "normalizes file URLs while preserving literal archive characters for .%s",
    (extension) => {
      const archive = path.resolve(`/tmp/openclaw/a%2C#b.${extension}`);
      const spec = `file:///${archive.replaceAll("\\", "/").replace(/^\/+/u, "")}`;
      expect(globalInstallArgs("npm", spec)).toContain(`--allow-scripts=file:${archive}`);
    },
  );

  it("preserves npm 11 advisory comma-archive identity without changing npm policy", () => {
    const cwd = path.resolve("/tmp/build,cache");
    for (const buildArgs of [globalInstallArgs, globalInstallFallbackArgs]) {
      expect(
        buildArgs(
          "npm",
          path.join(cwd, "candidate.tgz"),
          null,
          null,
          cwd,
          "allow-scripts-advisory",
        ),
      ).toContain("--allow-scripts=./candidate.tgz");
    }
  });
});

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
              [
                "@ECHO off",
                "GOTO start",
                ":find_dp0",
                "SET dp0=%~dp0",
                "EXIT /b",
                ":start",
                "SETLOCAL",
                "CALL :find_dp0",
                "",
                'IF EXIST "%dp0%\\node.exe" (',
                '  SET "_prog=%dp0%\\node.exe"',
                ") ELSE (",
                '  SET "_prog=node"',
                "  SET PATHEXT=%PATHEXT:;.JS;=;%",
                ")",
                "",
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
