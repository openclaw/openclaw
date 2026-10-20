import { mkdir, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import {
  filterOpenClawChildExecArgv,
  resolveCurrentOpenClawCliInvocation,
} from "./openclaw-cli-invocation.js";

const requireFromHere = createRequire(import.meta.url);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repoRoot = process.cwd();
const repoSourceEntry = path.join(repoRoot, "src", "entry.ts");
const trustedTsxLoader = pathToFileURL(requireFromHere.resolve("tsx", { paths: [repoRoot] })).href;
const sourceEnv = { TSX_TSCONFIG_PATH: path.join(repoRoot, "tsconfig.json") };
const commandArgs = ["sessions", "export-trajectory"];
type Invocation = ReturnType<typeof resolveCurrentOpenClawCliInvocation>;
type Options = Parameters<typeof resolveCurrentOpenClawCliInvocation>[1];
const invoke = (options: Options) =>
  resolveCurrentOpenClawCliInvocation(commandArgs, {
    cwd: repoRoot,
    execPath: "/usr/bin/node",
    ...options,
  });
function expectInvocation(options: Options, expected: Partial<Invocation>) {
  expect(invoke(options)).toEqual({ command: "/usr/bin/node", cwd: repoRoot, ...expected });
}
const writePackage = (root: string) =>
  writeFile(path.join(root, "package.json"), '{"name":"openclaw"}');

it.each(["sidecar", "foreign checkout"])(
  "uses the standalone sidecar from a %s cwd",
  async (cwdKind) => {
    const root = tempDirs.make("openclaw-cli-standalone-");
    const packageRoot = path.join(root, "runtime");
    await mkdir(packageRoot);
    const execPath = path.join(root, "openclaw");
    await writeFile(
      path.join(root, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        mode: "aot",
        executable: { path: "openclaw" },
        runtime: { path: "runtime" },
        openclaw: { version: "2026.10.15" },
        bun: { version: "1.3.0" },
      }),
    );
    expectInvocation(
      {
        execPath,
        argv1:
          cwdKind === "sidecar" ? path.join(packageRoot, "openclaw.mjs") : "/$bunfs/root/cli.js",
        execArgv: ["--trace-warnings"],
        cwd: cwdKind === "sidecar" ? root : repoRoot,
      },
      { command: execPath, args: commandArgs, cwd: packageRoot },
    );
  },
);

it("keeps child runtime flags without inheriting debugger ownership", () => {
  expect(
    filterOpenClawChildExecArgv([
      "--import",
      "/loader.mjs",
      "--inspect",
      "127.0.0.1:9231",
      "--inspect-brk=0",
      "--inspect-wait=0",
      "--inspect-port",
      "9230",
      "--inspect-port=9232",
      "--trace-warnings",
    ]),
  ).toEqual(["--import", "/loader.mjs", "--trace-warnings"]);
});

it.each([false, true])("pins TSX imports and preserves other hooks (equals=%s)", (equals) => {
  const runtimeArgs = ["--trace-warnings", "--import", "/other-loader.mjs"];
  const invocation = invoke({
    argv1: repoSourceEntry,
    execArgv: [...runtimeArgs, ...(equals ? ["--import=tsx"] : ["--import", "tsx"])],
    execPath: resolveTestNodeExecPath(),
  });
  expect(invocation.args).toEqual([
    ...runtimeArgs,
    ...(equals ? [`--import=${trustedTsxLoader}`] : ["--import", trustedTsxLoader]),
    repoSourceEntry,
    ...commandArgs,
  ]);
});

it("uses the source entry directly under Bun", () => {
  expectInvocation(
    {
      argv1: path.join(repoRoot, "scripts", "test-live.mts"),
      execPath: "/usr/local/bin/bun",
    },
    { command: "/usr/local/bin/bun", args: ["--no-install", repoSourceEntry, ...commandArgs] },
  );
});

it.each(["openclaw.mjs", path.join("dist", "index.js")])(
  "pins a prepared %s invocation across an installation switch",
  async (entryName) => {
    const root = tempDirs.make("openclaw-cli-release-switch-");
    const releaseA = path.join(root, "release-a");
    const releaseB = path.join(root, "release-b");
    for (const release of [releaseA, releaseB]) {
      await mkdir(path.join(release, "dist"), { recursive: true });
      await writePackage(release);
      await writeFile(path.join(release, entryName), "export {};\n");
    }
    const current = path.join(root, "current");
    await symlink(releaseA, current, "junction");
    const options = {
      argv1: path.join(current, entryName),
      cwd: root,
      execPath: resolveTestNodeExecPath(),
      execArgv: [],
    };
    const prepared = resolveCurrentOpenClawCliInvocation(["--version"], options);

    await unlink(current);
    await symlink(releaseB, current, "junction");

    const expectRelease = async (invocation: Invocation, release: string) => {
      const entry = await realpath(expectDefined(invocation.args[0], "CLI entry"));
      expect([entry, invocation.cwd]).toEqual([path.join(release, entryName), release]);
    };
    await expectRelease(prepared, releaseA);
    const fresh = resolveCurrentOpenClawCliInvocation(["--version"], options);
    await expectRelease(fresh, releaseB);
  },
);

it("uses the installed wrapper under Node and canonical package cwd", async () => {
  const packageRoot = tempDirs.make("openclaw-cli-invocation-");
  await writePackage(packageRoot);
  const moduleUrl = pathToFileURL(path.join(packageRoot, "dist", "tui", "index.js")).href;
  expectInvocation(
    {
      argv1: path.join(packageRoot, "bin", "host.mjs"),
      cwd: path.join(packageRoot, "state"),
      moduleUrl,
    },
    {
      args: [path.join(packageRoot, "openclaw.mjs"), ...commandArgs],
      cwd: packageRoot,
    },
  );
});

it("does not preserve a foreign package entry", () => {
  expectInvocation(
    { argv1: "/app/dist/index.js" },
    {
      args: ["--import", trustedTsxLoader, repoSourceEntry, ...commandArgs],
      env: sourceEnv,
    },
  );
});
