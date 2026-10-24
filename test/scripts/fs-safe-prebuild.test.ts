import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDirAsync } = createScriptTestHarness();
const NATIVE_NAME = "@openclaw/fs-safe-linux-x64-musl";
const NATIVE_VERSION = "1.2.3";
const NATIVE_SPEC = `${NATIVE_NAME}@${NATIVE_VERSION}`;
const nativeManifest = { name: NATIVE_NAME, version: NATIVE_VERSION };
const read = (file: string) => fs.readFile(file, "utf8");

async function write(file: string, value: object | string, executable = false) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof value === "string" ? value : JSON.stringify(value), {
    mode: executable ? 0o755 : undefined,
  });
}

async function expectAbsent(file: string) {
  await expect(fs.access(file)).rejects.toHaveProperty("code", "ENOENT");
}

async function createFixture() {
  const packageRoot = await createTempDirAsync("openclaw-prebuild-");
  const local = (file: string) => path.join(packageRoot, file);
  const fsSafeRoot = local("node_modules/@openclaw/fs-safe");
  const script = local("scripts/postinstall-bundled-plugins.mjs");
  const callsPath = local("npm-calls.jsonl");
  const npmCli = local("npm-cli.js");
  for (const file of [
    "scripts/postinstall-bundled-plugins.mjs",
    "scripts/windows-cmd-helpers.mjs",
    "scripts/lib/package-lifecycle-marker.mjs",
    "scripts/lib/fs-safe-prebuild.mjs",
  ]) {
    await write(local(file), await read(fileURLToPath(new URL(`../../${file}`, import.meta.url))));
  }
  await write(local("package.json"), {
    type: "module",
    dependencies: { "@openclaw/fs-safe": "1.2.3" },
  });
  await write(local(".openclaw-lifecycle-pending"), "pending\n");
  await write(path.join(fsSafeRoot, "package.json"), {
    name: "@openclaw/fs-safe",
    type: "module",
    exports: {
      ".": "./copy.js",
      "./package.json": "./package.json",
      "./config": "./copy.js",
      "./copy": "./copy.js",
    },
    optionalDependencies: {
      "@openclaw/fs-safe-linux-x64-gnu": "1.2.4",
      [NATIVE_NAME]: NATIVE_VERSION,
      jszip: "^3.10.2",
    },
  });
  await write(
    path.join(fsSafeRoot, "copy.js"),
    `
    import { createRequire } from "node:module";
    let mode = process.env.FS_SAFE_NATIVE_MODE ?? "auto";
    export function configureFsSafeNative(config) { mode = config.mode; }
    export function getFsSafeNativeConfig() { return { mode }; }
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
  await write(
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
    npm_config_prefix: local("other-install"),
    FIXTURE_CALLS: callsPath,
  };
  const run = async (overrides: NodeJS.ProcessEnv = {}, completed = true) => {
    const result = spawnSync(process.execPath, [script], {
      cwd: packageRoot,
      env: { ...env, ...overrides },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
    if (completed) {
      await expectAbsent(local(".openclaw-lifecycle-pending"));
      expect(
        (await fs.readdir(packageRoot)).filter((entry) => entry.startsWith(".openclaw-prebuild-")),
      ).toEqual([]);
    }
    return result;
  };
  const nativeRoot = path.join(fsSafeRoot, "node_modules", NATIVE_NAME);
  const calls = async () => (await read(callsPath)).trim().split("\n");
  const restore = async (overrides: NodeJS.ProcessEnv = {}) => {
    const result = await run(overrides);
    expect(result.stdout, result.stderr).toContain(`restored ${NATIVE_SPEC}`);
    return result;
  };
  const managerBin = local("manager-bin");
  const launcher = async (code: string) => {
    await write(path.join(managerBin, "npm"), code, true);
    return run({ npm_execpath: undefined, PATH: managerBin });
  };
  return { local, fsSafeRoot, run, callsPath, npmCli, nativeRoot, calls, restore, launcher };
}

let fixture: Awaited<ReturnType<typeof createFixture>>;
beforeEach(async () => {
  fixture = await createFixture();
});
it("restores only the exact loader-selected prebuild without reifying installed manifests", async () => {
  const manifestPath = path.join(fixture.fsSafeRoot, "package.json");
  const before = await fs.readFile(manifestPath);
  await fixture.restore();
  expect(JSON.parse(await read(path.join(fixture.nativeRoot, "package.json")))).toMatchObject(
    nativeManifest,
  );
  expect(await fs.readFile(manifestPath)).toEqual(before);
  const calls = (await fixture.calls()).map((line) => JSON.parse(line) as string[]);
  expect(calls).toEqual([
    expect.arrayContaining([
      NATIVE_SPEC,
      "--ignore-scripts",
      "--include=optional",
      "--global=false",
      "--workspaces=false",
      "--package-lock=false",
      "--save=false",
    ]),
  ]);
  expect(calls[0]?.filter((arg) => arg.startsWith("@"))).toEqual([NATIVE_SPEC]);
  await expectAbsent(fixture.local("other-install"));
  expect(await fixture.run({ FIXTURE_NPM_FAIL: "1" })).toHaveProperty("stderr", "");
  expect(await fixture.calls()).toHaveLength(1);
});

it.each([
  ["offline download", { FIXTURE_NPM_FAIL: "1" }, "npm could not download"],
  ["wrong version", { FIXTURE_WRONG_VERSION: "1" }, "matching native package"],
  ["unloadable download", { FIXTURE_BROKEN_DOWNLOAD: "1" }, "restored native binding"],
] satisfies Array<[string, NodeJS.ProcessEnv, string]>)(
  "warns and completes lifecycle after %s",
  async (_name, env, warning) => {
    const result = await fixture.run(env);
    expect(result.stderr).toContain(warning);
    expect(result.stdout).not.toContain("restored");
    await expectAbsent(fixture.nativeRoot);
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
    if (source) {
      for (const directory of [".git", "src", "extensions"]) {
        await fs.mkdir(fixture.local(directory));
      }
    }
    const result = await fixture.run(env, !source);
    expect(Boolean(result.stderr)).toBe(warning);
    await expectAbsent(fixture.callsPath);
    if (source) {
      await expectAbsent(fixture.nativeRoot);
    }
  },
);

it("runs the PATH-selected npm CLI directly when deferred lifecycle has no npm_execpath", async () => {
  const bin = fixture.local("selected-npm");
  const directCli = path.join(
    bin,
    process.platform === "win32" ? "node_modules/npm/bin/npm-cli.js" : "npm-cli.js",
  );
  await write(directCli, await read(fixture.npmCli), true);
  if (process.platform === "win32") {
    await fs.writeFile(path.join(bin, "npm.cmd"), "@exit /b 97\r\n");
  } else {
    await fs.symlink(directCli, path.join(bin, "npm"));
  }
  await fixture.restore({ npm_execpath: undefined, PATH: bin });
});

it.skipIf(process.platform === "win32")(
  "follows the selected manager shim without initializing npm during discovery",
  async () => {
    const npmRoot = fixture.local("manager-npm");
    const cli = path.join(npmRoot, "bin", "npm-cli.js");
    await write(path.join(npmRoot, "package.json"), { name: "npm", type: "module" });
    const original = await read(fixture.npmCli);
    await write(
      cli,
      `
      if (process.argv.includes("--version")) throw new Error("npm initialized before discovery completed");
      if ([process.env.NODE_OPTIONS, process.env.BUN_OPTIONS].some(value => value?.includes("data:text/javascript"))) throw new Error("discovery preload leaked into install");
      ${original}
    `,
    );
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const result = await fixture.launcher(
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`,
    );
    expect(result.stdout, result.stderr).toContain(`restored ${NATIVE_SPEC}`);
    expect(await fixture.calls()).toHaveLength(1);
  },
);

it.skipIf(process.platform === "win32").each([
  { name: "does not identify npm", body: "console.log('11.19.0');", warning: "did not report" },
  { name: "times out", body: "setInterval(() => {}, 1000);", warning: "discovery timed out" },
])(
  "warns without starting an install when a shim $name",
  { timeout: 20_000 },
  async ({ body, warning }) => {
    const pidFile = fixture.local("discovery-pid.json");
    const result = await fixture.launcher(
      `#!${process.execPath}\nimport fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }));\n${body}\n`,
    );
    expect(result.stderr).toContain(warning);
    const discovery = JSON.parse(await read(pidFile)) as {
      pid: number;
      args: string[];
    };
    expect(discovery.args).toEqual(["--version"]);
    expect(() => process.kill(discovery.pid, 0)).toThrow();
    await expectAbsent(fixture.callsPath);
    await expectAbsent(fixture.nativeRoot);
  },
);

it.each(["dependency", "node_modules"])(
  "does not repair through a symlinked %s owner",
  async (owner) => {
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
    const result = await fixture.run();
    expect(result.stderr).toContain("native support is unavailable");
    expect(await fs.readdir(externalRoot)).toEqual(before);
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
    await write(path.join(fixture.nativeRoot, "package.json"), {
      ...nativeManifest,
      main,
    });
    await write(path.join(fixture.nativeRoot, main), code);
    const result = await fixture.run();
    expect(result.stderr).toContain("could not be loaded or used");
    await expectAbsent(fixture.callsPath);
    expect(await read(path.join(fixture.nativeRoot, main))).toBe(code);
  },
);
