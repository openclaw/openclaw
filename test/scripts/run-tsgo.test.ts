import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  resolveRepoToolBinPath,
  resolveTypeCheckTool,
} from "../../scripts/lib/local-check-runtime.mts";
import {
  createSparseTsgoSkipEnv,
  getSparseTsgoGuardError,
  shouldSkipSparseTsgoGuardError,
} from "../../scripts/lib/tsgo-sparse-guard.mts";
import { prepareTsgoCommand, resolveTsgoTimeoutMs } from "../../scripts/run-tsgo.mts";
import { createBoundedChildOutput } from "../helpers/bounded-child-output.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { isProcessAlive, waitForDead } from "../helpers/process-wait.js";
import { withinTest } from "../helpers/promise.js";
import { createTempDirTracker } from "../helpers/temp-dir.js";
import {
  overrideNativeFixtureExecutable,
  writeNativeFixtureFile as write,
} from "./native-boundary-fixture.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const fixture = createFixtureLifetime();
afterEach(async () => {
  vi.unstubAllEnvs();
  await fixture.cleanup();
});

function sparseGuard(
  options: Parameters<typeof getSparseTsgoGuardError>[1] = {},
  args = ["-p", "test/tsconfig/tsconfig.core.test.json"],
) {
  return getSparseTsgoGuardError(args, {
    cwd: options?.cwd ?? createTempDir("openclaw-run-tsgo-"),
    isSparseCheckoutEnabled: () => true,
    ...options,
  });
}

it("selects the compiler from the supplied environment instead of the ambient environment", () => {
  vi.stubEnv("OPENCLAW_TYPECHECKER", "invalid-ambient-compiler");
  const command = prepareTsgoCommand(["--version"], {
    ...process.env,
    OPENCLAW_TYPECHECKER: "tsgo",
  });
  expect(command?.bin).toBe(resolveRepoToolBinPath("tsgo"));
});

it.each([false, true])(
  "keeps Go profiling requests on tsgo (environment=%s)",
  (fromEnvironment) => {
    const args = fromEnvironment ? ["--version"] : ["--version", "--pprofDir", "profiles"];
    const command = prepareTsgoCommand(args, {
      ...process.env,
      OPENCLAW_LOCAL_CHECK: "1",
      OPENCLAW_TYPECHECKER: undefined,
      OPENCLAW_TSGO_PPROF_DIR: fromEnvironment ? "profiles" : undefined,
    });
    expect(command?.bin).toBe(resolveRepoToolBinPath("tsgo"));
  },
);

it("refuses a shared install without creating dependency links", () => {
  const primary = fs.realpathSync.native(createTempDir("native-primary-install-"));
  const root = path.join(primary, ".claude/worktrees/validation");
  expect(spawnSync("git", ["init", "-q"], { cwd: primary }).status).toBe(0);
  write(root, ".git", `gitdir: ${path.join(primary, ".git")}\n`);
  write(root, "package.json", '{"private":true}\n');
  write(root, "pnpm-workspace.yaml", "packages: []\n");
  const sharedInstall = fs.realpathSync.native(createTempDir("native-shared-install-"));
  const nativeRoot = path.join(
    sharedInstall,
    "node_modules",
    resolveTypeCheckTool() === "tsrs" ? "tsrs" : "typescript",
  );
  const resolverExecuted = path.join(primary, "resolver-executed");
  write(nativeRoot, "package.json", '{"type":"module"}\n');
  write(
    nativeRoot,
    "lib/getExePath.js",
    `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(resolverExecuted)}, "executed");
export default () => process.execPath;\n`,
  );
  fs.symlinkSync(
    path.join(sharedInstall, "node_modules"),
    path.join(primary, "node_modules"),
    "junction",
  );
  const localModules = path.join(root, "node_modules");
  fs.symlinkSync(path.join(primary, "node_modules"), localModules, "junction");
  const result = spawnSync(process.execPath, [path.resolve("scripts/run-tsgo.mjs"), "--version"], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stderr).toContain("Declaration input escapes checkout");
  expect(result.stderr).toContain("shared installs and external symlinks are unsupported");
  expect(fs.existsSync(localModules)).toBe(true);
  expect(fs.existsSync(resolverExecuted)).toBe(false);
});

describe("run-tsgo sparse guard", () => {
  const requiredPaths = [
    "packages/plugin-package-contract/src/index.ts",
    "ui/config/control-ui-chunking.ts",
    "ui/src/api/gateway.ts",
    "ui/src/app/settings.ts",
    "ui/src/i18n/lib/registry.ts",
    "ui/src/i18n/lib/types.ts",
  ];
  const missingInputsError = (paths: string[]) =>
    [
      "tsconfig.core.test.json cannot be typechecked from this sparse checkout because tracked project inputs are missing or only partially included:",
      ...paths.map((file) => `- ${file}`),
      "Expand this worktree's sparse checkout to include those paths, or rerun in a full worktree.",
    ].join("\n");

  it("ignores full worktrees", () => {
    expect(sparseGuard({ isSparseCheckoutEnabled: () => false })).toBeNull();
  });

  it("ignores metadata-only commands", () => {
    expect(
      sparseGuard({}, ["-p", "test/tsconfig/tsconfig.core.test.json", "--showConfig"]),
    ).toBeNull();
  });

  it("rejects package-test sparse worktrees missing inherited declaration roots", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");

    expect(
      getSparseTsgoGuardError(["-p", "test/tsconfig/tsconfig.test.packages.json"], {
        cwd,
        fileExists: () => true,
        isSparseCheckoutEnabled: () => true,
        sparseCheckoutPatterns: ["/packages/"],
      }),
    ).toMatchInlineSnapshot(`
      "tsconfig.test.packages.json cannot be typechecked from this sparse checkout because tracked project inputs are missing or only partially included:
      - src
      - ui/src
      Expand this worktree's sparse checkout to include those paths, or rerun in a full worktree."
    `);
  });

  it("rejects sparse core worktrees that include only selected ui and package files", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");
    for (const relativePath of requiredPaths) {
      write(cwd, relativePath, "");
    }

    expect(
      sparseGuard({
        cwd,
        sparseCheckoutPatterns: requiredPaths.map((file) => `/${file}`),
      }),
    ).toBe(missingInputsError(["packages", "ui/config", "ui/src"]));
  });

  it("does not require plugin browser sources for tsconfig.ui.json", () => {
    expect(
      sparseGuard(
        {
          fileExists: () => true,
          sparseCheckoutPatterns: ["/packages/", "/src/", "/ui/config/", "/ui/src/"],
        },
        ["-p", "tsconfig.ui.json"],
      ),
    ).toBeNull();
  });

  it("returns a helpful message for sparse core-test worktrees missing ui and packages files", () => {
    expect(sparseGuard()).toBe(missingInputsError(requiredPaths));
  });

  it("recognizes the check:changed sparse-skip env", () => {
    expect(shouldSkipSparseTsgoGuardError({ OPENCLAW_TSGO_SPARSE_SKIP: "1" })).toBe(true);
    expect(shouldSkipSparseTsgoGuardError({ OPENCLAW_TSGO_SPARSE_SKIP: "true" })).toBe(true);
    expect(shouldSkipSparseTsgoGuardError({ OPENCLAW_TSGO_SPARSE_SKIP: "0" })).toBe(false);
    expect(createSparseTsgoSkipEnv({ PATH: "/usr/bin" })).toStrictEqual({
      PATH: "/usr/bin",
      OPENCLAW_TSGO_SPARSE_SKIP: "1",
    });
  });
});

describe.skipIf(process.platform === "win32")("run-tsgo watchdog", () => {
  let receipts: FixtureReceiptChannel;
  beforeAll(async () => {
    receipts = await openFixtureReceiptChannel();
  });
  afterAll(async () => {
    await receipts?.close();
  });

  it("keeps the watchdog opt-in", () => {
    expect(resolveTsgoTimeoutMs({})).toBeUndefined();
    expect(resolveTsgoTimeoutMs({ OPENCLAW_TSGO_TIMEOUT_MS: "  " })).toBeUndefined();
    expect(resolveTsgoTimeoutMs({ OPENCLAW_TSGO_TIMEOUT_MS: "30000" })).toBe(30_000);
  });

  function writeFakeTsgo(body: string, cwd = createTempDir("openclaw-run-tsgo-watchdog-")) {
    // Nested temp roots must not borrow the enclosing checkout's compiler install.
    if (!fs.existsSync(path.join(cwd, "package.json"))) {
      write(cwd, "package.json", '{"private":true}\n');
    }
    write(cwd, "pnpm-workspace.yaml", "packages: []\n");
    const fakeTsgo = write(cwd, "node_modules/.bin/tsgo", body);
    fs.chmodSync(fakeTsgo, 0o755);
    overrideNativeFixtureExecutable(cwd, fakeTsgo);
    return cwd;
  }

  // A detached compiler requires PID-based rescue after the outer timeout.
  function readPid(file: string) {
    const pid = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : Number.NaN;
    return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
  }
  const readFakeTsgoPid = (cwd: string) => readPid(path.join(cwd, "fake-tsgo.pid"));

  function reapFakeTsgo(cwd: string) {
    const pid = readFakeTsgoPid(cwd);
    if (pid === undefined) {
      return;
    }
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, "SIGKILL");
      } catch {
        // Already reaped by the watchdog under test.
      }
    }
  }

  function withSupervisorClock(cwd: string, env: NodeJS.ProcessEnv, preloads: string[] = []) {
    // Scale both cleanup owners so an outer cutoff that races inner reaping still fails.
    // Compiler/watchdog timers, readiness checks, and OS signals retain real time.
    const preloadPath = write(
      cwd,
      "supervisor-clock.mjs",
      `if (process.argv[1] === ${JSON.stringify(path.resolve("scripts/run-tsgo.mts"))}) {
  const realNow = Date.now.bind(Date);
  const startedAt = realNow();
  Date.now = () => startedAt + (realNow() - startedAt) * 5;
} else if (process.argv[1] === ${JSON.stringify(path.resolve("scripts/run-tsgo.mjs"))}) {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) =>
    realSetTimeout(callback, delay / 5, ...args);
}\n`,
    );
    const imports = [...preloads, preloadPath]
      .map((preload) => `--import=${pathToFileURL(preload).href}`)
      .join(" ");
    return {
      ...env,
      NODE_OPTIONS: [env.NODE_OPTIONS, imports].filter(Boolean).join(" "),
      BUN_OPTIONS: [env.BUN_OPTIONS, imports].filter(Boolean).join(" "),
    };
  }

  function runFakeTsgo(
    cwd: string,
    timeoutMs: string | undefined,
    onBeforeReap?: (pid: number | undefined) => void,
  ) {
    const env = {
      ...process.env,
      OPENCLAW_TSGO_TIMEOUT_MS: timeoutMs,
      OPENCLAW_CI_STATIC_EVIDENCE: "1",
      OPENCLAW_TSGO_METRICS_DIR: undefined,
    };
    try {
      return spawnSync(
        process.execPath,
        [path.resolve("scripts/run-tsgo.mjs"), "-p", "tsconfig.extensions.json"],
        {
          cwd,
          encoding: "utf8",
          env: withSupervisorClock(cwd, env),
          // spawnSync blocks Vitest's timeout; bound a regressed wrapper separately.
          timeout: 25_000,
          killSignal: "SIGKILL",
        },
      );
    } finally {
      onBeforeReap?.(readFakeTsgoPid(cwd));
      reapFakeTsgo(cwd);
    }
  }

  it("rejects and drains compiler descendants left after a successful leader exit", async ({
    signal,
  }) => {
    const cwd = createTempDir("openclaw-run-tsgo-lingering-");
    const descendantPidPath = path.join(cwd, "descendant.pid");
    writeFakeTsgo(
      `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
fs.writeFileSync("fake-tsgo.pid", String(process.pid));
const child = spawn(process.execPath, ["-e", ${JSON.stringify(`
const fs = require("node:fs");
setInterval(() => {}, 1000);
fs.writeFileSync(process.argv[1], String(process.pid));
process.send("ready");
process.disconnect();
`)}, ${JSON.stringify(descendantPidPath)}], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
child.once("message", () => process.exit(0));
`,
      cwd,
    );
    let observedPids: Array<number | undefined> = [];
    let liveBeforeTeardown: number[] = [];
    try {
      const result = runFakeTsgo(cwd, undefined, (pid) => {
        observedPids = [pid, readPid(descendantPidPath)];
        liveBeforeTeardown = observedPids.filter(
          (owned): owned is number => owned !== undefined && isProcessAlive(owned),
        );
      });
      expect(result.error).toBeUndefined();
      expect(
        observedPids.every((pid) => pid !== undefined && Number.isSafeInteger(pid) && pid > 1),
      ).toBe(true);
      expect.soft(result.status).toBe(1);
      expect.soft(result.stderr).toContain("EPROCESSGROUP_CLEANUP_FAILED");
      expect.soft(result.stdout).not.toContain("[ci-static:tsgo:");
      expect
        .soft(liveBeforeTeardown, "compiler descendants must be absent before fixture teardown")
        .toEqual([]);
    } finally {
      for (const pidFile of [descendantPidPath, path.join(cwd, "fake-tsgo.pid")]) {
        const pid = readPid(pidFile);
        if (pid === undefined) {
          continue;
        }
        if (isProcessAlive(pid)) {
          process.kill(pid, "SIGKILL");
        }
        await waitForDead(pid, signal);
      }
    }
  }, 30_000);

  it("explains a rejected OPENCLAW_TSGO_TIMEOUT_MS of 0 instead of crashing", () => {
    const cwd = writeFakeTsgo("#!/bin/sh\nexit 0\n");
    const result = runFakeTsgo(cwd, "0");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be plain decimal digits");
    expect(result.stderr).toContain("Unset it to disable the watchdog");
    expect(result.stderr).not.toContain("at readPositiveEnvInt");
    expect(result.stderr.trim().split("\n").at(-1)).toBe("[tsgo] FAILED (exit 1)");
  }, 30_000);

  it("kills a wedged tsgo that ignores SIGTERM instead of blocking its caller forever", () => {
    // Only group SIGKILL frees this observed wedge; self-exit is the rescue backstop.
    const cwd = writeFakeTsgo(
      '#!/bin/sh\necho $$ > "$(dirname "$0")/../../fake-tsgo.pid"\ntrap \'\' TERM\ni=0\nwhile [ $i -lt 60 ]; do sleep 1; i=$((i+1)); done\n',
    );

    const observedBeforeReap = {
      error: undefined as unknown,
      pid: undefined as number | undefined,
    };
    const result = runFakeTsgo(cwd, "2000", (pid) => {
      observedBeforeReap.pid = pid;
      if (pid === undefined) {
        return;
      }
      try {
        process.kill(pid, 0);
      } catch (error) {
        observedBeforeReap.error = error;
      }
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("killed the tsgo process tree");
    expect(result.stdout).not.toContain("[ci-static:tsgo:");
    expect(observedBeforeReap.pid).toBeDefined();
    expect(observedBeforeReap.error).toMatchObject({ code: "ESRCH" });
    expect(result.stderr.trim().split("\n").at(-1)).toBe("[tsgo] FAILED (exit 1)");
  }, 30_000);

  it.for(["wrapper", "spawn"])(
    "reaps a wedged compiler on SIGTERM during %s",
    { timeout: 20_000 },
    (phase, { signal }) =>
      fixture.run(async () => {
        const fixtureDirs = createTempDirTracker();
        // Retain detached-compiler diagnostics until wrapper and compiler join.
        const artifacts = path.resolve(".artifacts/tsgo-signal");
        fs.mkdirSync(artifacts, { recursive: true });
        const cwd = fixtureDirs.make("fixture-", fs.realpathSync(artifacts));
        let retainFixture = false;
        try {
          const pidFile = path.join(cwd, "fake-tsgo.pid");
          // Own the artifact lock rather than borrowing the enclosing checkout's.
          write(cwd, "package.json", '{"private":true,"type":"module"}\n');
          write(cwd, "tsconfig.extensions.json", "{}\n");
          const readyPipe = path.join(cwd, "compiler-ready.pipe");
          if (phase === "spawn") {
            expect(spawnSync("mkfifo", [readyPipe]).status).toBe(0);
          }
          writeFakeTsgo(
            `#!/usr/bin/env node
import fs from "node:fs";
${fixtureReceiptClientSource(receipts.endpoint)}
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(signal, () => {});
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
sendReceipt(${JSON.stringify(pidFile)}, "ready");
${phase === "spawn" ? 'fs.writeSync(Number(process.env.OPENCLAW_TEST_TSGO_READY_FD), "R");' : ""}
setInterval(() => {}, 1000);
`,
            cwd,
          );
          const preloadPath = path.join(cwd, "signal-during-spawn.mjs");
          // Block spawn before child registration; async IPC cannot wake this boundary.
          write(
            cwd,
            "signal-during-spawn.mjs",
            `
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const spawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  if (args[0] !== ${JSON.stringify(path.join(cwd, "node_modules/.bin/tsgo"))}) return spawn(...args);
  const ready = fs.openSync(${JSON.stringify(readyPipe)}, "r+");
  try {
    const options = args[2];
    const child = spawn(args[0], args[1], {
      ...options,
      env: { ...options.env, OPENCLAW_TEST_TSGO_READY_FD: String(options.stdio.length) },
      stdio: [...options.stdio, ready],
    });
    const receipt = Buffer.alloc(1);
    if (fs.readSync(ready, receipt) !== receipt.length) {
      throw new Error("compiler readiness pipe closed before ready");
    }
    if (receipt.toString() === "R") process.kill(process.pid, "SIGTERM");
    return child;
  } finally {
    fs.closeSync(ready);
  }
};
syncBuiltinESMExports();
`,
          );
          const wrapper = spawn(
            process.execPath,
            [path.resolve("scripts/run-tsgo.mjs"), "-p", "tsconfig.extensions.json"],
            {
              cwd,
              stdio: ["ignore", "ignore", "pipe"],
              env: withSupervisorClock(cwd, process.env, phase === "spawn" ? [preloadPath] : []),
            },
          );
          retainFixture = true;
          const stderr = createBoundedChildOutput();
          wrapper.stderr.on("data", (chunk) => stderr.append(chunk));
          wrapper.once("error", (error) =>
            stderr.append(`wrapper spawn error: ${error.message}\n`),
          );
          // Keep completion available after cancellation starts teardown.
          const wrapperClose = new Promise<{
            code: number | null;
            signal: NodeJS.Signals | null;
          }>((resolve) => {
            wrapper.once("close", (code, exitSignal) => resolve({ code, signal: exitSignal }));
          });
          const errors: unknown[] = [];
          try {
            // PID precedes the receipt; separate pipes can deliver wrapper exit first.
            await withinTest(
              Promise.race([
                receipts.waitFor(pidFile, "ready"),
                wrapperClose.then(() => {
                  if (readFakeTsgoPid(cwd) === undefined) {
                    throw new Error(`timeout waiting for pid in ${pidFile}`);
                  }
                }),
              ]),
              signal,
            );
            const compilerPid = readFakeTsgoPid(cwd)!;
            if (phase === "wrapper") {
              wrapper.kill("SIGTERM");
            }

            const wrapperResult = await withinTest(wrapperClose, signal);
            expect([
              { code: 143, signal: null },
              { code: null, signal: "SIGTERM" },
            ]).toContainEqual(wrapperResult);
            // CLI completion must follow compiler-tree exit.
            expect(isProcessAlive(compilerPid)).toBe(false);
          } catch (error) {
            errors.push(error);
          } finally {
            try {
              if (wrapper.exitCode === null && wrapper.signalCode === null) {
                wrapper.kill("SIGTERM");
                if (phase === "spawn") {
                  // Release spawn so the product can register its child and stop it.
                  const ready = fs.openSync(readyPipe, "r+");
                  try {
                    fs.writeSync(ready, "C");
                  } finally {
                    fs.closeSync(ready);
                  }
                }
              }
              await wrapperClose;
              reapFakeTsgo(cwd);
              const compilerPid = readFakeTsgoPid(cwd);
              if (compilerPid !== undefined) {
                await waitForDead(compilerPid, signal);
              }
              retainFixture = false;
            } catch (error) {
              errors.push(error);
            }
          }
          if (errors.length > 0) {
            const cause = errors.length === 1 ? errors[0] : new AggregateError(errors);
            const retained = retainFixture ? `\nfixture retained at ${cwd}` : "";
            throw new Error(
              `${errors.map(String).join("\n")}\nwrapper exitCode=${wrapper.exitCode}, signalCode=${wrapper.signalCode}${retained}\n${stderr.text()}`,
              { cause },
            );
          }
        } finally {
          if (!retainFixture) {
            fixtureDirs.cleanup();
          }
        }
      }),
  );

  // Without saturation Node collapses the delay to 1ms and kills the sleeping child.
  it("leaves a completing tsgo alone under an override past Node's timer ceiling", () => {
    const cwd = writeFakeTsgo("#!/bin/sh\nsleep 0.25\nexit 0\n");
    const result = runFakeTsgo(cwd, "2147483648");

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("killed the tsgo process tree");
  }, 30_000);
});
