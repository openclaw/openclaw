import { spawn, spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build as esbuild } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveOpenClawCompileCacheDirectory } from "../node-compile-cache.mjs";
import {
  inspectManagedProcessGroup,
  terminateManagedChild,
  waitForManagedProcessGroupExit,
} from "../scripts/lib/managed-child-process.mts";
import { resolveTestNodeExecPath } from "../src/test-utils/node-process.js";
import { createFixtureLifetime } from "./helpers/fixture-lifetime.js";
import { stageLauncherFixture } from "./helpers/openclaw-launcher-fixture.js";

// Node version fixtures must enter Node admission even when Vitest runs under Bun.
const testNodeExecPath = resolveTestNodeExecPath();

async function expectAbsent(file: string) {
  await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
}

function maintenanceObserver(setup: string, onStart: string) {
  return `
        import cp from "node:child_process";
        import { syncBuiltinESMExports } from "node:module";
        ${setup}
        let started;
        globalThis.maintenanceStarted = new Promise(resolve => { started = resolve; });
        const originalSpawn = cp.spawn;
        cp.spawn = function(command, args, options) {
          const child = originalSpawn(command, args, options);
          if (args.includes("--maintain")) {
            ${onStart}
            globalThis.maintenanceCompleted = new Promise(resolve => child.once("exit", resolve));
            // Observe completion even though the production child is detached.
            child.unref = () => {};
            started();
          }
          return child;
        };
        syncBuiltinESMExports();
      `;
}

async function waitForJsonFile<T>(filePath: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
    }
  }
  throw new Error(`timed out waiting for parseable JSON in ${filePath}`, { cause: lastError });
}

const closedLaunchers = new WeakSet<ReturnType<typeof spawn>>();

function trackLauncherClose(child: ReturnType<typeof spawn>): void {
  child.once("close", () => closedLaunchers.add(child));
}

async function waitForProcessClose(
  child: ReturnType<typeof spawn>,
  label: string,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (closedLaunchers.has(child)) {
    return { code: child.exitCode, signal: child.signalCode };
  }

  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const [code, exitSignal] = (await once(child, "close", { signal })) as [
      number | null,
      NodeJS.Signals | null,
    ];
    return { code, signal: exitSignal };
  } catch (error) {
    throw new Error(`timed out waiting for ${label} stdio to close`, { cause: error });
  }
}

async function settleLauncherFixture(
  fixtures: ReturnType<typeof createFixtureLifetime>,
  launcher: ReturnType<typeof spawn>,
): Promise<void> {
  await fixtures.verifyCleanup(async () => {
    // The detached fixture owns the respawn group even before a PID file is ready.
    if (inspectManagedProcessGroup(launcher, { errorPolicy: "alive-on-eperm" }) !== "dead") {
      terminateManagedChild(launcher, "SIGKILL", { processGroupFallback: "never" });
    }
    await waitForProcessClose(launcher, "fixture launcher cleanup", 5000);
    if (
      !(await waitForManagedProcessGroupExit(launcher, 5000, { errorPolicy: "alive-on-eperm" }))
    ) {
      throw new Error("launcher fixture process group did not settle; retain fixture inputs");
    }
  });
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function launcherEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  delete env.OPENCLAW_CONFIG_PATH;
  delete env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  delete env.OPENCLAW_HOME;
  delete env.OPENCLAW_STATE_DIR;
  delete env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
  delete env.NODE_COMPILE_CACHE;
  delete env.NODE_DISABLE_COMPILE_CACHE;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

function hasBunRuntime(): boolean {
  return (
    spawnSync(process.env.BUN_BIN ?? "bun", ["--version"], {
      encoding: "utf8",
    }).status === 0
  );
}

describe("openclaw launcher", () => {
  const fixtures = createFixtureLifetime();
  let root: string;

  function writeFixture(file: string, content: string) {
    return fs.writeFile(path.join(root, file), content, "utf8");
  }

  function runLauncher(
    args: string[] = [],
    options: Partial<SpawnSyncOptionsWithStringEncoding> = {},
    execPath = process.execPath,
  ) {
    return runNode([path.join(root, "openclaw.mjs"), ...args], options, execPath);
  }

  function runNode(
    args: string[],
    { env, ...options }: Partial<SpawnSyncOptionsWithStringEncoding> = {},
    execPath = process.execPath,
  ) {
    return spawnSync(execPath, args, {
      cwd: root,
      env: launcherEnv(env),
      encoding: "utf8",
      ...options,
    });
  }

  function writeEntry(source: string) {
    return writeFixture("dist/entry.js", source);
  }

  function writePackage(version: string, cliEntry = false) {
    return writeFixture(
      "package.json",
      JSON.stringify({
        version,
        ...(cliEntry
          ? { name: "openclaw", type: "module", exports: { "./cli-entry": "./openclaw.mjs" } }
          : {}),
      }),
    );
  }

  async function writePreload(name: string, source: string) {
    await writeFixture(name, source);
    return ["--import", pathToFileURL(path.join(root, name)).href];
  }

  async function runPreloadedLauncher(
    source: string,
    args: string[] = [],
    options: Partial<SpawnSyncOptionsWithStringEncoding> = {},
    execPath = testNodeExecPath,
  ) {
    return runNode(
      [...(await writePreload("preload.mjs", source)), path.join(root, "openclaw.mjs"), ...args],
      options,
      execPath,
    );
  }

  function expectOutput(result: ReturnType<typeof runLauncher>, stdout: string, status = 0) {
    expect(result.status, result.stderr).toBe(status);
    expect(result.stdout).toBe(stdout);
  }

  async function seedCache(cache: string) {
    const directory = resolveOpenClawCompileCacheDirectory({
      installRoot: root,
      env: { NODE_COMPILE_CACHE: cache },
    });
    if (!directory) {
      throw new Error("Fixture cache directory unavailable");
    }
    await fs.mkdir(directory, { recursive: true });
    return directory;
  }

  async function addSourceTreeMarker(): Promise<void> {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await writeFixture("src/entry.ts", "export {};\n");
  }

  async function addGitMarker(): Promise<void> {
    await writeFixture(".git", "gitdir: .git/worktrees/openclaw\n");
  }

  async function addCompileCacheProbe(): Promise<void> {
    await writeEntry(
      [
        'import module from "node:module";',
        "process.stdout.write(",
        '  `${module.getCompileCacheDir?.() ? "cache:enabled" : "cache:disabled"};respawn:${process.env.OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED ?? "0"}`',
        ");",
      ].join("\n"),
    );
  }

  beforeEach(async () => {
    root = fixtures.createTempDir("openclaw-launcher-");
    await stageLauncherFixture(root);
  });
  afterEach(() => fixtures.cleanup());

  function withRespawnChild(
    options: {
      entry: (readyPath: string) => string;
      pipe?: boolean;
    },
    check: (child: {
      launcher: ReturnType<typeof spawn>;
      pid: number;
      output: () => string;
    }) => Promise<void>,
  ) {
    return fixtures.run(async () => {
      await addGitMarker();
      const ready = path.join(root, "child-info.json");
      await writeEntry(options.entry(ready));
      const launcher = spawn(process.execPath, [path.join(root, "openclaw.mjs")], {
        detached: true,
        cwd: root,
        env: launcherEnv({
          NODE_COMPILE_CACHE: path.join(root, ".node-compile-cache"),
        }),
        stdio: options.pipe ? ["ignore", "pipe", "pipe"] : "ignore",
      });
      trackLauncherClose(launcher);
      let output = "";
      launcher.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      launcher.stderr?.resume();
      try {
        const { pid } = await waitForJsonFile<{ pid: number }>(ready, 5000);
        await check({ launcher, pid, output: () => output });
      } finally {
        await settleLauncherFixture(fixtures, launcher);
      }
    });
  }

  describe("browser native transport dispatch", () => {
    it("uses only the fixed native artifact before pending package repair or ordinary CLI startup", async () => {
      const native = path.join(root, "dist", "extensions", "browser", "native-host-entry.js");
      await fs.mkdir(path.dirname(native), { recursive: true });
      await fs.writeFile(native, 'setTimeout(() => process.stdout.write("native-frame"), 10);');
      await writeEntry('throw new Error("ordinary CLI must not load");');
      await writeFixture(".openclaw-lifecycle-pending", "pending");
      const child = runLauncher(["browser", "extension", "native-host"], {
        timeout: 20_000,
        env: { HOME: root, OPENCLAW_CONTAINER: "not-a-native-target" },
        cwd: process.cwd(),
      });
      expectOutput(child, "native-frame");
      expect(await fs.readFile(path.join(root, ".openclaw-lifecycle-pending"), "utf8")).toBe(
        "pending",
      );
    });

    it.each(["unsupported", "missing", "broken"])(
      "does not install or enter the CLI for an %s native runtime",
      async (kind) => {
        const execArgv: string[] = [];
        if (kind === "unsupported") {
          execArgv.push(
            ...(await writePreload(
              "unsupported-node.mjs",
              'Object.defineProperty(process.versions, "node", { value: "20.0.0" });',
            )),
          );
        } else if (kind === "broken") {
          const native = path.join(root, "dist", "extensions", "browser", "native-host-entry.js");
          await fs.mkdir(path.dirname(native), { recursive: true });
          await fs.writeFile(native, 'throw new Error("private native diagnostic");');
        }
        await writeEntry(
          kind === "unsupported"
            ? 'throw new Error("ordinary CLI must not load");'
            : 'process.stdout.write("ordinary CLI");',
        );
        const child = runNode(
          [...execArgv, path.join(root, "openclaw.mjs"), "browser", "extension", "native-host"],
          { timeout: 20_000, env: { HOME: root }, cwd: process.cwd() },
        );
        expectOutput(child, "", 1);
        if (kind === "unsupported") {
          await expectAbsent(path.join(root, ".openclaw"));
        } else {
          expect(child.stderr).not.toContain("private native diagnostic");
        }
      },
    );

    it.each([
      ["browser", "extension", "status"],
      ["browser", "extension", "setup", "--action", "inspect"],
      ["browser", "extension", "native-host-extra"],
      ["browser", "status"],
    ])("keeps sibling %j on ordinary CLI startup", async (...args) => {
      await writeEntry('process.stdout.write("ordinary CLI");');
      const child = runLauncher([...args], {
        timeout: 20_000,
        env: { HOME: root },
        cwd: process.cwd(),
      });
      expectOutput(child, "ordinary CLI");
    });
  });

  describe.skipIf(process.platform === "win32")("Node.js update recovery", () => {
    async function prepareRecovery(
      params: {
        tty?: boolean;
        version?: string;
        install?: "ok" | "failed" | "invalid";
        cached?: boolean;
        pendingLifecycle?: boolean;
      } = {},
    ) {
      const home = fixtures.createTempDir("openclaw-launcher-home with spaces-");
      const nodePath = path.join(home, ".openclaw/tools/cli-node/tools/node/bin/node");
      if (params.cached) {
        await fs.mkdir(path.dirname(nodePath), { recursive: true });
        await fs.symlink(testNodeExecPath, nodePath);
      }
      const installLog = path.join(root, "installer.json");
      const preload = path.join(root, "legacy-node.mjs");
      await fs.writeFile(
        preload,
        `
        import childProcess from "node:child_process";
        import fs from "node:fs";
        import path from "node:path";
        import { syncBuiltinESMExports } from "node:module";
        if (process.env.OPENCLAW_NODE_UPDATE_RESPAWNED !== "1") {
          Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(params.version ?? "20.0.0")} });
          if (process.versions.node.startsWith("20.")) {
            const getBuiltinModule = process.getBuiltinModule;
            process.getBuiltinModule = (id) => id === "node:sqlite" ? undefined : getBuiltinModule(id);
          }
          Object.defineProperty(process.stdin, "isTTY", { value: ${params.tty ?? true} });
          Object.defineProperty(process.stderr, "isTTY", { value: ${params.tty ?? true} });
          const realpath = fs.realpathSync;
          fs.realpathSync = (filename, ...options) => {
            const file = String(filename);
            if (path.basename(file) === "node" && file !== process.execPath && file !== ${JSON.stringify(nodePath)} && !fs.statSync(file).isDirectory()) {
              throw Object.assign(new Error("runtime absent from fixture"), { code: "ENOENT" });
            }
            return realpath(filename, ...options);
          };
          const original = childProcess.spawnSync;
          childProcess.spawnSync = (command, args, options) => {
            if (command !== ${JSON.stringify(process.platform === "darwin" ? "/bin/bash" : "bash")}) return original(command, args, options);
            fs.writeFileSync(${JSON.stringify(installLog)}, JSON.stringify({ command, args }));
            if (${JSON.stringify(params.install ?? "ok")} === "failed") return { status: 7 };
            if (${JSON.stringify(params.install ?? "ok")} === "ok") {
              fs.mkdirSync(path.dirname(${JSON.stringify(nodePath)}), { recursive: true });
              fs.symlinkSync(process.execPath, ${JSON.stringify(nodePath)});
            }
            return { status: 0 };
          };
          syncBuiltinESMExports();
        }
      `,
      );
      await writeEntry(
        `
        if (!process.getBuiltinModule?.("node:sqlite")) throw new Error("native diagnostic reader loaded without node:sqlite");
        process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), path: process.env.PATH, recovered: process.env.OPENCLAW_NODE_UPDATE_RESPAWNED === "1" }));
        process.exitCode = 17;
      `,
      );
      if (params.pendingLifecycle) {
        await writeFixture(".openclaw-lifecycle-pending", "");
        await fs.mkdir(path.join(root, "dist", "infra"));
        await writeFixture(
          "dist/infra/package-lifecycle.js",
          'if (process.env.OPENCLAW_NODE_UPDATE_RESPAWNED !== "1") throw new Error("legacy lifecycle loaded"); export function completePendingPackageLifecycle() {}',
        );
      }
      const run = (input: string, args = ["status"], env: NodeJS.ProcessEnv = {}, cwd = root) =>
        spawnSync(
          testNodeExecPath,
          ["--import", pathToFileURL(preload).href, path.join(root, "openclaw.mjs"), ...args],
          {
            cwd,
            env: {
              ...launcherEnv(),
              HOME: home,
              OPENCLAW_HOME: home,
              CI: "",
              OPENCLAW_NODE_UPDATE_RESPAWNED: "",
              ...env,
            },
            encoding: "utf8",
            input,
            timeout: 15_000,
          },
        );
      return { root, home, nodePath, installLog, run };
    }

    it("accepts Yes before pending lifecycle imports, installs only Node, and retries exact arguments", async () => {
      const fixture = await prepareRecovery({ pendingLifecycle: true });
      const args = ["status", "--profile", "two words", "literal;argument"];
      const result = fixture.run("y\n", args);
      expect(result.status, result.stdout + result.stderr).toBe(17);
      expect(result.stderr).toContain("Update NodeJS: Y/N");
      expect(result.stderr).toContain("Node.js updated. Retrying your command.");
      expect(result.stderr).not.toContain("legacy lifecycle loaded");
      const output = JSON.parse(result.stdout);
      expect(output).toEqual({
        args,
        cwd: fixture.root,
        path: [path.dirname(fixture.nodePath), process.env.PATH].join(path.delimiter),
        recovered: true,
      });
      expect(JSON.parse(await fs.readFile(fixture.installLog, "utf8"))).toEqual({
        command: process.platform === "darwin" ? "/bin/bash" : "bash",
        args: [
          path.join(fixture.root, "scripts", "install-cli.sh"),
          "--node-only",
          "--prefix",
          path.join(fixture.home, ".openclaw", "tools", "cli-node"),
        ],
      });
    });

    it.each(["n\n", "\n", "", "maybe\n", "^C", "\u0003"])(
      "does not install after decline or cancellation: %j",
      async (input) => {
        const fixture = await prepareRecovery();
        const result = fixture.run(input);
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain("Update NodeJS: Y/N");
        expect(result.stderr).toContain("nvm install");
        await expectAbsent(fixture.installLog);
        await expectAbsent(path.join(fixture.home, ".openclaw"));
      },
    );

    it.each<[string, boolean, string[], NodeJS.ProcessEnv]>([
      ["non-TTY", false, ["status"], {}],
      ["CI", true, ["status"], { CI: "1" }],
      ["JSON", true, ["status", "--json"], {}],
      ["non-interactive", true, ["onboard", "--non-interactive"], {}],
      ["yes flag", true, ["update", "--yes"], {}],
      ["hook relay", true, ["hooks", "relay"], {}],
      ["Gmail foreground", true, ["webhooks", "gmail", "run"], {}],
    ])("does not prompt or install for %s", async (_label, tty, args, env) => {
      const fixture = await prepareRecovery({ tty });
      const result = fixture.run("y\n", args, env);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).not.toContain("Update NodeJS:");
      await expectAbsent(fixture.installLog);
    });

    it.each(["failed", "invalid"] as const)(
      "does not retry after a %s installation",
      async (install) => {
        const fixture = await prepareRecovery({ install });
        const result = fixture.run("y\n");
        expectOutput(result, "", 1);
        expect(result.stderr).toContain("Node.js update failed");
      },
    );

    it("does not repeat a declined Node offer when update startup respawns", async () => {
      const fixture = await prepareRecovery({ version: "22.23.2" });
      await fs.writeFile(
        path.join(fixture.root, "dist", "entry.js"),
        `import { spawnSync } from "node:child_process";
        if (!process.env.OPENCLAW_TEST_CLI_RESPAWN) {
          const child = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
            env: { ...process.env, OPENCLAW_TEST_CLI_RESPAWN: "1" }, stdio: "inherit",
          });
          process.exit(child.status ?? 1);
        }
        process.stdout.write("update-entry\\n");`,
      );
      const result = fixture.run("n\n", ["update"]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("update-entry");
      expect(result.stderr.match(/Update NodeJS:/g)).toHaveLength(1);
      await expectAbsent(fixture.installLog);
    });

    it.each([
      { version: "24.22.1", broken: false },
      { version: "26.12.1", broken: true },
    ])(
      "admits pending lifecycle according to SQLite capability: $version",
      async ({ version, broken }) => {
        const fixture = await prepareRecovery({ version, tty: false, pendingLifecycle: true });
        const env: NodeJS.ProcessEnv = {};
        if (broken) {
          const preload = path.join(fixture.root, "broken-sqlite.mjs");
          await fs.writeFile(
            preload,
            'globalThis[Symbol.for("openclaw.sqliteCapabilities")] = { available: true, version: "3.53.4", text: false, blob: true, json: true };',
          );
          env.NODE_OPTIONS = `--import=${pathToFileURL(preload).href}`;
        } else {
          await fs.writeFile(
            path.join(fixture.root, "dist/infra/package-lifecycle.js"),
            'export function completePendingPackageLifecycle() { process.stdout.write("lifecycle-completed\\n"); }',
          );
        }
        const result = fixture.run("", ["update", "status"], env);
        expect(result.status, result.stderr).toBe(17);
        if (broken) {
          expect(result.stderr).not.toContain("legacy lifecycle loaded");
        } else {
          expect(result.stdout).toContain("lifecycle-completed");
          expect(result.stderr).not.toContain("diagnostics may show truncated text");
        }
      },
    );

    it("fails without another prompt when a retried command still has an unsupported runtime", async () => {
      const fixture = await prepareRecovery({ cached: true });
      // This preload runs even in the recovery child, unlike the ordinary fixture preload.
      const incompatible = path.join(fixture.root, "always-incompatible.mjs");
      await fs.writeFile(
        incompatible,
        'Object.defineProperty(process.versions, "node", { value: "20.0.0", configurable: true });',
      );
      const result = fixture.run("y\n", ["status"], {
        NODE_OPTIONS: `--import=${pathToFileURL(incompatible).href}`,
        OPENCLAW_NODE_UPDATE_RESPAWNED: "1",
      });
      expectOutput(result, "", 1);
      expect(result.stderr).not.toContain("Update NodeJS:");
      await expectAbsent(fixture.installLog);
    });
  });

  it("admits packaged diagnostics on unsupported Node", async () => {
    await writeEntry('process.stdout.write("diagnostic-entry\\n");');
    const result = await runPreloadedLauncher(
      'Object.defineProperty(process.versions, "node", { value: "22.23.2" });',
      ["update", "status"],
      { env: { HOME: root, OPENCLAW_HOME: root, NODE_DISABLE_COMPILE_CACHE: "1" } },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("diagnostic-entry\n");
  });

  it("admits compatible Node below the recommended security patches with lossless SQLite", async () => {
    await writeEntry('process.stdout.write("runtime-loaded\\n");\n');
    for (const version of ["24.15.9", "24.16.0", "24.22.0", "26.1.0"]) {
      const result = await runPreloadedLauncher(
        `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} });`,
        ["gateway", "start"],
      );

      if (version !== "24.15.9") {
        expect(result.status, version).toBe(0);
        expect(result.stdout, version).toContain("runtime-loaded");
      } else {
        expect(result.status, version).toBe(1);
        expect(result.stderr, version).toContain(
          `openclaw: Node ${version}: openclaw requires Node >=24.16.0 <25, or >=26.1.0`,
        );
      }
    }
  });

  it("prints recovery guidance before legacy-incompatible modules can load", async () => {
    const result = await runPreloadedLauncher(
      [
        "Object.defineProperty(Array.prototype, 'at', { value: undefined });",
        "Object.defineProperty(process.versions, 'node', { value: '20.0.0' });",
      ].join("\n"),
    );

    expectOutput(result, "", 1);
    expect(result.stderr).toContain("openclaw: Node 20.0.0:");
    expect(result.stderr).toContain("nvm install 26");
    expect(result.stderr).not.toContain("TypeError");
  });

  it("rejects Bun without node:sqlite even when its Node compatibility version is new enough", async () => {
    await writeEntry('process.stdout.write("unexpected-bun-runtime\\n");\n');
    const result = await runPreloadedLauncher(
      [
        "Object.defineProperty(process.versions, 'bun', { value: '1.3.14' });",
        "Object.defineProperty(process.versions, 'node', { value: '24.3.0' });",
        // Old Bun has no node:sqlite; the launcher feature-probes instead of
        // trusting the runtime label, so the mock must hide Node's builtin.
        "const realGetBuiltinModule = process.getBuiltinModule.bind(process);",
        "process.getBuiltinModule = (id) =>",
        "  id === 'node:sqlite' || id === 'sqlite' ? undefined : realGetBuiltinModule(id);",
      ].join("\n"),
      [],
      {},
      process.execPath,
    );

    expectOutput(result, "", 1);
    expect(result.stderr).toContain(
      "this Bun runtime is unsupported because it does not provide node:sqlite",
    );
  });

  it.each(["transitive", "missing", "unbuilt"])(
    "reports the %s entry failure without masking its cause",
    async (kind) => {
      if (kind === "transitive") {
        await writeEntry('import "missing-openclaw-launcher-dep";\nexport {};\n');
      } else if (kind === "unbuilt") {
        await addSourceTreeMarker();
      }
      const result = runLauncher(["--help"]);
      expect(result.status).not.toBe(0);
      if (kind === "transitive") {
        expect(result.stderr).toContain("missing-openclaw-launcher-dep");
        expect(result.stderr).not.toContain("missing dist/entry.(m)js");
      } else {
        expect(result.stderr).toContain("missing dist/entry.(m)js");
        if (kind === "unbuilt") {
          expect(result.stderr).toContain("unbuilt source tree or GitHub source archive");
          expect(result.stderr).toContain("pnpm install && pnpm build");
          expect(result.stderr).toContain("github:openclaw/openclaw#<ref>");
        }
      }
    },
  );

  it("executes an entry.mjs-only compiled entry through the root launcher", async () => {
    await writeFixture("dist/entry.mjs", 'process.stdout.write("mjs-entry");');
    expectOutput(runLauncher(), "mjs-entry");
  });

  it.runIf(process.env.OPENCLAW_TEST_BUN_LAUNCHER === "1" && hasBunRuntime())(
    "gates the real Bun runtime on node:sqlite availability",
    async () => {
      await writeEntry("process.stdout.write('bun entry ran\\n');\n");

      const bunBin = process.env.BUN_BIN ?? "bun";
      // Bun >=1.4 (Rust rewrite) ships node:sqlite and may run the CLI; older
      // Buns must be rejected before the entry loads.
      const probe = spawnSync(
        bunBin,
        ["-e", "process.exit(process.getBuiltinModule?.('node:sqlite') ? 0 : 1)"],
        { encoding: "utf8" },
      );
      const bunHasNodeSqlite = probe.status === 0;

      const result = runLauncher([], {}, bunBin);

      if (bunHasNodeSqlite) {
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("bun entry ran");
      } else {
        expectOutput(result, "", 1);
        expect(result.stderr).toContain(
          "this Bun runtime is unsupported because it does not provide node:sqlite",
        );
      }
    },
  );

  async function helpFixture(metadata: Record<string, unknown>, entry: string) {
    await writeFixture("dist/cli-startup-metadata.json", JSON.stringify(metadata));
    await writeEntry(entry);
  }

  it.each([
    {
      args: ["--help"],
      metadata: { rootHelpText: "PRECOMPUTED help\n" },
      expected: "PRECOMPUTED help\n",
    },
    {
      args: ["browser", "--help"],
      metadata: { browserHelpText: "PRECOMPUTED browser help\n" },
      expected: "PRECOMPUTED browser help\n",
    },
    {
      args: ["nodes", "--help"],
      metadata: { nodesHelpText: "PRECOMPUTED nodes help\n" },
      expected: "PRECOMPUTED nodes help\n",
    },
    {
      args: ["--log-level", "warn", "--no-color", "models", "-h"],
      metadata: { subcommandHelpText: { models: "PRECOMPUTED models help\n" } },
      expected: "PRECOMPUTED models help\n",
    },
  ])(
    "serves cached help without loading runtime owners: $args",
    async ({ args, metadata, expected }) => {
      await helpFixture(
        metadata,
        "throw new Error('help fast path must not import runtime resource owners');\n",
      );
      const result = runLauncher([...args]);
      expectOutput(result, expected);
    },
  );

  it.each([
    { args: ["tasks", "--help"], env: {}, echoArgs: false },
    ...[["--help"], ["nodes", "--help"]].map((args) => ({
      args,
      env: { OPENCLAW_PROFILE: "work" },
      echoArgs: false,
    })),
    ...[
      ["--profile", "work", "nodes", "--help"],
      ["--profile=work", "nodes", "--help"],
      ["--dev", "nodes", "--help"],
    ].map((args) => ({ args, env: {}, echoArgs: true })),
    ...[["models", "--help"], ["--help"]].map((args) => ({
      args,
      env: { OPENCLAW_CONTAINER: "demo" },
      echoArgs: false,
    })),
    ...[
      ["--container", "demo", "browser", "--help"],
      ["--container=demo", "browser", "--help"],
    ].map((args) => ({ args, env: {}, echoArgs: false })),
  ])("defers cached help to runtime dispatch: $args $env", async ({ args, env, echoArgs }) => {
    await helpFixture(
      {
        rootHelpText: "PRECOMPUTED root help\n",
        browserHelpText: "PRECOMPUTED browser help\n",
        nodesHelpText: "PRECOMPUTED nodes help\n",
        subcommandHelpText: { models: "PRECOMPUTED models help\n", tasks: "STALE Tasks help\n" },
      },
      echoArgs
        ? "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n"
        : "process.stdout.write('RUNTIME ENTRY\\n');\n",
    );
    const result = runLauncher([...args], { env });
    expectOutput(result, echoArgs ? JSON.stringify(args) : "RUNTIME ENTRY\n");
  });

  it.each(["explicit", "nodes", "home", "tilde", "legacy", "include"])(
    "consults the %s config before serving cached help",
    async (mode) => {
      await helpFixture(
        mode === "nodes"
          ? { nodesHelpText: "PRECOMPUTED nodes help\n" }
          : { rootHelpText: "PRECOMPUTED memory help\n" },
        "process.stdout.write('RUNTIME ENTRY\\n');\n",
      );
      const home = path.join(root, mode === "tilde" ? "home$&d" : "home");
      const configPath =
        mode === "home"
          ? path.join(home, ".openclaw", "openclaw.json")
          : mode === "tilde"
            ? path.join(home, "oc", ".openclaw", "openclaw.json")
            : mode === "legacy"
              ? path.join(home, ".clawdbot", "clawdbot.json")
              : path.join(root, "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify(
          mode === "include"
            ? { $include: "memory.json" }
            : mode === "nodes"
              ? { plugins: { entries: { canvas: { enabled: false } } } }
              : { plugins: { slots: { memory: "memory-lancedb" } } },
        ),
        "utf8",
      );
      const env =
        mode === "home"
          ? { OPENCLAW_HOME: home }
          : mode === "tilde"
            ? { HOME: home, OPENCLAW_HOME: "~/oc" }
            : mode === "legacy"
              ? { HOME: home, OPENCLAW_HOME: undefined }
              : { OPENCLAW_CONFIG_PATH: configPath };
      const result = runLauncher([...(mode === "nodes" ? ["nodes"] : []), "--help"], {
        env,
      });
      expectOutput(result, "RUNTIME ENTRY\n");
    },
  );

  it("resolves an empty requested cache relative to the temporary root, not cwd", async () => {
    const tmpRoot = fixtures.createTempDir("openclaw-launcher-tmp-");
    const cwd = fixtures.createTempDir("openclaw-launcher-cwd-");
    await writePackage("2026.4.29");
    await writeEntry(
      'import module from "node:module"; process.stdout.write(module.getCompileCacheDir?.() ?? "cache:disabled");',
    );
    const result = runLauncher([], {
      cwd,
      env: { NODE_COMPILE_CACHE: "", TMP: tmpRoot, TEMP: tmpRoot, TMPDIR: tmpRoot },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(path.join("node-compile-cache", "openclaw", "2026.4.29"));
    expect(result.stdout).not.toContain(path.join(cwd, "openclaw"));
  });

  it.runIf(process.platform !== "win32").each(["cooperative", "ignored"])(
    "settles SIGTERM shutdown when the respawn child is %s",
    async (mode) => {
      const signalPath = path.join(root, "sigterm-received.txt");
      await withRespawnChild(
        {
          entry: (childInfoPath) =>
            [
              'import { writeFileSync } from "node:fs";',
              'process.title = "openclaw-launcher-sigterm-test-child";',
              mode === "cooperative"
                ? `process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(signalPath)}, "SIGTERM\\n"); process.exit(0); });`
                : 'process.on("SIGTERM", () => {});',
              `writeFileSync(${JSON.stringify(childInfoPath)}, JSON.stringify({ pid: process.pid }) + "\\n");`,
              "setInterval(() => {}, 1000);",
              "",
            ].join("\n"),
        },
        async ({ launcher, pid }) => {
          launcher.kill("SIGTERM");
          await expect(waitForProcessClose(launcher, "launcher", 5000)).resolves.toEqual({
            code: mode === "cooperative" ? 0 : null,
            signal: mode === "cooperative" ? null : "SIGKILL",
          });
          if (mode === "cooperative") {
            await expect(fs.readFile(signalPath, "utf8")).resolves.toBe("SIGTERM\n");
          } else {
            expect(isProcessAlive(launcher.pid)).toBe(false);
          }
          expect(isProcessAlive(pid)).toBe(false);
        },
      );
    },
  );

  it.runIf(process.platform !== "win32").each([
    { signal: "SIGINT" as const, target: "launcher" },
    { signal: "SIGTERM" as const, target: "launcher" },
    { signal: "SIGKILL" as const, target: "child" },
  ])(
    "propagates $signal after output closes when the respawn $target is signaled",
    async (testCase) => {
      const expectedOutput = "signal-output\n".repeat(32 * 1024);
      await withRespawnChild(
        {
          pipe: true,
          entry: (childInfoPath) =>
            [
              'import { writeFileSync } from "node:fs";',
              `process.stdout.write(${JSON.stringify(expectedOutput)}, () => writeFileSync(${JSON.stringify(childInfoPath)}, JSON.stringify({ pid: process.pid })));`,
              'process.title = "openclaw-launcher-default-signal-test-child";',
              "setInterval(() => {}, 1000);",
              "",
            ].join("\n"),
        },
        async ({ launcher, pid, output }) => {
          if (testCase.target === "launcher") {
            launcher.kill(testCase.signal);
          } else {
            process.kill(pid, testCase.signal);
          }

          await expect(waitForProcessClose(launcher, "launcher", 5000)).resolves.toEqual({
            code: null,
            signal: testCase.signal,
          });
          expect(output()).toBe(expectedOutput);
          expect(isProcessAlive(pid)).toBe(false);
        },
      );
    },
  );

  it("preserves an explicit exit 143 from a compile-cache respawn child", async () => {
    await addGitMarker();
    await writeEntry(
      'process.stdout.write(process.env.OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED ?? "0", () => process.exit(143));\n',
    );

    const result = runLauncher([], {
      env: { NODE_COMPILE_CACHE: path.join(root, ".node-compile-cache") },
    });

    expectOutput(result, "1", 143);
    expect(result.signal).toBeNull();
  });

  it.runIf(process.platform !== "win32")(
    "respawns symlinked source-checkout launchers without inherited NODE_COMPILE_CACHE",
    async () => {
      await addGitMarker();
      await addCompileCacheProbe();
      const linkParent = fixtures.createTempDir("openclaw-launcher-link-");
      await fs.appendFile(
        path.join(root, "dist", "entry.js"),
        '\nprocess.stdout.write("\\n" + process.argv[1]);\n',
      );
      for (const prefix of ["invoked", "on-path"]) {
        const linkRoot = path.join(linkParent, prefix);
        await fs.mkdir(path.join(linkRoot, "lib", "node_modules"), { recursive: true });
        await fs.mkdir(path.join(linkRoot, "bin"));
        await fs.symlink(root, path.join(linkRoot, "lib", "node_modules", "openclaw"), "dir");
        await fs.symlink(
          "../lib/node_modules/openclaw/openclaw.mjs",
          path.join(linkRoot, "bin", "openclaw"),
        );
      }
      const launcher = path.join(linkParent, "invoked", "bin", "openclaw");

      const result = spawnSync(process.execPath, [launcher], {
        cwd: linkParent,
        env: launcherEnv({
          NODE_COMPILE_CACHE: path.join(linkParent, ".node-compile-cache"),
          PATH: [path.join(linkParent, "on-path", "bin"), process.env.PATH].join(path.delimiter),
        }),
        encoding: "utf8",
      });

      expectOutput(result, `cache:disabled;respawn:1\n${launcher}`);
    },
  );

  it.each([
    ["source", "import"],
    ["packaged", "import"],
    ["source", "preload-with-entry"],
    ["packaged", "preload-with-entry"],
    ["source", "preload-without-entry"],
    ["packaged", "preload-without-entry"],
  ] as const)("a %s cli-entry %s restarts the actual launcher", async (kind, invocation) => {
    await writePackage("2026.8.1", true);
    if (kind === "source") {
      await addSourceTreeMarker();
    }
    await writeEntry(
      [
        'import module from "node:module";',
        "process.stdout.write(JSON.stringify({",
        "  launcher: process.argv[1],",
        "  args: process.argv.slice(2),",
        '  cache: module.getCompileCacheDir?.() ? "enabled" : "disabled",',
        '  sourceRespawn: process.env.OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED ?? "0",',
        '  packagedRespawn: process.env.OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED ?? "0",',
        "}));",
      ].join("\n"),
    );
    const hostMarker = path.join(root, "host-executions.txt");
    const host = path.join(root, "host.mjs");
    if (invocation !== "preload-without-entry") {
      await fs.writeFile(
        host,
        invocation === "import"
          ? [
              'import fs from "node:fs";',
              `fs.appendFileSync(${JSON.stringify(hostMarker)}, "host\\n");`,
              'await import("openclaw/cli-entry");',
            ].join("\n")
          : 'await import("openclaw/cli-entry");',
      );
    }
    const args =
      invocation === "import"
        ? [host, "proof-argument"]
        : invocation === "preload-with-entry"
          ? ["--import", "openclaw/cli-entry", host, "proof-argument"]
          : ["--import", "openclaw/cli-entry"];
    const result = runNode(
      args,
      { env: { NODE_COMPILE_CACHE: path.join(root, ".node-compile-cache") } },
      testNodeExecPath,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      launcher: path.join(root, "openclaw.mjs"),
      args: invocation === "preload-without-entry" ? [] : ["proof-argument"],
      cache: kind === "source" ? "disabled" : "enabled",
      sourceRespawn: kind === "source" ? "1" : "0",
      packagedRespawn: kind === "packaged" ? "1" : "0",
    });
    if (invocation === "import") {
      expect(await fs.readFile(hostMarker, "utf8")).toBe("host\n");
    }
  });

  it.runIf(process.platform !== "win32")(
    "does not respawn native hook relays for packaged compile-cache scoping",
    async () => {
      await writePackage("2026.4.29");
      await writeEntry(
        'process.stdout.write(process.env.OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED ?? "0");\n',
      );

      const result = runLauncher(["hooks", "relay"], {
        env: {
          NODE_COMPILE_CACHE: path.join(root, ".node-compile-cache"),
        },
      });

      expectOutput(result, "0");
    },
  );

  it.each(["denied writes", "denied workers", "denied replacement", "unrestricted"] as const)(
    "keeps packaged cache maintenance within Node permissions: %s",
    async (mode) => {
      const cache = path.join(root, "cache");
      const retired = path.join(cache, "openclaw", "old", "build-retired");
      const expiredEntry = path.join(retired, "sentinel");
      await fs.mkdir(retired, { recursive: true });
      await fs.writeFile(expiredEntry, "preserve restricted cache");
      const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      const directory = await seedCache(cache);
      await fs.utimes(expiredEntry, expired, expired);
      await fs.utimes(path.join(cache, "openclaw"), expired, expired);
      const preload = path.join(root, "observe-maintenance.mjs");
      await fs.writeFile(
        preload,
        maintenanceObserver("globalThis.maintenanceStarts = 0;", "globalThis.maintenanceStarts++;"),
      );
      await writeEntry(
        `
        if (!process.permission) {
          await globalThis.maintenanceStarted;
          await globalThis.maintenanceCompleted;
        }
        process.stdout.write(JSON.stringify({ maintenanceStarts: globalThis.maintenanceStarts }));
      `,
      );
      const permissionArgs =
        mode === "unrestricted"
          ? []
          : [
              "--permission",
              "--allow-fs-read=*",
              ...(mode === "denied writes" ? ["--allow-worker"] : [`--allow-fs-write=${root}`]),
            ];
      const result = runNode(
        [
          ...permissionArgs,
          "--import",
          pathToFileURL(preload).href,
          path.join(root, "openclaw.mjs"),
        ],
        {
          env: {
            NODE_OPTIONS: undefined,
            NODE_COMPILE_CACHE: mode === "denied replacement" ? cache : directory,
            OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED:
              mode === "denied replacement" ? undefined : "1",
          },
          timeout: 5000,
        },
        testNodeExecPath,
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      if (mode === "unrestricted") {
        expect(JSON.parse(result.stdout).maintenanceStarts).toBeGreaterThan(0);
        await expectAbsent(expiredEntry);
      } else {
        expect(JSON.parse(result.stdout).maintenanceStarts).toBe(0);
        expect(await fs.readFile(path.join(retired, "sentinel"), "utf8")).toBe(
          "preserve restricted cache",
        );
      }
    },
  );

  it.each(["execArgv", "NODE_OPTIONS"] as const)(
    "does not replay a packaged CLI preload in detached maintenance via %s",
    async (source) => {
      await writePackage("2026.9.1", true);
      const log = path.join(root, "preload-events.jsonl");
      const preload = path.join(root, "observe-preload.mjs");
      await fs.writeFile(
        preload,
        maintenanceObserver(
          `import fs from "node:fs";
        const record = event => fs.appendFileSync(${JSON.stringify(log)}, event + "\\n");
        record("preload");`,
          'record("maintenance");',
        ),
      );
      await writeEntry(
        `
        import fs from "node:fs";
        await globalThis.maintenanceStarted;
        await globalThis.maintenanceCompleted;
        fs.appendFileSync(${JSON.stringify(log)}, "entry\\n");
      `,
      );
      const host = path.join(root, "host.mjs");
      await fs.writeFile(host, "");
      const cache = path.join(root, "cache");
      const directory = await seedCache(cache);
      await fs.utimes(path.join(cache, "openclaw"), new Date(0), new Date(0));
      const preloads = ["--import", pathToFileURL(preload).href, "--import", "openclaw/cli-entry"];
      const result = runNode(
        [...(source === "execArgv" ? preloads : []), host],
        {
          env: {
            NODE_OPTIONS: source === "NODE_OPTIONS" ? preloads.join(" ") : undefined,
            NODE_COMPILE_CACHE: directory,
            OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED: "1",
          },
          timeout: 5000,
        },
        testNodeExecPath,
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect((await fs.readFile(log, "utf8")).trim().split("\n")).toEqual([
        "preload",
        "maintenance",
        "entry",
      ]);
    },
  );

  it("prunes an oversized cache after the packaged command exits", async () => {
    const cache = path.join(root, "cache");
    const directory = await seedCache(cache);
    const bytecode = path.join(directory, "oversized");
    const handle = await fs.open(bytecode, "w");
    await handle.truncate(600 * 1024 * 1024);
    await handle.close();
    await fs.utimes(path.join(cache, "openclaw"), new Date(0), new Date(0));
    const cacheModule = path.join(root, "node-compile-cache.mjs");
    const completedPath = path.join(root, "completed");
    const original = await fs.readFile(cacheModule, "utf8");
    // The maintenance child cannot prune until its launching CLI has exited.
    await fs.writeFile(
      cacheModule,
      `
      import fixtureFs from "node:fs/promises";
      import { once as fixtureOnce } from "node:events";
      if (process.argv[2] === "--maintain") {
        process.send("started");
        await fixtureOnce(process, "disconnect");
        const rmdir = fixtureFs.rmdir;
        fixtureFs.rmdir = async target => {
          await rmdir(target);
          await fixtureFs.writeFile(${JSON.stringify(completedPath)}, JSON.stringify("done"));
        };
      }
      ${original}
    `,
    );
    const preload = path.join(root, "observe-detached.mjs");
    await fs.writeFile(
      preload,
      `
      import cp from "node:child_process";
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      let started;
      globalThis.maintenanceStarted = new Promise(resolve => { started = resolve; });
      const originalSpawn = cp.spawn;
      cp.spawn = function(command, args, options) {
        if (!args.includes("--maintain")) return originalSpawn(command, args, options);
        const child = originalSpawn(command, args, { ...options, stdio: ["ignore", "ignore", "ignore", "ipc"] });
        fs.writeFileSync(${JSON.stringify(path.join(root, "child-pid"))}, String(child.pid));
        child.once("message", () => { child.channel.unref(); started(); });
        return child;
      };
      syncBuiltinESMExports();
    `,
    );
    await writeEntry(
      `
      await globalThis.maintenanceStarted;
      process.stdout.write("command-completed");
    `,
    );
    try {
      const result = runNode(
        ["--import", pathToFileURL(preload).href, path.join(root, "openclaw.mjs")],
        {
          env: {
            NODE_OPTIONS: undefined,
            NODE_COMPILE_CACHE: directory,
            OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED: "1",
          },
          timeout: 5000,
        },
        testNodeExecPath,
      );
      expect(result.error).toBeUndefined();
      expectOutput(result, "command-completed");
      // The detached child can finish during spawnSync; filesystem notifications
      // may be lost while this process is blocked, so observe its persisted result.
      expect(await waitForJsonFile<string>(completedPath, 5000)).toBe("done");
      await expectAbsent(bytecode);
      expect((await fs.stat(path.join(cache, "openclaw"))).mtimeMs).toBeGreaterThan(0);
    } finally {
      if (!(await fs.stat(completedPath).catch(() => undefined))) {
        const pid = await fs.readFile(path.join(root, "child-pid"), "utf8").catch(() => "");
        if (pid) {
          try {
            process.kill(Number(pid));
          } catch {
            /* Already exited. */
          }
        }
      }
    }
  });

  it.each([
    "owned",
    "inherited",
    "inherited-windows",
    "direct",
    "foreign",
    "source",
    "disabled-zero",
    "disabled-empty",
    "cache-empty",
  ])("keeps Gateway main uncached and shares the worker cache base: %s", async (mode) => {
    const tmpRoot = fixtures.createTempDir("openclaw-launcher-cache-");
    await writePackage("2026.9.6");
    if (mode === "source") {
      await addGitMarker();
    }
    // Separate compiled copies exercise the same cross-chunk boundary as runtime
    // entry/worker consumers, without reading or seeding a private owner slot.
    for (const [entryPoint, name, exportName] of [
      ["src/infra/node-compile-cache-env.ts", "cache-a.mjs", "resolveNodeCompileCacheEnv"],
      ["src/infra/node-compile-cache-env.ts", "cache-b.mjs", "resolveNodeCompileCacheEnv"],
      ["src/entry.compile-cache.ts", "cache-owner.mjs", "enableOpenClawCompileCache"],
    ] as const) {
      await esbuild({
        bundle: true,
        stdin: {
          contents: `export { ${exportName} } from ${JSON.stringify(path.resolve(entryPoint))};`,
          resolveDir: process.cwd(),
          sourcefile: "compile-cache-owner-fixture.ts",
          loader: "ts",
        },
        format: "esm",
        outfile: path.join(root, "dist", name),
        platform: "node",
        target: "node24",
      });
    }
    await writeEntry(
      `import assert from "node:assert/strict";
         import { getCompileCacheDir } from "node:module";
         import { Worker } from "node:worker_threads";
         import { once } from "node:events";
         import { resolveNodeCompileCacheEnv as resolveA } from "./cache-a.mjs";
         import { resolveNodeCompileCacheEnv as resolveB } from "./cache-b.mjs";
         import { enableOpenClawCompileCache } from "./cache-owner.mjs";
         const before = { ...process.env };
         // Direct entry and launcher consumers share the same worker cache owner.
         enableOpenClawCompileCache({ currentFile: ${JSON.stringify(path.join(root, mode === "source" ? "src/entry.ts" : "dist/entry.js"))}, installRoot: ${JSON.stringify(root)} });
         const parentDirectory = getCompileCacheDir() ?? null;
         const a = resolveA();
         const b = resolveB();
         assert.deepEqual(a, b, "separate built helpers must share the launcher fact");
         const cachedWorkers = ["owned", "inherited", "inherited-windows", "direct", "source"].includes(${JSON.stringify(mode)});
         if (cachedWorkers) {
           assert.equal(parentDirectory, null);
           assert.ok(a.NODE_COMPILE_CACHE);
           process.on("exit", () => assert.equal(getCompileCacheDir(), undefined));
         } else if (${JSON.stringify(mode)} === "foreign") {
           assert.ok(parentDirectory);
           assert.equal(process.env.NODE_COMPILE_CACHE, undefined);
           assert.equal(process.env.OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED, "1");
           assert.strictEqual(a, process.env, "foreign first enable has no owned base");
         } else {
           assert.strictEqual(a, process.env, "authored policy or absent ownership wins");
         }
         const worker = new Worker(
           'const { parentPort } = require("node:worker_threads"); parentPort.postMessage(require("node:module").getCompileCacheDir() ?? null);',
           { eval: true, execArgv: [], env: b },
         );
         const exited = once(worker, "exit");
         const [directory] = await once(worker, "message");
         const [code] = await exited;
         assert.equal(code, 0);
         if (cachedWorkers) {
           assert.ok(directory);
           assert.ok(directory.startsWith(a.NODE_COMPILE_CACHE));
         } else {
           assert.equal(directory, null);
         }
         assert.deepEqual({ ...process.env }, before);
         process.stdout.write("cache-base:verified");`,
    );
    const args = [
      path.join(root, mode === "direct" ? "dist/entry.js" : "openclaw.mjs"),
      ...(mode === "foreign" ? ["status"] : ["gateway", "run"]),
    ];
    if (mode === "foreign") {
      const preload = path.join(root, "foreign.mjs");
      await fs.writeFile(
        preload,
        `import assert from "node:assert/strict";
           import { enableCompileCache, constants } from "node:module";
           assert.equal(enableCompileCache(${JSON.stringify(path.join(tmpRoot, "foreign"))}).status,
             constants.compileCacheStatus.ENABLED);`,
      );
      args.unshift("--import", pathToFileURL(preload).href);
    }
    if (mode === "inherited-windows") {
      const preload = path.join(root, "windows-execve.mjs");
      await fs.writeFile(
        preload,
        `Object.defineProperty(process, "platform", { value: "win32" });
         process.execve = () => { throw new Error("ERR_FEATURE_UNAVAILABLE_ON_PLATFORM"); };`,
      );
      args.unshift("--import", pathToFileURL(preload).href);
    }
    const result = runNode(
      args,
      {
        env: {
          HOME: tmpRoot,
          TMP: tmpRoot,
          TEMP: tmpRoot,
          TMPDIR: tmpRoot,
          NODE_OPTIONS: undefined,
          NODE_DISABLE_COMPILE_CACHE:
            mode === "disabled-zero" ? "0" : mode === "disabled-empty" ? "" : undefined,
          NODE_COMPILE_CACHE:
            mode === "cache-empty"
              ? ""
              : mode === "inherited" || mode === "inherited-windows"
                ? path.join(tmpRoot, "inherited")
                : undefined,
          // This negative control must retain its foreign first enable in the same
          // Node instance; all ordinary launch modes scrub inherited sentinels.
          OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED: mode === "foreign" ? "1" : undefined,
          OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED: undefined,
        },
        timeout: 10_000,
      },
      testNodeExecPath,
    );
    expectOutput(result, "cache-base:verified");
  });
});
