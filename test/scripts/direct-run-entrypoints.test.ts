import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { setTimeout as waitForProcessTick } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { detectChangedScope } from "../../scripts/ci-changed-scope.mjs";
import { isDirectRunPath } from "../../scripts/lib/direct-run.mjs";
import * as managedChild from "../../scripts/lib/managed-child-process.mts";
import { scriptModuleEntrypoints } from "../../scripts/script-module-runtime.test-support.mjs";
import { resolveRuntimeWorkerUrl } from "../../src/infra/runtime-worker-url.js";
import { readWindowsProcessStartTimeSync } from "../../src/infra/windows-process-start.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { isProcessAlive } from "../helpers/process-wait.js";
import { withinTest } from "../helpers/promise.js";
import { runQaGatewayFixture } from "../helpers/qa-gateway-cleanup.js";
import type { runNodeScript } from "../helpers/run-node-script.js";
import {
  formatShimResult,
  TSX_SHIM_WRAPPERS,
  withShimFixture,
  writeEsmPluginFixture,
} from "./direct-run-entrypoints.test-support.js";
import { preparedScriptWrapperEnv } from "./prepared-script-wrapper.test-support.js";

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
  // The PID record precedes the receipt; command output and exit use different pipes.
  const recorded = () => existsSync(pidPath) && readFileSync(pidPath, "utf8").trim() !== "";
  const settled = Promise.resolve(operation).then(
    () => {
      if (!recorded()) {
        throw new Error(`timeout waiting for pid in ${pidPath}`);
      }
    },
    (error: unknown) => {
      if (!recorded()) {
        throw error;
      }
    },
  );
  await Promise.race([receipts.waitFor(pidPath, "ready"), settled]);
  return Number.parseInt(readFileSync(pidPath, "utf8"), 10);
}

// Recovery owns only foreign PIDs, so it has no ChildProcess exit handle to join.
async function waitForExtinction(pid: number, signal: AbortSignal): Promise<void> {
  try {
    while (isProcessAlive(pid)) {
      await waitForProcessTick(10, undefined, { signal });
    }
  } catch (error) {
    throw new Error(`process still alive: ${pid}`, { cause: error });
  }
}

type ModulesEnv = Partial<Record<"PNPM_CONFIG_MODULES_DIR" | "npm_config_modules_dir", string>>;

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

function runShimFixture(
  wrapper: (typeof TSX_SHIM_WRAPPERS)[number],
  configureModules: (paths: {
    checkoutRoot: string;
    fixtureRoot: string;
  }) => ModulesEnv = () => ({}),
  nodeArgs: readonly string[] = [],
) {
  return withShimFixture(
    wrapper,
    ({ checkoutRoot, fixtureRoot, implementationPath, wrapperPath, runNode }) => {
      writeFileSync(
        implementationPath,
        'import { value } from "shim-dependency";\nprocess.stdout.write(JSON.stringify({ loader: process.env.OPENCLAW_TSX_FIXTURE_LOADER, dependency: value, args: process.argv.slice(2), execArgv: process.execArgv }));\n',
      );
      writeTsxFixture(path.join(checkoutRoot, "node_modules"), "checkout");
      const modulesEnv = configureModules({ checkoutRoot, fixtureRoot });

      const env = { ...process.env };
      delete env.NODE_OPTIONS;
      delete env.NODE_PATH;
      delete env.PNPM_CONFIG_MODULES_DIR;
      delete env.npm_config_modules_dir;
      Object.assign(env, modulesEnv);
      return runNode(
        [...nodeArgs, wrapperPath, "--hydrated-proof", "--no-maglev"],
        env,
        fixtureRoot,
      );
    },
  );
}

function expectShimLoader(
  result: Awaited<ReturnType<typeof runShimFixture>>,
  loader: string,
  nodeArgs: readonly string[] = [],
) {
  expect(result.error, formatShimResult(result)).toBeUndefined();
  expect(result.status, formatShimResult(result)).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    loader,
    dependency: "loaded",
    args: ["--hydrated-proof", "--no-maglev"],
    execArgv: ["--import", expect.stringMatching(/^file:.*\/scripts\/tsx\.mjs$/u), ...nodeArgs],
  });
}

describe("script direct-run entrypoints", () => {
  it
    .skipIf(process.platform === "win32")
    .for([
      "scripts/run-vitest.mjs",
      "scripts/check-changed.mjs",
      "scripts/run-tsgo.mjs",
      "scripts/run-oxlint.mjs",
      "scripts/run-tsgo-core-test-shards.mjs",
    ] as const)(
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
            ...process.env,
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
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PNPM_CONFIG_MODULES_DIR: path.dirname(
          path.dirname(createRequire(import.meta.url).resolve("tsx/package.json")),
        ),
      };
      delete env.NODE_OPTIONS;
      const result = await runNode([wrapperPath], env, process.cwd());
      expect(result.error, formatShimResult(result)).toBeUndefined();
      expect(result.status, formatShimResult(result)).toBe(0);
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
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          TMPDIR: fixtureRoot,
          TMP: fixtureRoot,
          TEMP: fixtureRoot,
          PNPM_CONFIG_MODULES_DIR: path.dirname(
            path.dirname(createRequire(import.meta.url).resolve("tsx/package.json")),
          ),
        };
        delete env.TSX_DISABLE_CACHE;
        delete env.NODE_OPTIONS;
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
        expect(result.error, formatShimResult(result)).toBeUndefined();
        expect(result.status, formatShimResult(result)).toBe(17);
        expect(
          result.stdout
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        ).toEqual(
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
      const require = createRequire(import.meta.url);
      const modulesDir = path.dirname(path.dirname(require.resolve("tsx/package.json")));
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
          ...process.env,
          ...preservedEnv,
          PNPM_CONFIG_MODULES_DIR: modulesDir,
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
          expect(result.error, formatShimResult(result)).toBeUndefined();
          expect(result.status, formatShimResult(result)).toBe(17);
          expect(
            result.stdout
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line)),
          ).toEqual(
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
      const invocationLog = path.join(fixtureRoot, "invocations.jsonl");
      mkdirSync(binDir);
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
const fs = require("node:fs");
const args = process.argv.slice(2);
const record = (stage, details = {}) => fs.appendFileSync(${JSON.stringify(invocationLog)}, JSON.stringify({ stage, args, pid: process.pid, atMs: Date.now(), ...details }) + "\n");
record("entered");
const { readWindowsProcessStartTimeSync } = require(${JSON.stringify(path.resolve("src/infra/windows-process-start.ts"))});
record("identity-module-loaded");
record("identity-read", { startTimeMs: readWindowsProcessStartTimeSync(process.pid, 0) });
const response = ${JSON.stringify(responses)}[args.join(" ")];
if (response === undefined) throw new Error("Unexpected fixture command: " + JSON.stringify(args));
process.stdout.write(response + "\n");
record("stdout-write-returned");
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
      // Read before asserting: joined timeout cleanup removes the fixture even on failure.
      // A returned stdout write records progress, not completed pipe drainage.
      const trace = existsSync(invocationLog) ? readFileSync(invocationLog, "utf8") : "";
      const details = `${formatShimResult(result)}\nfixture stages:\n${trace || "no invocation recorded"}`;
      expect(result.error, details).toBeUndefined();
      expect(result.status, details).toBe(0);
      expect(result.stdout, details).toBe(`crabbox ${fixtureVersion}\n`);
      const invocations = trace
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              stage: string;
              args: string[];
              pid: number;
              startTimeMs?: number | null;
            },
        )
        .filter(({ stage }) => stage === "identity-read");
      expect(invocations.map(({ args }) => args)).toEqual([
        ["--version"],
        ["run", "--help"],
        ["config", "show", "--json"],
        ["--version"],
      ]);
      for (const invocation of invocations) {
        if (process.platform === "win32") {
          expect(
            Number.isSafeInteger(invocation.startTimeMs) && (invocation.startTimeMs ?? 0) > 0,
            `${JSON.stringify(invocation)}\n${details}`,
          ).toBe(true);
        }
        // Windows may reuse an exited probe's PID before the remaining probes finish.
        // An unreadable identity for a live PID still cannot prove child cleanup.
        const observedStartTimeMs = readWindowsProcessStartTimeSync(invocation.pid, 0);
        const alive = isProcessAlive(invocation.pid);
        expect(
          alive &&
            (process.platform !== "win32" ||
              observedStartTimeMs === null ||
              observedStartTimeMs === invocation.startTimeMs),
          alive
            ? `${JSON.stringify({
                invocation,
                observedStartTimeMs,
                invocations,
              })}\n${formatShimResult(result)}`
            : undefined,
        ).toBe(false);
      }
      expect(readdirSync(state)).toEqual(["tools"]);
    });
  });

  it("boots scripts/e2e/kitchen-sink-rpc-walk.mjs from a relative PNPM_CONFIG_MODULES_DIR", async () => {
    const nodeArgs = ["--no-maglev", "--maglev", "--no-concurrent-sparkplug"];
    const result = await runShimFixture(
      TSX_SHIM_WRAPPERS[2],
      ({ checkoutRoot, fixtureRoot }) => {
        const modulesDir = path.join(fixtureRoot, "hydrated-modules");
        writeTsxFixture(modulesDir, "hydrated");
        return { PNPM_CONFIG_MODULES_DIR: path.relative(checkoutRoot, modulesDir) };
      },
      nodeArgs,
    );
    expectShimLoader(result, "hydrated", nodeArgs);
  });

  it("requires explicit hydration to bootstrap from primary without local modules", async () => {
    const result = await runShimFixture(TSX_SHIM_WRAPPERS[0], ({ checkoutRoot, fixtureRoot }) => {
      rmSync(path.join(checkoutRoot, "node_modules"), { recursive: true });
      const primaryRoot = path.join(fixtureRoot, "primary");
      const modulesDir = path.join(primaryRoot, "node_modules");
      writeTsxFixture(modulesDir, "primary");
      const initialized = spawnSync(
        "git",
        ["init", "--quiet", "--separate-git-dir", path.join(primaryRoot, ".git"), checkoutRoot],
        { encoding: "utf8" },
      );
      expect(initialized.status, initialized.stderr).toBe(0);
      return {};
    });
    expect(result.error, formatShimResult(result)).toBeUndefined();
    expect(result.status, formatShimResult(result)).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "Run pnpm install --frozen-lockfile in an independently owned checkout.",
    );
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

  it.each(["scripts/android-app-i18n.ts", "scripts/generate-bundled-channel-config-metadata.ts"])(
    "uses the canonical guard in %s",
    (script) => {
      const source = readFileSync(script, "utf8");

      expect(
        source.match(/isDirectRunUrl\(process\.argv\[1\], import\.meta\.url\)/gu),
      ).toHaveLength(1);
    },
  );

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
        process.env,
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

it("joins owned descendants and captures timeout output before deleting a rejected fixture", async ({
  signal,
}) => {
  const evidence = mkdtempSync(path.join(tmpdir(), "openclaw-shim-owned-pids-"));
  const pidPaths = ["wrapper", "implementation", "descendant"].map((role) =>
    path.join(evidence, `${role}.pid`),
  );
  const wrapperPidProbe = path.join(evidence, "wrapper-pid.mjs");
  writeFileSync(
    wrapperPidProbe,
    `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(pidPaths[0])}, String(process.pid));`,
  );
  const failure = new Error("fixture callback rejected while the command was running");
  let root = "";
  let fixturePresentAtCommandSettlement: boolean | undefined;
  let command: ReturnType<typeof runNodeScript> | undefined;
  await runQaGatewayFixture(
    async () => {
      const error = await withShimFixture(TSX_SHIM_WRAPPERS[0], async (fixture) => {
        const { fixtureRoot, implementationPath, wrapperPath, runNode } = fixture;
        root = fixtureRoot;
        const descendant = `
const fs = require("node:fs");
const timer = setInterval(() => {}, 1000);
process.on("SIGTERM", () => {
  fs.writeFileSync(${JSON.stringify(path.join(evidence, "shutdown-root-present"))}, String(fs.existsSync(${JSON.stringify(root)})));
  process.stdout.write("shutdown stdout\\n");
  process.stderr.write("shutdown stderr\\n");
  clearInterval(timer);
});
fs.writeFileSync(${JSON.stringify(pidPaths[2])}, String(process.pid));
process.stdout.write("descendant stdout\\n");
process.stderr.write("descendant stderr\\n");
process.send("ready");
process.disconnect();
`;
        writeFileSync(
          implementationPath,
          `
import fs from "node:fs";
import { spawn } from "node:child_process";
${fixtureReceiptClientSource(receipts.endpoint)}
enum Transformed { Value = "transformed" }
console.log(Transformed.Value);
const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
child.once("message", () => {
  fs.writeFileSync(${JSON.stringify(pidPaths[1])}, String(process.pid));
  sendReceipt(${JSON.stringify(pidPaths[1])}, "ready");
});
`,
        );
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          PNPM_CONFIG_MODULES_DIR: path.dirname(
            path.dirname(createRequire(import.meta.url).resolve("tsx/package.json")),
          ),
        };
        delete env.NODE_OPTIONS;
        command = runNode(
          ["--import", pathToFileURL(wrapperPidProbe).href, wrapperPath],
          env,
          fixtureRoot,
        ).then((result) => {
          fixturePresentAtCommandSettlement = existsSync(fixtureRoot);
          return result;
        });
        const implementationPid = await withinTest(
          implementationReadyBeforeSettlement(pidPaths[1]!, command),
          signal,
        );
        expect(isProcessAlive(implementationPid)).toBe(true);
        throw failure;
      }).catch((cause: unknown) => cause);
      expect(error).toBe(failure);
      expect(command).toBeDefined();
      const result = await command!;
      expect(result.error, formatShimResult(result)).toMatchObject({
        code: "ETIMEDOUT",
        message: "Managed command timed out after 10000ms",
      });
      expect(result.status).toBeNull();
      expect(fixturePresentAtCommandSettlement, "command teardown still owns its fixture").toBe(
        true,
      );
      expect(result.stdout).toContain("transformed");
      expect(result.stdout).toContain("descendant stdout");
      expect(result.stderr).toContain("descendant stderr");
      for (const pidPath of pidPaths) {
        expect(isProcessAlive(Number(readFileSync(pidPath, "utf8"))), pidPath).toBe(false);
      }
      if (process.platform !== "win32") {
        expect(readFileSync(path.join(evidence, "shutdown-root-present"), "utf8")).toBe("true");
        expect(result.stdout).toContain("shutdown stdout");
        expect(result.stderr).toContain("shutdown stderr");
      }
      expect(existsSync(root)).toBe(false);
    },
    async () => {
      await command;
    },
    ...pidPaths.toReversed().map((pidPath) => async () => {
      // Independent recovery also runs after a failed assertion; never rely on the fixture under test.
      if (existsSync(pidPath)) {
        const pid = Number(readFileSync(pidPath, "utf8"));
        if (isProcessAlive(pid)) {
          managedChild.terminateManagedChild(
            { pid, kill: (killSignal) => process.kill(pid, killSignal) },
            "SIGKILL",
            { useProcessGroup: false },
          );
        }
        await waitForExtinction(pid, signal);
      }
    }),
    () => {
      if (
        pidPaths.some(
          (pidPath) => existsSync(pidPath) && isProcessAlive(Number(readFileSync(pidPath, "utf8"))),
        )
      ) {
        throw new Error(`Owned proof children remain; retained PID evidence ${evidence}`);
      }
      rmSync(evidence, { recursive: true, force: true });
    },
  );
});
