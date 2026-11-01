import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { detectChangedScope } from "../../scripts/ci-changed-scope.mjs";
import { isDirectRunPath } from "../../scripts/lib/direct-run.mjs";
import * as managedChild from "../../scripts/lib/managed-child-process.mts";
import { scriptModuleEntrypoints } from "../../scripts/script-module-runtime.test-support.mjs";
import { resolveRuntimeWorkerUrl } from "../../src/infra/runtime-worker-url.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { isProcessAlive } from "../helpers/process-wait.js";
import { withinTest } from "../helpers/promise.js";
import type { runNodeScript } from "../helpers/run-node-script.js";
import {
  formatShimResult,
  TSX_SHIM_WRAPPERS,
  withShimFixture,
  writeEsmPluginFixture,
} from "./direct-run-entrypoints.test-support.js";
import {
  preparedScriptWrapperEnv,
  testRunnerFixtureEnv,
} from "./prepared-script-wrapper.test-support.js";
import { fixtureReadyBeforeSettlement } from "./run-process.test-support.js";

const installedModulesDir = path.dirname(
  path.dirname(createRequire(import.meta.url).resolve("tsx/package.json")),
);
const jsonLines = (output: string): unknown[] =>
  output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
function shimEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...testRunnerFixtureEnv(),
    PNPM_CONFIG_MODULES_DIR: installedModulesDir,
    ...overrides,
  };
  delete env.NODE_OPTIONS;
  return env;
}
function expectExit(result: Awaited<ReturnType<typeof runNodeScript>>, code: number) {
  const details = formatShimResult(result);
  expect(result.error, details).toBeUndefined();
  expect(result.status, details).toBe(code);
}

let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts?.close();
});

async function implementationReadyBeforeSettlement(
  pidPath: string,
  operation: PromiseLike<unknown>,
): Promise<number> {
  // Require the published PID record before reading it for termination.
  const recorded = () => existsSync(pidPath) && readFileSync(pidPath, "utf8").trim() !== "";
  await fixtureReadyBeforeSettlement(receipts, pidPath, operation, recorded);
  return Number.parseInt(readFileSync(pidPath, "utf8"), 10);
}

function writeTsxFixture(modulesDir: string, marker: string) {
  const packageDir = path.join(modulesDir, "tsx");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: "tsx", type: "module", exports: { "./esm": "./loader.mjs" } }),
  );
  writeFileSync(
    path.join(packageDir, "loader.mjs"),
    `process.env.OPENCLAW_TSX_FIXTURE_LOADER = ${JSON.stringify(marker)};\n`,
  );
  const dependencyDir = path.join(modulesDir, "shim-dependency");
  mkdirSync(dependencyDir, { recursive: true });
  writeFileSync(
    path.join(dependencyDir, "package.json"),
    JSON.stringify({ name: "shim-dependency", type: "module", exports: "./index.js" }),
  );
  writeFileSync(path.join(dependencyDir, "index.js"), 'export const value = "loaded";\n');
}

describe("script direct-run entrypoints", () => {
  it
    .skipIf(process.platform === "win32")
    .for(["scripts/run-vitest.mjs", "scripts/check-changed.mjs"] as const)(
    "lets %s finish implementation cleanup beyond the shim force-kill window",
    async (wrapper, { signal }) => {
      await withShimFixture(wrapper, async (fixture) => {
        const { checkoutRoot, fixtureRoot, implementationPath, wrapperPath, runNode } = fixture;
        const ownerPath = path.join(fixtureRoot, "owner.pid");
        const settledPath = path.join(fixtureRoot, "cleanup-settled");
        const clockPath = path.join(fixtureRoot, "supervisor-clock.mjs");
        // Scale both owners equally: a competing 5s or 10s cutoff must still fail.
        // Readiness and the test harness retain real time.
        writeFileSync(
          clockPath,
          `const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) =>
  realSetTimeout(callback, delay / 20, ...args);\n`,
        );
        writeTsxFixture(path.join(checkoutRoot, "node_modules"), "checkout");
        writeFileSync(
          implementationPath,
          `import fs from "node:fs";
${fixtureReceiptClientSource(receipts.endpoint)}
const keepAlive = setInterval(() => {}, 1000);
process.once("SIGTERM", () => {
  setTimeout(() => {
    fs.writeFileSync(${JSON.stringify(settledPath)}, "settled");
    clearInterval(keepAlive);
    process.exitCode = 143;
  }, 11000);
});
fs.writeFileSync(${JSON.stringify(ownerPath)}, String(process.ppid));
sendReceipt(${JSON.stringify(ownerPath)}, "ready");
`,
        );
        const completion = runNode(
          [wrapperPath],
          {
            ...testRunnerFixtureEnv(),
            NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(clockPath).href}`]
              .filter(Boolean)
              .join(" "),
          },
          fixtureRoot,
        );
        const owner = await withinTest(
          implementationReadyBeforeSettlement(ownerPath, completion),
          signal,
        );
        process.kill(owner, "SIGTERM");
        const result = await completion;
        expect(result.status, formatShimResult(result)).toBe(143);
        expect(readFileSync(settledPath, "utf8")).toBe("settled");
        expect(isProcessAlive(owner)).toBe(false);
      });
    },
  );

  it("loads compiled ESM through require from the wrapper with import-only dependencies", async () => {
    await withShimFixture(TSX_SHIM_WRAPPERS[0], async (fixture) => {
      const { fixtureRoot, implementationPath, wrapperPath, runNode } = fixture;
      writeFileSync(implementationPath, writeEsmPluginFixture(fixtureRoot));
      const result = await runNode([wrapperPath], shimEnv(), process.cwd());
      expectExit(result, 0);
      expect(JSON.parse(result.stdout)).toEqual({
        value: "import-only",
        evaluations: 1,
        transformed: "transformed",
        sourceAlias: true,
      });
    });
  });

  it.each([false, true])(
    "preserves preloads when forking into another cwd (equals=%s)",
    async (equals) => {
      await withShimFixture(TSX_SHIM_WRAPPERS[0], async (fixture) => {
        const { checkoutRoot, fixtureRoot, implementationPath, runNode } = fixture;
        const forkCwd = path.join(fixtureRoot, "child cwd");
        mkdirSync(forkCwd);
        const childPath = path.join(fixtureRoot, "fork-child.mts");
        const extraPreloadPath = path.join(fixtureRoot, "extra-preload.mjs");
        writeFileSync(extraPreloadPath, 'globalThis.fixturePreload = "preserved";\n');
        const snapshotSource = `
enum Transformed { Value = "transformed" }
console.log(JSON.stringify({ transformed: Transformed.Value, preload: globalThis.fixturePreload,
  args: process.argv.slice(2), cwd: process.cwd(), execArgv: process.execArgv }));
`;
        writeFileSync(childPath, `${snapshotSource}\nprocess.exitCode = 17;\n`);
        writeFileSync(
          implementationPath,
          `${snapshotSource}
import { fork } from "node:child_process";
const child = fork(${JSON.stringify(childPath)}, process.argv.slice(2), {
  cwd: ${JSON.stringify(forkCwd)}, stdio: "inherit",
});
process.exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", code => resolve(code ?? 1));
});
`,
        );
        const nodeFlags = ["--no-warnings", "--import", pathToFileURL(extraPreloadPath).href];
        const trailingFlags = ["--title", "./scripts/tsx.mjs", "--import=node:fs"];
        const preload = equals ? ["--import=./scripts/tsx.mjs"] : ["--import", "./scripts/tsx.mjs"];
        const bootstrapUrl = pathToFileURL(path.join(checkoutRoot, "scripts/tsx.mjs")).href;
        const expectedPreload = equals ? [`--import=${bootstrapUrl}`] : ["--import", bootstrapUrl];
        const env = shimEnv({
          TMPDIR: fixtureRoot,
          TMP: fixtureRoot,
          TEMP: fixtureRoot,
        });
        delete env.TSX_DISABLE_CACHE;
        const result = await runNode(
          [
            ...nodeFlags,
            ...preload,
            ...trailingFlags,
            implementationPath,
            "argument with spaces",
            "--fork-proof",
          ],
          env,
          checkoutRoot,
        );
        expectExit(result, 17);
        expect(jsonLines(result.stdout)).toEqual(
          [checkoutRoot, forkCwd].map((cwd) => ({
            transformed: "transformed",
            preload: "preserved",
            args: ["argument with spaces", "--fork-proof"],
            cwd,
            execArgv: [...nodeFlags, ...expectedPreload, ...trailingFlags],
          })),
        );
      });
    },
  );

  it("keeps root package preloads and raw tsx children off disk caches without changing other cache settings", async () => {
    await withShimFixture(TSX_SHIM_WRAPPERS[0], async (fixture) => {
      const { fixtureRoot, implementationPath, runNode } = fixture;
      const tempRoot = path.join(fixtureRoot, "temp");
      const cacheRoots = ["tsx", `tsx-${process.geteuid?.() ?? userInfo().username}`].map((name) =>
        path.join(tempRoot, name),
      );
      for (const cacheRoot of cacheRoots) {
        mkdirSync(cacheRoot, { recursive: true });
        writeFileSync(path.join(cacheRoot, "0-sentinel"), "keep");
      }
      const accessLog = path.join(fixtureRoot, "cache-access.log");
      const guard = path.join(fixtureRoot, "cache-guard.cjs");
      writeFileSync(
        guard,
        `
const fs = require("node:fs");
const path = require("node:path");
const readdirSync = fs.readdirSync;
fs.readdirSync = function (directory, ...args) {
  if (/^tsx(?:-|$)/.test(path.basename(String(directory)))) {
    fs.appendFileSync(${JSON.stringify(accessLog)}, "cache scan\\n");
    throw new Error("Unexpected tsx disk cache access");
  }
  return readdirSync.call(this, directory, ...args);
};
`,
      );
      const preservedEnv = Object.fromEntries(
        [
          "TMPDIR",
          "TMP",
          "TEMP",
          "XDG_CACHE_HOME",
          "NODE_COMPILE_CACHE",
          "OPENCLAW_VITEST_FS_MODULE_CACHE_PATH",
        ].map((key) => [
          key,
          key === "TMPDIR" || key === "TEMP" ? tempRoot : path.join(fixtureRoot, key),
        ]),
      );
      const childPath = path.join(fixtureRoot, "child.mts");
      const snapshotSource = `
enum Transformed { Value = "transformed" }
console.log(JSON.stringify({
  transformed: Transformed.Value,
  args: process.argv.slice(2),
  cwd: process.cwd(),
  env: Object.fromEntries(${JSON.stringify(Object.keys(preservedEnv))}.map(key => [key, process.env[key]])),
}));
`;
      writeFileSync(childPath, `${snapshotSource}\nprocess.exitCode = 17;\n`);
      writeFileSync(
        implementationPath,
        `${snapshotSource}
import { spawnSync } from "node:child_process";
const child = spawnSync(process.execPath, ["--import", "tsx", ${JSON.stringify(childPath)}, ...process.argv.slice(2)], { stdio: "inherit" });
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
`,
      );
      const { scripts } = JSON.parse(readFileSync("package.json", "utf8")) as {
        scripts: Record<string, string>;
      };
      const preloads = [
        ...new Set(
          Object.values(scripts).flatMap((command) =>
            [...command.matchAll(/--import(?:=|\s+)(\S+)/gu)].map((match) => match[1]!),
          ),
        ),
      ];
      expect(preloads.length).toBeGreaterThan(0);
      const launches = preloads.map((preload) => ["--import", preload, implementationPath]);
      for (const cacheFlag of [undefined, ""]) {
        const env: NodeJS.ProcessEnv = {
          ...testRunnerFixtureEnv(),
          ...preservedEnv,
          PNPM_CONFIG_MODULES_DIR: installedModulesDir,
          NODE_OPTIONS: `--require ${JSON.stringify(guard)}`,
        };
        delete env.TSX_DISABLE_CACHE;
        if (cacheFlag !== undefined) {
          env.TSX_DISABLE_CACHE = cacheFlag;
        }
        for (const launch of launches) {
          const result = await runNode(
            [...launch, "argument with spaces", "--proof"],
            env,
            process.cwd(),
          );
          expectExit(result, 17);
          expect(jsonLines(result.stdout)).toEqual(
            Array.from({ length: 2 }, () => ({
              transformed: "transformed",
              args: ["argument with spaces", "--proof"],
              cwd: process.cwd(),
              env: preservedEnv,
            })),
          );
        }
      }
      expect(existsSync(accessLog)).toBe(false);
      for (const cacheRoot of cacheRoots) {
        expect(readdirSync(cacheRoot)).toEqual(["0-sentinel"]);
        expect(readFileSync(path.join(cacheRoot, "0-sentinel"), "utf8")).toBe("keep");
      }
    });
  });

  it("runs scripts/verify-docker-attestations.mjs through its guarded CLI", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/verify-docker-attestations.mjs", "--help"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "Usage: node scripts/verify-docker-attestations.mjs",
    );
  });

  it("runs the checked-out Crabbox wrapper through its managed child", async () => {
    await withShimFixture("scripts/crabbox-wrapper.mjs", async ({ fixtureRoot, runNode }) => {
      const fixtureVersion = "999.0.0";
      const binDir = path.join(fixtureRoot, "fake bin");
      const home = path.join(fixtureRoot, "home");
      const state = path.join(fixtureRoot, "state");
      mkdirSync(binDir);
      mkdirSync(home);
      mkdirSync(state);
      // A failed version probe must fail before managed installation can download anything.
      writeFileSync(path.join(state, "tools"), "managed installation disabled for this fixture\n");
      const responses = {
        "--version": `crabbox ${fixtureVersion}`,
        "run --help": "provider: ssh\n  -provider string\n",
        "config show --json": JSON.stringify({ provider: "ssh" }),
      };
      writeFileSync(
        path.join(binDir, process.platform === "win32" ? "crabbox.cjs" : "crabbox"),
        String.raw`#!/usr/bin/env node
const args = process.argv.slice(2);
const response = ${JSON.stringify(responses)}[args.join(" ")];
if (response === undefined) throw new Error("Unexpected fixture command: " + JSON.stringify(args));
process.stdout.write(response + "\n");
`,
        { mode: 0o755 },
      );
      writeFileSync(
        path.join(binDir, "crabbox.cmd"),
        [
          "@echo off",
          `"${process.execPath}" "%~dp0crabbox.cjs" %*`,
          "exit /b %errorlevel%",
          "",
        ].join("\r\n"),
      );
      const env: NodeJS.ProcessEnv = {
        SystemRoot: process.env.SystemRoot,
        ComSpec: process.env.ComSpec,
        PATH: [binDir, path.dirname(process.execPath), process.env.PATH ?? ""].join(path.delimiter),
        HOME: home,
        USERPROFILE: home,
        APPDATA: path.join(home, "AppData", "Roaming"),
        LOCALAPPDATA: path.join(home, "AppData", "Local"),
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_STATE_HOME: path.join(home, "state"),
        OPENCLAW_STATE_DIR: state,
        TMPDIR: fixtureRoot,
        TMP: fixtureRoot,
        TEMP: fixtureRoot,
        CRABBOX_PROVIDER: "ssh",
        OPENCLAW_CRABBOX_WRAPPER_IGNORE_REPO_BINARY: "1",
      };
      // Preserve the real wrapper and Job lifecycle; compile its graph before the deadline.
      const result = await runNode(
        [path.resolve("scripts/crabbox-wrapper.mjs"), "--version"],
        preparedScriptWrapperEnv(
          [
            [
              new URL("../../scripts/crabbox-wrapper.mts", import.meta.url),
              resolveRuntimeWorkerUrl(scriptModuleEntrypoints.crabboxWrapper),
            ],
          ],
          env,
        ),
        process.cwd(),
      );
      expectExit(result, 0);
      expect(result.stdout).toBe(`crabbox ${fixtureVersion}\n`);
      expect(readdirSync(state)).toEqual(["tools"]);
    });
  });

  it("boots scripts/e2e/kitchen-sink-rpc-walk.mjs from a relative PNPM_CONFIG_MODULES_DIR", async () => {
    await withShimFixture(TSX_SHIM_WRAPPERS[1], async (fixture) => {
      const { checkoutRoot, fixtureRoot, implementationPath, wrapperPath, runNode } = fixture;
      const nodeArgs = ["--no-maglev", "--maglev", "--no-concurrent-sparkplug"];
      writeFileSync(
        implementationPath,
        'import { value } from "shim-dependency";\nprocess.stdout.write(JSON.stringify({ loader: process.env.OPENCLAW_TSX_FIXTURE_LOADER, dependency: value, args: process.argv.slice(2), execArgv: process.execArgv }));\n',
      );
      writeTsxFixture(path.join(checkoutRoot, "node_modules"), "checkout");
      const modulesDir = path.join(fixtureRoot, "hydrated-modules");
      writeTsxFixture(modulesDir, "hydrated");
      const env = shimEnv({ PNPM_CONFIG_MODULES_DIR: path.relative(checkoutRoot, modulesDir) });
      delete env.NODE_PATH;
      delete env.npm_config_modules_dir;
      const result = await runNode(
        [...nodeArgs, wrapperPath, "--hydrated-proof", "--no-maglev"],
        env,
        fixtureRoot,
      );
      expectExit(result, 0);
      expect(JSON.parse(result.stdout)).toEqual({
        loader: "hydrated",
        dependency: "loaded",
        args: ["--hydrated-proof", "--no-maglev"],
        execArgv: ["--import", expect.stringMatching(/^file:.*\/scripts\/tsx\.mjs$/u), ...nodeArgs],
      });
    });
  });

  it("matches Windows drive paths case-insensitively", () => {
    expect(
      isDirectRunPath(
        "C:\\repo\\scripts\\android-app-i18n.ts",
        "c:\\repo\\scripts\\android-app-i18n.ts",
        "win32",
      ),
    ).toBe(true);
  });

  it.each(["scripts/verify-docker-attestations.mjs"])(
    "routes %s through Windows CI",
    (changedPath) => {
      expect(detectChangedScope([changedPath]).runWindows).toBe(true);
    },
  );
});

it("retains fixture evidence when command cleanup is unconfirmed", async () => {
  // Fault injection is limited to the receipt: real OS cleanup failure is unsafe to force.
  const failure = Object.assign(new Error("child cleanup unverified"), {
    code: "EPROCESSGROUP_CLEANUP_FAILED",
    processTreeState: "indeterminate",
  });
  const runManaged = managedChild.runManagedCommand;
  const spy = vi
    .spyOn(managedChild, "runManagedCommand")
    .mockImplementationOnce(async (options) => {
      await runManaged(options);
      throw failure;
    });
  let root = "";
  try {
    const error = await withShimFixture(TSX_SHIM_WRAPPERS[0], async ({ fixtureRoot, runNode }) => {
      root = fixtureRoot;
      writeFileSync(path.join(root, "evidence"), "keep");
      await runNode(
        ["-e", 'process.stdout.write("retained stdout"); process.stderr.write("retained stderr");'],
        testRunnerFixtureEnv(),
        root,
      );
    }).catch((cause: unknown) => cause);
    expect(existsSync(root), "unverified writers still own the fixture").toBe(true);
    expect(readFileSync(path.join(root, "evidence"), "utf8")).toBe("keep");
    expect(error).toMatchObject({ message: expect.stringContaining(root), cause: failure });
    const output = readFileSync(path.join(root, "command-output.log"), "utf8");
    expect(output).toContain("retained stdout");
    expect(output).toContain("retained stderr");
    expect(output).toContain("EPROCESSGROUP_CLEANUP_FAILED");
  } finally {
    spy.mockRestore();
    // The real command has joined; only the injected receipt prevents removal.
    rmSync(root, { recursive: true, force: true });
  }
});

it("joins commands before deleting a rejected fixture", async () => {
  const failure = new Error("fixture callback rejected while the command was running");
  let root = "";
  let command: ReturnType<typeof runNodeScript> | undefined;
  await expect(
    withShimFixture(TSX_SHIM_WRAPPERS[0], ({ fixtureRoot, runNode }) => {
      root = fixtureRoot;
      command = runNode(
        ["-e", 'process.stdout.write("completed");'],
        testRunnerFixtureEnv(),
        root,
      ).then((result) => {
        expect(existsSync(root), "command teardown still owns its fixture").toBe(true);
        return result;
      });
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(command).toBeDefined();
  const result = await command!;
  expectExit(result, 0);
  expect(result.stdout).toBe("completed");
  expect(existsSync(root)).toBe(false);
});
