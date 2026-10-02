// Run Tsgo tests cover run tsgo script behavior.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createSparseTsgoSkipEnv,
  getSparseTsgoGuardError,
  shouldSkipSparseTsgoGuardError,
} from "../../scripts/lib/tsgo-sparse-guard.mts";
import { resolveTsgoTimeoutMs } from "../../scripts/run-tsgo.mts";
import { createBoundedChildOutput } from "../helpers/bounded-child-output.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { isProcessAlive } from "../helpers/process-wait.js";
import { withinTest } from "../helpers/promise.js";
import { createTempDirTracker } from "../helpers/temp-dir.js";
import { overrideNativeFixtureExecutable } from "./native-boundary-fixture.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const fixture = createFixtureLifetime();
afterEach(() => fixture.cleanup());

it("runs the installed compiler version through the real tsgo wrapper", () => {
  const result = spawnSync(process.execPath, [path.resolve("scripts/run-tsgo.mjs"), "--version"], {
    encoding: "utf8",
    timeout: 25_000,
    killSignal: "SIGKILL",
  });

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  const nativeManifest = createRequire(import.meta.url).resolve("typescript/package.json");
  const nativePackage: { version: string } = JSON.parse(fs.readFileSync(nativeManifest, "utf8"));
  expect(result.stdout.trim()).toBe(`Version ${nativePackage.version}`);
}, 30_000);

it("keeps compiler output unchanged with opt-in metrics and emits no metrics by default", () => {
  const cwd = createTempDir("run-tsgo-metrics-");
  const {
    OPENCLAW_TSGO_METRICS_DIR: _unset,
    OPENCLAW_LOCAL_CHECK_MODE: _mode,
    ...baseEnv
  } = process.env;
  for (const enabled of [false, true]) {
    const result = spawnSync(
      process.execPath,
      [path.resolve("scripts/run-tsgo.mjs"), "--version"],
      {
        encoding: "utf8",
        timeout: 25_000,
        env: { ...baseEnv, ...(enabled ? { OPENCLAW_TSGO_METRICS_DIR: cwd } : {}) },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^Version /u);
    expect(result.stderr).toBe("");
    expect(fs.readdirSync(cwd)).toHaveLength(enabled ? 1 : 0);
    if (enabled) {
      const [artifact] = fs.readdirSync(cwd);
      if (!artifact) {
        throw new Error("Missing compiler metrics artifact");
      }
      const evidence = JSON.parse(fs.readFileSync(path.join(cwd, artifact), "utf8"));
      expect(`Version ${evidence.compilerVersion}`).toBe(result.stdout.trim());
      expect(evidence.outcome.exitCode).toBe(0);
      expect(evidence.command.args).toContain("--version");
      expect(evidence.cache.hit).toBe("unknown");
      expect(evidence.resources.policy.OPENCLAW_LOCAL_CHECK_MODE).toBeNull();
    }
  }
}, 30_000);

it.each([false, true])(
  "refuses a shared install without creating dependency links (linked=%s)",
  (linked) => {
    const primary = fs.realpathSync.native(createTempDir("native-primary-install-"));
    const root = path.join(primary, ".claude/worktrees/validation");
    fs.mkdirSync(root, { recursive: true });
    expect(spawnSync("git", ["init", "-q"], { cwd: primary }).status).toBe(0);
    fs.writeFileSync(path.join(root, ".git"), `gitdir: ${path.join(primary, ".git")}\n`);
    fs.writeFileSync(path.join(root, "package.json"), '{"private":true}\n');
    fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
    const sharedInstall = fs.realpathSync.native(createTempDir("native-shared-install-"));
    const nativeRoot = path.join(sharedInstall, "node_modules/typescript");
    const resolverExecuted = path.join(primary, "resolver-executed");
    fs.mkdirSync(path.join(nativeRoot, "lib"), { recursive: true });
    fs.writeFileSync(path.join(nativeRoot, "package.json"), '{"type":"module"}\n');
    fs.writeFileSync(
      path.join(nativeRoot, "lib/getExePath.js"),
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
    if (linked) {
      fs.symlinkSync(path.join(primary, "node_modules"), localModules, "junction");
    }
    const result = spawnSync(
      process.execPath,
      [path.resolve("scripts/run-tsgo.mjs"), "--version"],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("Declaration input escapes checkout");
    expect(result.stderr).toContain("shared installs and external symlinks are unsupported");
    expect(fs.existsSync(localModules)).toBe(linked);
    expect(fs.existsSync(resolverExecuted)).toBe(false);
  },
);

describe("run-tsgo sparse guard", () => {
  it("ends sparse-checkout failures with the stable failure trailer", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");
    spawnSync("git", ["init", "-q"], { cwd });
    spawnSync("git", ["config", "core.sparseCheckout", "true"], { cwd });

    const result = spawnSync(
      process.execPath,
      [path.resolve("scripts/run-tsgo.mjs"), "-p", "test/tsconfig/tsconfig.core.test.json"],
      {
        cwd,
        encoding: "utf8",
        env: process.env,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr.trim().split("\n").at(-1)).toBe("[tsgo] FAILED (exit 1)");
  });

  it("ignores non-core projects", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");

    expect(
      getSparseTsgoGuardError(["-p", "tsconfig.extensions.json"], {
        cwd,
        isSparseCheckoutEnabled: () => true,
      }),
    ).toBeNull();
  });

  it("ignores full worktrees", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");

    expect(
      getSparseTsgoGuardError(["-p", "test/tsconfig/tsconfig.core.test.json"], {
        cwd,
        isSparseCheckoutEnabled: () => false,
      }),
    ).toBeNull();
  });

  it("ignores metadata-only commands", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");

    expect(
      getSparseTsgoGuardError(["-p", "test/tsconfig/tsconfig.core.test.json", "--showConfig"], {
        cwd,
        isSparseCheckoutEnabled: () => true,
      }),
    ).toBeNull();
  });

  it("ignores sparse worktrees when the required files are present", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");
    const requiredPaths = [
      "packages/plugin-package-contract/src/index.ts",
      "ui/config/control-ui-chunking.ts",
      "ui/src/i18n/lib/registry.ts",
      "ui/src/i18n/lib/types.ts",
      "ui/src/app/settings.ts",
      "ui/src/api/gateway.ts",
    ];

    for (const relativePath of requiredPaths) {
      const absolutePath = path.join(cwd, relativePath);
      const dir = path.dirname(absolutePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(absolutePath, "", "utf8");
    }

    expect(
      getSparseTsgoGuardError(["-p", "test/tsconfig/tsconfig.core.test.other.json"], {
        cwd,
        isSparseCheckoutEnabled: () => true,
        sparseCheckoutPatterns: ["/packages/", "/ui/config/", "/ui/src/"],
      }),
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

  it("rejects declaration-shard sparse worktrees missing inherited roots", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");

    expect(
      getSparseTsgoGuardError(["-p", "test/tsconfig/tsconfig.test.extension-declarations.json"], {
        cwd,
        fileExists: () => true,
        isSparseCheckoutEnabled: () => true,
        sparseCheckoutPatterns: ["/extensions/"],
      }),
    ).toMatchInlineSnapshot(`
      "tsconfig.test.extension-declarations.json cannot be typechecked from this sparse checkout because tracked project inputs are missing or only partially included:
      - src
      - ui/src
      Expand this worktree's sparse checkout to include those paths, or rerun in a full worktree."
    `);
  });

  it("rejects sparse core worktrees that include only selected ui and package files", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");
    const requiredPaths = [
      "packages/plugin-package-contract/src/index.ts",
      "ui/config/control-ui-chunking.ts",
      "ui/src/i18n/lib/registry.ts",
      "ui/src/i18n/lib/types.ts",
      "ui/src/app/settings.ts",
      "ui/src/api/gateway.ts",
    ];

    for (const relativePath of requiredPaths) {
      const absolutePath = path.join(cwd, relativePath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, "", "utf8");
    }

    expect(
      getSparseTsgoGuardError(["-p", "test/tsconfig/tsconfig.core.test.json"], {
        cwd,
        isSparseCheckoutEnabled: () => true,
        sparseCheckoutPatterns: [
          "/packages/plugin-package-contract/src/index.ts",
          "/ui/config/control-ui-chunking.ts",
          "/ui/src/i18n/lib/registry.ts",
          "/ui/src/i18n/lib/types.ts",
          "/ui/src/app/settings.ts",
          "/ui/src/api/gateway.ts",
        ],
      }),
    ).toMatchInlineSnapshot(`
      "tsconfig.core.test.json cannot be typechecked from this sparse checkout because tracked project inputs are missing or only partially included:
      - packages
      - ui/config
      - ui/src
      Expand this worktree's sparse checkout to include those paths, or rerun in a full worktree."
    `);
  });

  it("returns a helpful message for sparse UI worktrees missing transitive project files", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");
    const uiToolDisplay = path.join(cwd, "ui/src/lib/chat/tool-display.ts");
    fs.mkdirSync(path.dirname(uiToolDisplay), { recursive: true });
    fs.writeFileSync(uiToolDisplay, "", "utf8");

    expect(
      getSparseTsgoGuardError(["-p", "tsconfig.ui.json"], {
        cwd,
        isSparseCheckoutEnabled: () => true,
      }),
    ).toMatchInlineSnapshot(`
      "tsconfig.ui.json cannot be typechecked from this sparse checkout because tracked project inputs are missing or only partially included:
      - apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json
      Expand this worktree's sparse checkout to include those paths, or rerun in a full worktree."
    `);
  });

  it("rejects sparse UI worktrees missing the transitive src root", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");

    expect(
      getSparseTsgoGuardError(["-p", "tsconfig.ui.json"], {
        cwd,
        fileExists: () => true,
        isSparseCheckoutEnabled: () => true,
        sparseCheckoutPatterns: ["/packages/", "/ui/config/", "/ui/src/"],
      }),
    ).toMatchInlineSnapshot(`
      "tsconfig.ui.json cannot be typechecked from this sparse checkout because tracked project inputs are missing or only partially included:
      - src
      Expand this worktree's sparse checkout to include those paths, or rerun in a full worktree."
    `);
  });

  it.each([
    "tsconfig.ui.json",
    "test/tsconfig/tsconfig.core.test.json",
    "test/tsconfig/tsconfig.core.test.ui-other.json",
  ])("does not require plugin browser sources for %s", (project) => {
    const cwd = createTempDir("openclaw-run-tsgo-");
    const options = {
      cwd,
      fileExists: () => true,
      isSparseCheckoutEnabled: () => true,
      sparseCheckoutPatterns: ["/packages/", "/src/", "/ui/config/", "/ui/src/"],
    };

    expect(getSparseTsgoGuardError(["-p", project], options)).toBeNull();
  });

  it("returns a helpful message for sparse core-test worktrees missing ui and packages files", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");

    expect(
      getSparseTsgoGuardError(["-p", "test/tsconfig/tsconfig.core.test.json"], {
        cwd,
        isSparseCheckoutEnabled: () => true,
      }),
    ).toMatchInlineSnapshot(`
      "tsconfig.core.test.json cannot be typechecked from this sparse checkout because tracked project inputs are missing or only partially included:
      - packages/plugin-package-contract/src/index.ts
      - ui/config/control-ui-chunking.ts
      - ui/src/api/gateway.ts
      - ui/src/app/settings.ts
      - ui/src/i18n/lib/registry.ts
      - ui/src/i18n/lib/types.ts
      Expand this worktree's sparse checkout to include those paths, or rerun in a full worktree."
    `);
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

  // Rescue observes foreign descendants after their owner exited; no ChildProcess
  // handle survives here. Only test cancellation bounds this final extinction check.
  async function waitForDead(pid: number, signal: AbortSignal): Promise<void> {
    while (isProcessAlive(pid)) {
      try {
        await delay(5, undefined, { signal });
      } catch (cause) {
        throw new Error(`process still alive: ${pid}`, { cause });
      }
    }
  }

  it("keeps the watchdog opt-in", () => {
    expect(resolveTsgoTimeoutMs({})).toBeUndefined();
    expect(resolveTsgoTimeoutMs({ OPENCLAW_TSGO_TIMEOUT_MS: "  " })).toBeUndefined();
    expect(resolveTsgoTimeoutMs({ OPENCLAW_TSGO_TIMEOUT_MS: "30000" })).toBe(30_000);
  });

  function writeFakeTsgo(cwd: string, body: string) {
    const binDir = path.join(cwd, "node_modules", ".bin");
    fs.mkdirSync(binDir, { recursive: true });
    const fakeTsgo = path.join(binDir, "tsgo");
    fs.writeFileSync(fakeTsgo, body, "utf8");
    fs.chmodSync(fakeTsgo, 0o755);
    overrideNativeFixtureExecutable(cwd, fakeTsgo);
  }

  // The fake compiler is a grandchild in its own process group, so spawnSync's
  // killSignal never reaches it. Its recorded pid is the only handle the harness
  // has to tear the tree down when the outer timeout fires on a pre-fix run.
  function readFakeTsgoPid(cwd: string) {
    const pidFile = path.join(cwd, "fake-tsgo.pid");
    if (!fs.existsSync(pidFile)) {
      return undefined;
    }
    const pid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 1 ? pid : undefined;
  }

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

  function withSupervisorClock(
    cwd: string,
    env: NodeJS.ProcessEnv,
    preloads: string[] = [],
  ): NodeJS.ProcessEnv {
    const preloadPath = path.join(cwd, "supervisor-clock.mjs");
    // Scale both cleanup owners so an outer cutoff that races inner reaping still fails.
    // Compiler/watchdog timers, readiness checks, and OS signals retain real time.
    fs.writeFileSync(
      preloadPath,
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
    // Both supervisor processes need the fixtures through their runtime's inherited options.
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
    metricsDir?: string,
  ) {
    const { OPENCLAW_TSGO_TIMEOUT_MS: _unset, ...inheritedEnv } = process.env;
    const baseEnv = {
      ...inheritedEnv,
      OPENCLAW_CI_STATIC_EVIDENCE: "1",
      OPENCLAW_TSGO_METRICS_DIR: metricsDir,
    };
    try {
      return spawnSync(
        process.execPath,
        [path.resolve("scripts/run-tsgo.mjs"), "-p", "tsconfig.extensions.json"],
        {
          cwd,
          encoding: "utf8",
          env: withSupervisorClock(
            cwd,
            timeoutMs === undefined ? baseEnv : { ...baseEnv, OPENCLAW_TSGO_TIMEOUT_MS: timeoutMs },
          ),
          // spawnSync blocks this thread, so vitest's own per-test budget can never
          // fire; a regression here would hang the worker instead of failing.
          timeout: 25_000,
          killSignal: "SIGKILL",
        },
      );
    } finally {
      onBeforeReap?.(readFakeTsgoPid(cwd));
      reapFakeTsgo(cwd);
    }
  }

  it.each([0, 2])(
    "preserves CI diagnostics and completion with metrics enabled (exit %s)",
    (exitCode) => {
      const cwd = createTempDir("run-tsgo-ci-metrics-");
      const metricsDir = path.join(cwd, "metrics");
      const diagnostic =
        exitCode === 2 ? "src/fixture.ts(1,1): error TS2322: Invalid fixture value.\n" : "";
      writeFakeTsgo(
        cwd,
        `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(diagnostic)});
process.exitCode = ${exitCode};
`,
      );

      const result = runFakeTsgo(cwd, undefined, undefined, metricsDir);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(exitCode);
      const leafPrefix = "[ci-static:tsgo:leaf] ";
      const completionPrefix = "[ci-static:tsgo:completion] ";
      const lines = result.stdout.trim().split("\n");
      const leaves = lines.filter((line) => line.startsWith(leafPrefix));
      const completions = lines.filter((line) => line.startsWith(completionPrefix));
      expect(leaves).toHaveLength(1);
      expect(completions).toHaveLength(1);
      const leaf = JSON.parse(leaves[0]!.slice(leafPrefix.length));
      expect(leaf).toMatchObject({
        version: 1,
        config: "tsconfig.extensions.json",
        exitCode,
        stdout: diagnostic,
        stderr: "",
      });
      const completion = JSON.parse(completions[0]!.slice(completionPrefix.length));
      expect(completion).toMatchObject({ planned: 1, completed: 1, leaves: [leaf.id] });
      expect(result.stdout).toBe(
        `${diagnostic}${leafPrefix}${JSON.stringify(leaf)}\n${completionPrefix}${JSON.stringify(completion)}\n`,
      );
      const artifacts = fs.readdirSync(metricsDir);
      expect(artifacts).toHaveLength(1);
      const metrics = JSON.parse(fs.readFileSync(path.join(metricsDir, artifacts[0]!), "utf8"));
      expect(metrics.outcome).toMatchObject({ exitCode, errorCode: null });
      expect(metrics.command.args).toEqual(
        expect.arrayContaining(["-p", "tsconfig.extensions.json"]),
      );
      expect(metrics.command.args.slice(-2)).toEqual(["--pretty", "false"]);
    },
    30_000,
  );

  it("rejects and drains compiler descendants left after a successful leader exit", async ({
    signal,
  }) => {
    const cwd = createTempDir("openclaw-run-tsgo-lingering-");
    const descendantPidPath = path.join(cwd, "descendant.pid");
    writeFakeTsgo(
      cwd,
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
    );
    let observedPids: Array<number | undefined> = [];
    let liveBeforeTeardown: number[] = [];
    try {
      const result = runFakeTsgo(cwd, undefined, (pid) => {
        observedPids = [
          pid,
          fs.existsSync(descendantPidPath)
            ? Number(fs.readFileSync(descendantPidPath, "utf8"))
            : undefined,
        ];
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
        if (!fs.existsSync(pidFile)) {
          continue;
        }
        const pid = Number(fs.readFileSync(pidFile, "utf8"));
        if (!Number.isSafeInteger(pid) || pid <= 1) {
          continue;
        }
        if (isProcessAlive(pid)) {
          process.kill(pid, "SIGKILL");
        }
        await waitForDead(pid, signal);
      }
    }
  }, 30_000);

  it.each([{ bound: "0" }, { bound: "abc" }])(
    "explains a rejected OPENCLAW_TSGO_TIMEOUT_MS of $bound instead of crashing",
    ({ bound }) => {
      const cwd = createTempDir("openclaw-run-tsgo-watchdog-");
      writeFakeTsgo(cwd, "#!/bin/sh\nexit 0\n");

      const result = runFakeTsgo(cwd, bound);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("must be plain decimal digits");
      expect(result.stderr).toContain("Unset it to disable the watchdog");
      expect(result.stderr).not.toContain("at readPositiveEnvInt");
      expect(result.stderr.trim().split("\n").at(-1)).toBe("[tsgo] FAILED (exit 1)");
    },
    30_000,
  );

  it("kills a wedged tsgo that ignores SIGTERM instead of blocking its caller forever", () => {
    const cwd = createTempDir("openclaw-run-tsgo-watchdog-");
    // Mirrors the observed wedge: the checker refuses SIGTERM and never reports,
    // so only a process-group SIGKILL frees the caller. It records its pid so the
    // harness can reap the tree, and self-exits as a last-resort backstop.
    writeFakeTsgo(
      cwd,
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
    // Printing the message is not the contract; the tree actually being gone is.
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
        // Detached compilers can outlive Vitest's temporary namespace. Retain their
        // diagnostics outside it until both the wrapper and compiler are joined.
        const artifacts = path.resolve(".artifacts/tsgo-signal");
        fs.mkdirSync(artifacts, { recursive: true });
        const cwd = fixtureDirs.make("fixture-", fs.realpathSync(artifacts));
        let retainFixture = false;
        try {
          const pidFile = path.join(cwd, "fake-tsgo.pid");
          // Give this fixture its own artifact lock rather than the enclosing checkout's.
          fs.writeFileSync(path.join(cwd, "package.json"), '{"private":true,"type":"module"}\n');
          fs.writeFileSync(path.join(cwd, "pnpm-workspace.yaml"), "packages: []\n");
          fs.writeFileSync(path.join(cwd, "tsconfig.extensions.json"), "{}\n");
          const readyPipe = path.join(cwd, "compiler-ready.pipe");
          if (phase === "spawn") {
            expect(spawnSync("mkfifo", [readyPipe]).status).toBe(0);
          }
          writeFakeTsgo(
            cwd,
            `#!/usr/bin/env node
import fs from "node:fs";
${fixtureReceiptClientSource(receipts.endpoint)}
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(signal, () => {});
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
sendReceipt(${JSON.stringify(pidFile)}, "ready");
${phase === "spawn" ? 'fs.writeSync(3, "R");' : ""}
setInterval(() => {}, 1000);
`,
          );
          const preloadPath = path.join(cwd, "signal-during-spawn.mjs");
          // An inherited blocking pipe holds spawn before the supervisor registers
          // its child. Async IPC cannot wake this deliberately synchronous boundary.
          fs.writeFileSync(
            preloadPath,
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
    const child = spawn(args[0], args[1], { ...options, stdio: [...options.stdio, ready] });
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
          // Keep the actual completion available after test cancellation starts teardown.
          const wrapperClose = new Promise<{
            code: number | null;
            signal: NodeJS.Signals | null;
          }>((resolve) => {
            wrapper.once("close", (code, exitSignal) => resolve({ code, signal: exitSignal }));
          });
          const errors: unknown[] = [];
          try {
            // The PID is durable before the receipt; wrapper exit and receipt delivery
            // use separate pipes, so an early close must consult the recorded fact.
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
            // runPreparedTsgoCommand requires and joins compiler-tree exit before
            // the implementation-owned CLI shim reports its completion.
            expect(isProcessAlive(compilerPid)).toBe(false);
          } catch (error) {
            errors.push(error);
          } finally {
            try {
              if (wrapper.exitCode === null && wrapper.signalCode === null) {
                wrapper.kill("SIGTERM");
                if (phase === "spawn") {
                  // Cancellation releases the synchronous boundary so the product
                  // can register its child and process the forwarded stop signal.
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

  // Every bound that must leave a completing compiler alone. The ceiling case is the
  // regression that matters: without saturation Node collapses the delay to 1ms and
  // would kill this sleeping child immediately.
  it.each([
    { bound: undefined, name: "the disabled watchdog", body: "#!/bin/sh\nsleep 0.25\nexit 0\n" },
    { bound: "30000", name: "an explicit bound", body: "#!/bin/sh\nexit 0\n" },
    {
      bound: "2147483648",
      name: "an override past Node's timer ceiling",
      body: "#!/bin/sh\nsleep 0.25\nexit 0\n",
    },
  ])(
    "leaves a completing tsgo alone under $name",
    ({ bound, body }) => {
      const cwd = createTempDir("openclaw-run-tsgo-watchdog-");
      writeFakeTsgo(cwd, body);

      const result = runFakeTsgo(cwd, bound);

      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain("killed the tsgo process tree");
    },
    30_000,
  );
});
