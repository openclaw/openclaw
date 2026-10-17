import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDirAsync } = createScriptTestHarness();
const NATIVE_NAME = "@openclaw/fs-safe-linux-x64-musl";
const NATIVE_VERSION = "1.2.3";

async function writeJson(file: string, value: unknown) {
  await fs.writeFile(file, JSON.stringify(value));
}

async function expectAbsent(file: string) {
  await expect(fs.access(file)).rejects.toHaveProperty("code", "ENOENT");
}

async function createFixture() {
  const packageRoot = await createTempDirAsync("openclaw-prebuild-");
  const fsSafeRoot = path.join(packageRoot, "node_modules", "@openclaw", "fs-safe");
  const script = path.join(packageRoot, "scripts", "postinstall-bundled-plugins.mjs");
  const callsPath = path.join(packageRoot, "npm-calls.jsonl");
  const npmCli = path.join(packageRoot, "npm-cli.js");
  for (const file of [
    "scripts/postinstall-bundled-plugins.mjs",
    "scripts/windows-cmd-helpers.mjs",
    "scripts/lib/package-lifecycle-marker.mjs",
    "scripts/lib/fs-safe-prebuild.mjs",
  ]) {
    const destination = path.join(packageRoot, file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(fileURLToPath(new URL(`../../${file}`, import.meta.url)), destination);
  }
  await fs.mkdir(fsSafeRoot, { recursive: true });
  await writeJson(path.join(packageRoot, "package.json"), {
    name: "openclaw",
    type: "module",
    dependencies: { "@openclaw/fs-safe": "1.2.3" },
  });
  await fs.writeFile(path.join(packageRoot, ".openclaw-lifecycle-pending"), "pending\n");
  await writeJson(path.join(fsSafeRoot, "package.json"), {
    name: "@openclaw/fs-safe",
    type: "module",
    version: "1.2.3",
    exports: {
      ".": "./copy.js",
      "./package.json": "./package.json",
      "./config": "./config.js",
      "./copy": "./copy.js",
    },
    optionalDependencies: {
      "@openclaw/fs-safe-linux-x64-gnu": "1.2.4",
      [NATIVE_NAME]: NATIVE_VERSION,
      jszip: "^3.10.2",
    },
  });
  await fs.writeFile(
    path.join(fsSafeRoot, "config.js"),
    `
    let mode = process.env.FS_SAFE_NATIVE_MODE ?? "auto";
    export function configureFsSafeNative(config) { mode = config.mode; }
    export function getFsSafeNativeConfig() { return { mode }; }
  `,
  );
  await fs.writeFile(
    path.join(fsSafeRoot, "copy.js"),
    `
    import { createRequire } from "node:module";
    import { getFsSafeNativeConfig } from "./config.js";
    const require = createRequire(import.meta.url);
    export async function readCloneFileMetadata(paths) {
      if (getFsSafeNativeConfig().mode !== "require" || paths.length !== 0) {
        throw new Error("probe must use the read-only native contract");
      }
      if (process.env.FIXTURE_UNSUPPORTED) throw new Error("Unsupported OS or architecture");
      let binding;
      try { binding = require(${JSON.stringify(NATIVE_NAME)}); }
      catch (cause) { throw Object.assign(new Error("native unavailable", { cause }), { code: "helper-unavailable" }); }
      return binding.readCloneFileMetadata(paths);
    }
  `,
  );
  await fs.writeFile(
    npmCli,
    `
    import fs from "node:fs";
    import path from "node:path";
    const args = process.argv.slice(2);
    if (Object.keys(process.env).some(key => key.toLowerCase() === "npm_config_allow_scripts")) {
      throw new Error("global allow-scripts leaked into the project install");
    }
    fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(args) + "\\n");
    if (process.env.FIXTURE_NPM_FAIL) process.exit(1);
    const prefix = args[args.indexOf("--prefix") + 1];
    const target = path.join(prefix, "node_modules", ${JSON.stringify(NATIVE_NAME)});
    fs.mkdirSync(path.join(target, "lib"), { recursive: true });
    fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({
      name: ${JSON.stringify(NATIVE_NAME)}, version: process.env.FIXTURE_WRONG_VERSION ? "9.9.9" : ${JSON.stringify(NATIVE_VERSION)}, main: "lib/index.cjs",
    }));
    fs.writeFileSync(path.join(target, "lib/index.cjs"), process.env.FIXTURE_BROKEN_DOWNLOAD
      ? "throw new Error('addon load failed')"
      : "module.exports.readCloneFileMetadata = (paths) => paths;");
  `,
  );
  const env = {
    ...process.env,
    FS_SAFE_NATIVE_MODE: "auto",
    OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL: "",
    npm_execpath: npmCli,
    npm_config_omit: "optional",
    npm_config_allow_scripts: "openclaw",
    NPM_CONFIG_ALLOW_SCRIPTS: "openclaw",
    npm_config_global: "true",
    npm_config_prefix: path.join(packageRoot, "other-install"),
    FIXTURE_CALLS: callsPath,
  };
  const run = (overrides: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [script], {
      cwd: packageRoot,
      env: { ...env, ...overrides },
      encoding: "utf8",
      timeout: 30_000,
    });
  const nativeRoot = path.join(fsSafeRoot, "node_modules", NATIVE_NAME);
  const calls = async () => (await fs.readFile(callsPath, "utf8")).trim().split("\n");
  const restore = (overrides: NodeJS.ProcessEnv = {}) => {
    const result = run(overrides);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout, result.stderr).toContain(`restored ${NATIVE_NAME}@${NATIVE_VERSION}`);
    return result;
  };
  return {
    packageRoot,
    fsSafeRoot,
    run,
    callsPath,
    npmCli,
    nativeRoot,
    calls,
    restore,
  };
}

async function expectCompleted(fixture: Awaited<ReturnType<typeof createFixture>>) {
  await expectAbsent(path.join(fixture.packageRoot, ".openclaw-lifecycle-pending"));
  expect(
    (await fs.readdir(fixture.packageRoot)).filter((entry) =>
      entry.startsWith(".openclaw-prebuild-"),
    ),
  ).toEqual([]);
}

describe("packaged fs-safe prebuild restoration", () => {
  it("restores only the exact loader-selected prebuild without reifying installed manifests", async () => {
    const fixture = await createFixture();
    const manifestPath = path.join(fixture.fsSafeRoot, "package.json");
    const before = await fs.readFile(manifestPath);
    fixture.restore();
    expect(
      JSON.parse(await fs.readFile(path.join(fixture.nativeRoot, "package.json"), "utf8")),
    ).toMatchObject({ name: NATIVE_NAME, version: NATIVE_VERSION });
    expect(await fs.readFile(manifestPath)).toEqual(before);
    const calls = (await fixture.calls()).map((line) => JSON.parse(line) as string[]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(
      expect.arrayContaining([
        `${NATIVE_NAME}@${NATIVE_VERSION}`,
        "--ignore-scripts",
        "--include=optional",
        "--global=false",
        "--workspaces=false",
        "--package-lock=false",
        "--save=false",
      ]),
    );
    expect(calls[0]?.filter((arg) => arg.startsWith("@"))).toEqual([
      `${NATIVE_NAME}@${NATIVE_VERSION}`,
    ]);
    await expectAbsent(path.join(fixture.packageRoot, "other-install"));
    await expectCompleted(fixture);
    const healthy = fixture.run({ FIXTURE_NPM_FAIL: "1" });
    expect(healthy.status, healthy.stderr).toBe(0);
    expect(healthy.stderr).toBe("");
    expect(await fixture.calls()).toHaveLength(1);
  });

  it.each([
    ["offline download", { FIXTURE_NPM_FAIL: "1" }, "npm could not download"],
    ["wrong version", { FIXTURE_WRONG_VERSION: "1" }, "matching native package"],
    ["unloadable download", { FIXTURE_BROKEN_DOWNLOAD: "1" }, "restored native binding"],
  ] satisfies Array<[string, NodeJS.ProcessEnv, string]>)(
    "warns and completes lifecycle after %s",
    async (_name, env, warning) => {
      const fixture = await createFixture();
      const result = fixture.run(env);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain(warning);
      expect(result.stdout).not.toContain("restored");
      await expectAbsent(fixture.nativeRoot);
      await expectCompleted(fixture);
    },
  );

  it.each([
    ["disabled native mode", { FS_SAFE_NATIVE_MODE: "off" }, false, false],
    ["unsupported platform", { FIXTURE_UNSUPPORTED: "1" }, true, false],
    ["disabled postinstall", { OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL: "1" }, false, false],
    ["source checkout", {}, false, true],
  ] satisfies Array<[string, NodeJS.ProcessEnv, boolean, boolean]>)(
    "makes no npm request for %s",
    async (_name, env, warning, source) => {
      const fixture = await createFixture();
      if (source) {
        for (const directory of [".git", "src", "extensions"]) {
          await fs.mkdir(path.join(fixture.packageRoot, directory));
        }
      }
      const result = fixture.run(env);
      expect(result.status, result.stderr).toBe(0);
      expect(Boolean(result.stderr)).toBe(warning);
      await expectAbsent(fixture.callsPath);
      if (source) {
        expect(result.stderr).toBe("");
        await expectAbsent(fixture.nativeRoot);
      } else {
        await expectCompleted(fixture);
      }
    },
  );

  it("runs the PATH-selected npm CLI directly when deferred lifecycle has no npm_execpath", async () => {
    const fixture = await createFixture();
    const bin = path.join(fixture.packageRoot, "selected-npm");
    await fs.mkdir(bin);
    const directCli =
      process.platform === "win32"
        ? path.join(bin, "node_modules", "npm", "bin", "npm-cli.js")
        : path.join(bin, "npm-cli.js");
    await fs.mkdir(path.dirname(directCli), { recursive: true });
    await fs.copyFile(fixture.npmCli, directCli);
    await fs.chmod(directCli, 0o755);
    if (process.platform === "win32") {
      await fs.writeFile(path.join(bin, "npm.cmd"), "@exit /b 97\r\n");
    } else {
      await fs.symlink(directCli, path.join(bin, "npm"));
    }
    fixture.restore({ npm_execpath: undefined, PATH: bin });
    await expectCompleted(fixture);
  });

  it.skipIf(process.platform === "win32")(
    "follows the selected manager shim without initializing npm during discovery",
    async () => {
      const fixture = await createFixture();
      const bin = path.join(fixture.packageRoot, "manager-bin");
      const npmRoot = path.join(fixture.packageRoot, "manager-npm");
      const cli = path.join(npmRoot, "bin", "npm-cli.js");
      await fs.mkdir(bin);
      await fs.mkdir(path.dirname(cli), { recursive: true });
      await writeJson(path.join(npmRoot, "package.json"), { name: "npm", type: "module" });
      const original = await fs.readFile(fixture.npmCli, "utf8");
      await fs.writeFile(
        cli,
        `
      if (process.argv.includes("--version")) throw new Error("npm initialized before discovery completed");
      if ([process.env.NODE_OPTIONS, process.env.BUN_OPTIONS].some(value => value?.includes("data:text/javascript"))) throw new Error("discovery preload leaked into install");
      ${original}
    `,
      );
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      await fs.writeFile(
        path.join(bin, "npm"),
        `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`,
        { mode: 0o755 },
      );
      fixture.restore({ npm_execpath: undefined, PATH: bin });
      expect(await fixture.calls()).toHaveLength(1);
      await expectCompleted(fixture);
    },
  );

  it.skipIf(process.platform === "win32").each([
    { name: "does not identify npm", body: "console.log('11.19.0');", warning: "did not report" },
    { name: "times out", body: "setInterval(() => {}, 1000);", warning: "discovery timed out" },
  ])(
    "warns without starting an install when a shim $name",
    { timeout: 20_000 },
    async ({ body, warning }) => {
      const fixture = await createFixture();
      const bin = path.join(fixture.packageRoot, "manager-bin");
      const pidFile = path.join(fixture.packageRoot, "discovery-pid.json");
      await fs.mkdir(bin);
      await fs.writeFile(
        path.join(bin, "npm"),
        `#!${process.execPath}\nimport fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }));\n${body}\n`,
        { mode: 0o755 },
      );
      const result = fixture.run({ npm_execpath: undefined, PATH: bin });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain(warning);
      const discovery = JSON.parse(await fs.readFile(pidFile, "utf8")) as {
        pid: number;
        args: string[];
      };
      expect(discovery.args).toEqual(["--version"]);
      expect(() => process.kill(discovery.pid, 0)).toThrow();
      await expectAbsent(fixture.callsPath);
      await expectAbsent(fixture.nativeRoot);
      await expectCompleted(fixture);
    },
  );

  it.each(["dependency", "node_modules"])(
    "does not repair through a symlinked %s owner",
    async (owner) => {
      const fixture = await createFixture();
      const externalRoot = await createTempDirAsync("openclaw-prebuild-other-owner-");
      const externalDependency = path.join(externalRoot, "fs-safe");
      const linkPath =
        owner === "dependency" ? fixture.fsSafeRoot : path.join(fixture.fsSafeRoot, "node_modules");
      if (owner === "dependency") {
        await fs.rename(fixture.fsSafeRoot, externalDependency);
      }
      await fs.symlink(
        owner === "dependency" ? externalDependency : externalRoot,
        linkPath,
        process.platform === "win32" ? "junction" : "dir",
      );
      const before = await fs.readdir(externalRoot);
      const result = fixture.run();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("native support is unavailable");
      expect(await fs.readdir(externalRoot)).toEqual(before);
      await expectCompleted(fixture);
    },
  );

  it.each([
    ["invalid native binary", "fs-safe-native.node", "invalid binary"],
    ["missing transitive module", "index.cjs", "require('missing-native-runtime');"],
    [
      "missing transitive platform package",
      "index.cjs",
      "require('@openclaw/fs-safe-linux-x64-gnu');",
    ],
    [
      "native operation failure",
      "index.cjs",
      "module.exports.readCloneFileMetadata = () => { throw new Error('EIO'); };",
    ],
  ])(
    "preserves an installed package after %s without retrying through npm",
    async (_name, main, code) => {
      const fixture = await createFixture();
      await fs.mkdir(fixture.nativeRoot, { recursive: true });
      await writeJson(path.join(fixture.nativeRoot, "package.json"), {
        name: NATIVE_NAME,
        version: NATIVE_VERSION,
        main,
      });
      await fs.writeFile(path.join(fixture.nativeRoot, main), code);
      const result = fixture.run();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("could not be loaded or used");
      await expectAbsent(fixture.callsPath);
      expect(await fs.readFile(path.join(fixture.nativeRoot, main), "utf8")).toBe(code);
      await expectCompleted(fixture);
    },
  );
});
