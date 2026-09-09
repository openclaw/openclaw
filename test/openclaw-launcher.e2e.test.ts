// OpenClaw launcher E2E tests validate launcher process behavior.
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build as esbuild } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { isSupportedOpenClawNodeVersion } from "../node-version.mjs";
import { NODE_RELEASE_VERSION_CASES } from "./helpers/node-version-cases.js";
import { cleanupTempDirs, makeTempDir } from "./helpers/temp-dir.js";

async function makeLauncherFixture(fixtureRoots: string[]): Promise<string> {
  const fixtureRoot = makeTempDir(fixtureRoots, "openclaw-launcher-");
  await fs.copyFile(
    path.resolve(process.cwd(), "openclaw.mjs"),
    path.join(fixtureRoot, "openclaw.mjs"),
  );
  await fs.copyFile(
    path.resolve(process.cwd(), "node-version.mjs"),
    path.join(fixtureRoot, "node-version.mjs"),
  );
  await fs.copyFile(
    path.resolve(process.cwd(), "node-runtime-update.mjs"),
    path.join(fixtureRoot, "node-runtime-update.mjs"),
  );
  await fs.mkdir(path.join(fixtureRoot, "dist"), { recursive: true });
  return fixtureRoot;
}

async function addCompiledMjsEntryFixture(fixtureRoot: string): Promise<void> {
  const sourceRoot = path.resolve(process.cwd(), "src");
  await esbuild({
    bundle: true,
    entryPoints: [path.join(sourceRoot, "entry.ts")],
    format: "esm",
    outfile: path.join(fixtureRoot, "dist", "entry.mjs"),
    platform: "node",
    plugins: [
      {
        name: "external-source-imports",
        setup(build) {
          build.onResolve({ filter: /^\./ }, ({ path: specifier, resolveDir }) => ({
            external: true,
            path: path.resolve(resolveDir, specifier.replace(/\.js$/u, ".ts")),
          }));
        },
      },
    ],
    target: "node22",
  });
}

async function addSourceTreeMarker(fixtureRoot: string): Promise<void> {
  await fs.mkdir(path.join(fixtureRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(fixtureRoot, "src", "entry.ts"), "export {};\n", "utf8");
}

async function addGitMarker(fixtureRoot: string): Promise<void> {
  await fs.writeFile(path.join(fixtureRoot, ".git"), "gitdir: .git/worktrees/openclaw\n", "utf8");
}

async function addCompileCacheProbe(fixtureRoot: string): Promise<void> {
  await fs.writeFile(
    path.join(fixtureRoot, "dist", "entry.js"),
    [
      'import module from "node:module";',
      "process.stdout.write(",
      '  `${module.getCompileCacheDir?.() ? "cache:enabled" : "cache:disabled"};respawn:${process.env.OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED ?? "0"}`',
      ");",
    ].join("\n"),
    "utf8",
  );
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

async function waitForProcessExit(
  child: ReturnType<typeof spawn>,
  label: string,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }

  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const [code, exitSignal] = (await once(child, "exit", { signal })) as [
      number | null,
      NodeJS.Signals | null,
    ];
    return { code, signal: exitSignal };
  } catch (error) {
    throw new Error(`timed out waiting for ${label} to exit`, { cause: error });
  }
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
  const fixtureRoots: string[] = [];

  afterEach(async () => {
    cleanupTempDirs(fixtureRoots);
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
      const root = await makeLauncherFixture(fixtureRoots);
      const home = path.join(root, "home with spaces");
      const nodePath = path.join(
        home,
        ".openclaw",
        "tools",
        "cli-node",
        "tools",
        "node",
        "bin",
        "node",
      );
      await fs.mkdir(home);
      if (params.cached) {
        await fs.mkdir(path.dirname(nodePath), { recursive: true });
        await fs.symlink(process.execPath, nodePath);
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
          Object.defineProperty(process.stdin, "isTTY", { value: ${params.tty ?? true} });
          Object.defineProperty(process.stderr, "isTTY", { value: ${params.tty ?? true} });
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
      await fs.writeFile(
        path.join(root, "dist", "entry.js"),
        `
        process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), path: process.env.PATH }));
        process.exitCode = 17;
      `,
      );
      if (params.pendingLifecycle) {
        await fs.writeFile(path.join(root, ".openclaw-lifecycle-pending"), "");
        await fs.mkdir(path.join(root, "dist", "infra"));
        await fs.writeFile(
          path.join(root, "dist", "infra", "package-lifecycle.js"),
          'if (process.env.OPENCLAW_NODE_UPDATE_RESPAWNED !== "1") throw new Error("legacy lifecycle loaded"); export function completePendingPackageLifecycle() {}',
        );
      }
      const run = (input: string, args = ["status"], env: NodeJS.ProcessEnv = {}) =>
        spawnSync(
          process.execPath,
          ["--import", pathToFileURL(preload).href, path.join(root, "openclaw.mjs"), ...args],
          {
            cwd: root,
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
        path: expect.any(String),
      });
      expect(output.path.split(path.delimiter)[0]).toBe(path.dirname(fixture.nodePath));
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

    it.each(["n\n", "\n", "", "maybe\n", "\u0003"])(
      "does not install after decline or cancellation: %j",
      async (input) => {
        const fixture = await prepareRecovery();
        const result = fixture.run(input);
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain("Update NodeJS: Y/N");
        expect(result.stderr).toContain("nvm install");
        await expect(fs.stat(fixture.installLog)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(path.join(fixture.home, ".openclaw"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
    );

    it.each([
      { label: "non-TTY", tty: false, args: ["status"], env: {} },
      { label: "CI", tty: true, args: ["status"], env: { CI: "1" } },
      { label: "JSON", tty: true, args: ["status", "--json"], env: {} },
      { label: "non-interactive", tty: true, args: ["onboard", "--non-interactive"], env: {} },
      { label: "yes flag", tty: true, args: ["update", "--yes"], env: {} },
      { label: "hook relay", tty: true, args: ["hooks", "relay"], env: {} },
      { label: "Gmail foreground", tty: true, args: ["webhooks", "gmail", "run"], env: {} },
    ])("does not prompt or install for $label", async ({ tty, args, env }) => {
      const fixture = await prepareRecovery({ tty });
      const result = fixture.run("y\n", args, env);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).not.toContain("Update NodeJS:");
      await expect(fs.stat(fixture.installLog)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it.each(["failed", "invalid"] as const)(
      "does not retry after a %s installation",
      async (install) => {
        const fixture = await prepareRecovery({ install });
        const result = fixture.run("y\n");
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain("Node.js update failed");
        expect(result.stdout).toBe("");
      },
    );

    it("reuses a previously approved runtime without prompting or installing", async () => {
      const fixture = await prepareRecovery({ cached: true, tty: false });
      const result = fixture.run("");
      expect(result.status, result.stderr).toBe(17);
      expect(result.stderr).not.toContain("Update NodeJS:");
      expect(JSON.parse(result.stdout).path.split(path.delimiter)[0]).toBe(
        path.dirname(fixture.nodePath),
      );
      await expect(fs.stat(fixture.installLog)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("keeps a supported active Node even when a private runtime exists", async () => {
      const fixture = await prepareRecovery({ cached: true, version: process.versions.node });
      const result = fixture.run("");
      expect(result.status, result.stderr).toBe(17);
      expect(result.stderr).not.toContain("Node.js");
      expect(JSON.parse(result.stdout).path.split(path.delimiter)[0]).not.toBe(
        path.dirname(fixture.nodePath),
      );
      await expect(fs.stat(fixture.installLog)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("rejects an incompatible cached runtime without falling into a respawn loop", async () => {
      const fixture = await prepareRecovery();
      await fs.mkdir(path.dirname(fixture.nodePath), { recursive: true });
      await fs.writeFile(fixture.nodePath, "#!/bin/sh\necho 20.0.0\n", { mode: 0o755 });
      const result = fixture.run("n\n");
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr.match(/Update NodeJS:/g)).toHaveLength(1);
      expect(result.stdout).toBe("");
      await expect(fs.stat(fixture.installLog)).rejects.toMatchObject({ code: "ENOENT" });
    });

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
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).not.toContain("Update NodeJS:");
      expect(result.stdout).toBe("");
      await expect(fs.stat(fixture.installLog)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("keeps the bootstrap Node range aligned with the package engine", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      'process.stdout.write("runtime-loaded\\n");\n',
      "utf8",
    );

    for (const version of NODE_RELEASE_VERSION_CASES) {
      const mockNodeVersionPath = path.join(fixtureRoot, `mock-node-version-${version}.mjs`);
      await fs.writeFile(
        mockNodeVersionPath,
        [
          "Object.defineProperty(process.versions, 'node', {",
          `  value: ${JSON.stringify(version)},`,
          "});",
        ].join("\n"),
        "utf8",
      );

      const result = spawnSync(
        process.execPath,
        [
          "--import",
          pathToFileURL(mockNodeVersionPath).href,
          path.join(fixtureRoot, "openclaw.mjs"),
          "--help",
        ],
        {
          cwd: fixtureRoot,
          env: launcherEnv(),
          encoding: "utf8",
        },
      );

      if (isSupportedOpenClawNodeVersion(version)) {
        expect(result.status, version).toBe(0);
        expect(result.stdout, version).toContain("runtime-loaded");
      } else {
        expect(result.status, version).toBe(1);
        expect(result.stderr, version).toContain(
          `openclaw: Node.js >=24.16.0 <25, or >=26.1.0 is required (current: v${version}).`,
        );
      }
    }
  });

  it("prints recovery guidance before legacy-incompatible modules can load", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    const legacyRuntimePath = path.join(fixtureRoot, "mock-legacy-runtime.mjs");
    await fs.writeFile(
      legacyRuntimePath,
      [
        "Object.defineProperty(Array.prototype, 'at', { value: undefined });",
        "Object.defineProperty(process.versions, 'node', { value: '20.0.0' });",
      ].join("\n"),
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(legacyRuntimePath).href, path.join(fixtureRoot, "openclaw.mjs")],
      {
        cwd: fixtureRoot,
        env: launcherEnv(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "openclaw: Node.js >=24.16.0 <25, or >=26.1.0 is required (current: v20.0.0).",
    );
    expect(result.stderr).toContain("nvm install 26");
    expect(result.stderr).not.toContain("TypeError");
  });

  it("rejects Bun without node:sqlite even when its Node compatibility version is new enough", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      'process.stdout.write("unexpected-bun-runtime\\n");\n',
      "utf8",
    );
    const mockRuntime = path.join(fixtureRoot, "mock-bun-runtime.mjs");
    await fs.writeFile(
      mockRuntime,
      [
        "Object.defineProperty(process.versions, 'bun', { value: '1.3.14' });",
        "Object.defineProperty(process.versions, 'node', { value: '24.3.0' });",
        // Old Bun has no node:sqlite; the launcher feature-probes instead of
        // trusting the runtime label, so the mock must hide Node's builtin.
        "const realGetBuiltinModule = process.getBuiltinModule.bind(process);",
        "process.getBuiltinModule = (id) =>",
        "  id === 'node:sqlite' || id === 'sqlite' ? undefined : realGetBuiltinModule(id);",
      ].join("\n"),
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(mockRuntime).href, path.join(fixtureRoot, "openclaw.mjs")],
      {
        cwd: fixtureRoot,
        env: launcherEnv(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "this Bun runtime is unsupported because it does not provide node:sqlite",
    );
  });

  it("surfaces transitive entry import failures instead of masking them as missing dist", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      'import "missing-openclaw-launcher-dep";\nexport {};\n',
      "utf8",
    );

    const result = spawnSync(process.execPath, [path.join(fixtureRoot, "openclaw.mjs"), "--help"], {
      cwd: fixtureRoot,
      env: launcherEnv(),
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing-openclaw-launcher-dep");
    expect(result.stderr).not.toContain("missing dist/entry.(m)js");
  });

  it("keeps the friendly launcher error for a truly missing entry build output", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);

    const result = spawnSync(process.execPath, [path.join(fixtureRoot, "openclaw.mjs"), "--help"], {
      cwd: fixtureRoot,
      env: launcherEnv(),
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing dist/entry.(m)js");
  });

  it("executes an entry.mjs-only compiled entry through the root launcher", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    await addCompiledMjsEntryFixture(fixtureRoot);

    const result = spawnSync(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), path.join(fixtureRoot, "openclaw.mjs"), "--profile"],
      {
        cwd: process.cwd(),
        env: launcherEnv({ OPENCLAW_NO_RESPAWN: "1" }),
        encoding: "utf8",
      },
    );

    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--profile requires a value");
  });

  it.runIf(process.env.OPENCLAW_TEST_BUN_LAUNCHER === "1" && hasBunRuntime())(
    "gates the real Bun runtime on node:sqlite availability",
    async () => {
      const fixtureRoot = await makeLauncherFixture(fixtureRoots);
      await fs.writeFile(
        path.join(fixtureRoot, "dist", "entry.js"),
        "process.stdout.write('bun entry ran\\n');\n",
        "utf8",
      );

      const bunBin = process.env.BUN_BIN ?? "bun";
      // Bun >=1.4 (Rust rewrite) ships node:sqlite and may run the CLI; older
      // Buns must be rejected before the entry loads.
      const probe = spawnSync(
        bunBin,
        ["-e", "process.exit(process.getBuiltinModule?.('node:sqlite') ? 0 : 1)"],
        { encoding: "utf8" },
      );
      const bunHasNodeSqlite = probe.status === 0;

      const result = spawnSync(bunBin, [path.join(fixtureRoot, "openclaw.mjs")], {
        cwd: fixtureRoot,
        env: launcherEnv(),
        encoding: "utf8",
      });

      if (bunHasNodeSqlite) {
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("bun entry ran");
      } else {
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(
          "this Bun runtime is unsupported because it does not provide node:sqlite",
        );
      }
    },
  );

  it("uses precomputed root help when plugin config does not invalidate it", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "cli-startup-metadata.json"),
      JSON.stringify({ rootHelpText: "PRECOMPUTED help\n" }),
      "utf8",
    );
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      "throw new Error('root help fast path must not import runtime resource owners');\n",
      "utf8",
    );

    const result = spawnSync(process.execPath, [path.join(fixtureRoot, "openclaw.mjs"), "--help"], {
      cwd: fixtureRoot,
      env: launcherEnv(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("PRECOMPUTED help\n");
  });

  it.each([
    { command: "browser", metadataKey: "browserHelpText" },
    { command: "secrets", metadataKey: "secretsHelpText" },
    { command: "nodes", metadataKey: "nodesHelpText" },
  ])("uses precomputed $command help before loading the runtime entry", async (params) => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "cli-startup-metadata.json"),
      JSON.stringify({ [params.metadataKey]: `PRECOMPUTED ${params.command} help\n` }),
      "utf8",
    );
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      "throw new Error('command help fast path must not import runtime resource owners');\n",
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      [path.join(fixtureRoot, "openclaw.mjs"), params.command, "--help"],
      {
        cwd: fixtureRoot,
        env: launcherEnv(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`PRECOMPUTED ${params.command} help\n`);
  });

  it.each(["config", "doctor", "gateway", "models", "plugins", "sessions", "tasks"])(
    "uses precomputed %s help before loading the runtime entry",
    async (command) => {
      const fixtureRoot = await makeLauncherFixture(fixtureRoots);
      await fs.writeFile(
        path.join(fixtureRoot, "dist", "cli-startup-metadata.json"),
        JSON.stringify({ subcommandHelpText: { [command]: `PRECOMPUTED ${command} help\n` } }),
        "utf8",
      );
      await fs.writeFile(
        path.join(fixtureRoot, "dist", "entry.js"),
        "throw new Error('subcommand help fast path must not import runtime resource owners');\n",
        "utf8",
      );

      const result = spawnSync(
        process.execPath,
        [path.join(fixtureRoot, "openclaw.mjs"), command, "--help"],
        {
          cwd: fixtureRoot,
          env: launcherEnv(),
          encoding: "utf8",
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`PRECOMPUTED ${command} help\n`);
    },
  );

  it("uses precomputed subcommand help with leading root options", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "cli-startup-metadata.json"),
      JSON.stringify({ subcommandHelpText: { models: "PRECOMPUTED models help\n" } }),
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      [path.join(fixtureRoot, "openclaw.mjs"), "--log-level", "warn", "--no-color", "models", "-h"],
      {
        cwd: fixtureRoot,
        env: launcherEnv(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("PRECOMPUTED models help\n");
  });

  it.each(
    [
      ["--profile", "work", "nodes", "--help"],
      ["--profile=work", "nodes", "--help"],
      ["--dev", "nodes", "--help"],
      ["--profile", "default", "models", "--help"],
      ["--profile=", "models", "--help"],
      ["--profile", "bad profile", "models", "--help"],
      ["--dev", "--profile", "work", "models", "--help"],
      ["--profile", "work", "--dev", "models", "--help"],
    ].map((args) => ({ args, invocation: args.join(" ") })),
  )("passes profile selection to the runtime before cached help: $invocation", async ({ args }) => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "cli-startup-metadata.json"),
      JSON.stringify({
        nodesHelpText: "PRECOMPUTED nodes help\n",
        subcommandHelpText: { models: "PRECOMPUTED models help\n" },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
      "utf8",
    );

    const result = spawnSync(process.execPath, [path.join(fixtureRoot, "openclaw.mjs"), ...args], {
      cwd: fixtureRoot,
      env: launcherEnv(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(JSON.stringify(args));
  });

  it("defers precomputed subcommand help to the runtime entry when container env is set", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "cli-startup-metadata.json"),
      JSON.stringify({ subcommandHelpText: { models: "PRECOMPUTED models help\n" } }),
      "utf8",
    );
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      "process.stdout.write('RUNTIME ENTRY\\n');\n",
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      [path.join(fixtureRoot, "openclaw.mjs"), "models", "--help"],
      {
        cwd: fixtureRoot,
        env: launcherEnv({ OPENCLAW_CONTAINER: "demo" }),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("RUNTIME ENTRY\n");
    expect(result.stdout).not.toContain("PRECOMPUTED");
  });

  it.each([
    {
      name: "container env with root --help",
      args: ["--help"],
      env: { OPENCLAW_CONTAINER: "demo" },
    },
    {
      name: "container env with root -h",
      args: ["-h"],
      env: { OPENCLAW_CONTAINER: "demo" },
    },
    {
      name: "container env",
      args: ["browser", "--help"],
      env: { OPENCLAW_CONTAINER: "demo" },
    },
    {
      name: "root --container flag",
      args: ["--container", "demo", "browser", "--help"],
      env: {},
    },
    {
      name: "root --container=value flag",
      args: ["--container=demo", "browser", "--help"],
      env: {},
    },
  ])("defers precomputed command help to the runtime entry with $name", async (params) => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "cli-startup-metadata.json"),
      JSON.stringify({
        rootHelpText: "PRECOMPUTED root help\n",
        browserHelpText: "PRECOMPUTED browser help\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      "process.stdout.write('RUNTIME ENTRY\\n');\n",
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      [path.join(fixtureRoot, "openclaw.mjs"), ...params.args],
      {
        cwd: fixtureRoot,
        env: launcherEnv(params.env),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("RUNTIME ENTRY\n");
    expect(result.stdout).not.toContain("PRECOMPUTED");
  });

  it("defers root help to the runtime entry when plugin config can change help", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    const configPath = path.join(fixtureRoot, "openclaw.json");
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "cli-startup-metadata.json"),
      JSON.stringify({ rootHelpText: "PRECOMPUTED memory help\n" }),
      "utf8",
    );
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      "process.stdout.write('RUNTIME ENTRY\\n');\n",
      "utf8",
    );
    await fs.writeFile(
      configPath,
      JSON.stringify({ plugins: { slots: { memory: "memory-lancedb" } } }),
      "utf8",
    );

    const result = spawnSync(process.execPath, [path.join(fixtureRoot, "openclaw.mjs"), "--help"], {
      cwd: fixtureRoot,
      env: launcherEnv({ OPENCLAW_CONFIG_PATH: configPath }),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("RUNTIME ENTRY\n");
    expect(result.stdout).not.toContain("PRECOMPUTED");
  });

  it("defers nodes help to the runtime entry when plugin config can change help", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    const configPath = path.join(fixtureRoot, "openclaw.json");
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "cli-startup-metadata.json"),
      JSON.stringify({ nodesHelpText: "PRECOMPUTED nodes help\n" }),
      "utf8",
    );
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      "process.stdout.write('RUNTIME ENTRY\\n');\n",
      "utf8",
    );
    await fs.writeFile(
      configPath,
      JSON.stringify({ plugins: { entries: { canvas: { enabled: false } } } }),
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      [path.join(fixtureRoot, "openclaw.mjs"), "nodes", "--help"],
      {
        cwd: fixtureRoot,
        env: launcherEnv({ OPENCLAW_CONFIG_PATH: configPath }),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("RUNTIME ENTRY\n");
    expect(result.stdout).not.toContain("PRECOMPUTED");
  });

  it("checks the OPENCLAW_HOME default config path before using precomputed root help", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    const openclawHome = path.join(fixtureRoot, "home");
    const configDir = path.join(openclawHome, ".openclaw");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "cli-startup-metadata.json"),
      JSON.stringify({ rootHelpText: "PRECOMPUTED memory help\n" }),
      "utf8",
    );
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      "process.stdout.write('RUNTIME ENTRY\\n');\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(configDir, "openclaw.json"),
      JSON.stringify({ plugins: { slots: { memory: "memory-lancedb" } } }),
      "utf8",
    );

    const result = spawnSync(process.execPath, [path.join(fixtureRoot, "openclaw.mjs"), "--help"], {
      cwd: fixtureRoot,
      env: launcherEnv({ OPENCLAW_HOME: openclawHome }),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("RUNTIME ENTRY\n");
    expect(result.stdout).not.toContain("PRECOMPUTED");
  });

  it("keeps literal $ patterns in HOME when expanding a tilde OPENCLAW_HOME", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    const home = path.join(fixtureRoot, "home$&d");
    const configDir = path.join(home, "oc", ".openclaw");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "cli-startup-metadata.json"),
      JSON.stringify({ rootHelpText: "PRECOMPUTED memory help\n" }),
      "utf8",
    );
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      "process.stdout.write('RUNTIME ENTRY\\n');\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(configDir, "openclaw.json"),
      JSON.stringify({ plugins: { slots: { memory: "memory-lancedb" } } }),
      "utf8",
    );

    const result = spawnSync(process.execPath, [path.join(fixtureRoot, "openclaw.mjs"), "--help"], {
      cwd: fixtureRoot,
      env: launcherEnv({ HOME: home, OPENCLAW_HOME: "~/oc" }),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("RUNTIME ENTRY\n");
    expect(result.stdout).not.toContain("PRECOMPUTED");
  });

  it("checks legacy config candidates before using precomputed root help", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    const home = path.join(fixtureRoot, "home");
    const legacyConfigDir = path.join(home, ".clawdbot");
    await fs.mkdir(legacyConfigDir, { recursive: true });
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "cli-startup-metadata.json"),
      JSON.stringify({ rootHelpText: "PRECOMPUTED memory help\n" }),
      "utf8",
    );
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      "process.stdout.write('RUNTIME ENTRY\\n');\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(legacyConfigDir, "clawdbot.json"),
      JSON.stringify({ plugins: { slots: { memory: "memory-lancedb" } } }),
      "utf8",
    );

    const result = spawnSync(process.execPath, [path.join(fixtureRoot, "openclaw.mjs"), "--help"], {
      cwd: fixtureRoot,
      env: launcherEnv({ HOME: home, OPENCLAW_HOME: undefined }),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("RUNTIME ENTRY\n");
    expect(result.stdout).not.toContain("PRECOMPUTED");
  });

  it("defers root help when the active config has includes", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    const configPath = path.join(fixtureRoot, "openclaw.json");
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "cli-startup-metadata.json"),
      JSON.stringify({ rootHelpText: "PRECOMPUTED memory help\n" }),
      "utf8",
    );
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      "process.stdout.write('RUNTIME ENTRY\\n');\n",
      "utf8",
    );
    await fs.writeFile(configPath, JSON.stringify({ $include: "memory.json" }), "utf8");

    const result = spawnSync(process.execPath, [path.join(fixtureRoot, "openclaw.mjs"), "--help"], {
      cwd: fixtureRoot,
      env: launcherEnv({ OPENCLAW_CONFIG_PATH: configPath }),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("RUNTIME ENTRY\n");
    expect(result.stdout).not.toContain("PRECOMPUTED");
  });

  it("explains how to recover from an unbuilt source install", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    await addSourceTreeMarker(fixtureRoot);

    const result = spawnSync(process.execPath, [path.join(fixtureRoot, "openclaw.mjs"), "--help"], {
      cwd: fixtureRoot,
      env: launcherEnv(),
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing dist/entry.(m)js");
    expect(result.stderr).toContain("unbuilt source tree or GitHub source archive");
    expect(result.stderr).toContain("pnpm install && pnpm build");
    expect(result.stderr).toContain("github:openclaw/openclaw#<ref>");
  });

  it("respawns source-checkout launchers without inherited NODE_COMPILE_CACHE", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    await addGitMarker(fixtureRoot);
    await addCompileCacheProbe(fixtureRoot);

    const result = spawnSync(process.execPath, [path.join(fixtureRoot, "openclaw.mjs")], {
      cwd: fixtureRoot,
      env: launcherEnv({
        NODE_COMPILE_CACHE: path.join(fixtureRoot, ".node-compile-cache"),
      }),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("cache:disabled;respawn:1");
  });

  it.runIf(process.platform !== "win32")(
    "forwards SIGTERM to source-checkout compile-cache respawn children",
    async () => {
      const fixtureRoot = await makeLauncherFixture(fixtureRoots);
      await addGitMarker(fixtureRoot);
      const childInfoPath = path.join(fixtureRoot, "child-info.json");
      const signalPath = path.join(fixtureRoot, "sigterm-received.txt");
      await fs.writeFile(
        path.join(fixtureRoot, "dist", "entry.js"),
        [
          'import { writeFileSync } from "node:fs";',
          'process.title = "openclaw-launcher-sigterm-test-child";',
          `process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(signalPath)}, "SIGTERM\\n"); process.exit(0); });`,
          `writeFileSync(${JSON.stringify(childInfoPath)}, JSON.stringify({ pid: process.pid }) + "\\n");`,
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
        "utf8",
      );

      const launcher = spawn(process.execPath, [path.join(fixtureRoot, "openclaw.mjs")], {
        cwd: fixtureRoot,
        env: launcherEnv({
          NODE_COMPILE_CACHE: path.join(fixtureRoot, ".node-compile-cache"),
        }),
        stdio: "ignore",
      });
      let respawnChildPid: number | undefined;

      try {
        const childInfo = await waitForJsonFile<{ pid: number }>(childInfoPath, 5000);
        respawnChildPid = childInfo.pid;

        launcher.kill("SIGTERM");

        await expect(waitForProcessExit(launcher, "launcher", 5000)).resolves.toEqual({
          code: 0,
          signal: null,
        });
        await expect(fs.readFile(signalPath, "utf8")).resolves.toBe("SIGTERM\n");
        expect(isProcessAlive(respawnChildPid)).toBe(false);
      } finally {
        if (isProcessAlive(respawnChildPid)) {
          process.kill(respawnChildPid!, "SIGKILL");
        }
        if (isProcessAlive(launcher.pid)) {
          process.kill(launcher.pid!, "SIGKILL");
        }
      }
    },
  );

  it.runIf(process.platform !== "win32").each([true, false])(
    "preserves foreground Gmail shutdown grace with compile cache (source=%s)",
    async (sourceCheckout) => {
      const fixtureRoot = await makeLauncherFixture(fixtureRoots);
      if (sourceCheckout) {
        await addGitMarker(fixtureRoot);
      }
      const readyPath = path.join(fixtureRoot, "gmail-ready.json");
      const stoppedPath = path.join(fixtureRoot, "gmail-stopped.txt");
      await fs.writeFile(
        path.join(fixtureRoot, "dist", "entry.js"),
        [
          'import { writeFileSync } from "node:fs";',
          `process.on("SIGTERM", () => setTimeout(() => { writeFileSync(${JSON.stringify(stoppedPath)}, "stopped"); process.exit(0); }, 3025));`,
          `writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({ pid: process.pid }));`,
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );
      const launcher = spawn(
        process.execPath,
        [
          path.join(fixtureRoot, "openclaw.mjs"),
          "webhooks",
          "--profile",
          "fixture",
          "gmail",
          "run",
        ],
        {
          cwd: fixtureRoot,
          env: launcherEnv({ NODE_COMPILE_CACHE: path.join(fixtureRoot, ".node-cache") }),
          stdio: "ignore",
        },
      );
      let ownerPid: number | undefined;
      try {
        ownerPid = (await waitForJsonFile<{ pid: number }>(readyPath, 5000)).pid;
        launcher.kill("SIGTERM");
        await expect(waitForProcessExit(launcher, "foreground Gmail", 5000)).resolves.toEqual({
          code: 0,
          signal: null,
        });
        await expect(fs.readFile(stoppedPath, "utf8")).resolves.toBe("stopped");
        expect(isProcessAlive(ownerPid)).toBe(false);
      } finally {
        for (const pid of [ownerPid, launcher.pid]) {
          if (isProcessAlive(pid)) {
            process.kill(pid!, "SIGKILL");
          }
        }
      }
    },
  );

  it.runIf(process.platform !== "win32").each([
    { signal: "SIGINT" as const, exitCode: 130 },
    { signal: "SIGTERM" as const, exitCode: 143 },
  ])("exits $exitCode when the respawn child terminates from $signal", async (testCase) => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    await addGitMarker(fixtureRoot);
    const childInfoPath = path.join(fixtureRoot, "child-info.json");
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(childInfoPath)}, JSON.stringify({ pid: process.pid }) + "\\n");`,
        'process.title = "openclaw-launcher-default-signal-test-child";',
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
      "utf8",
    );

    const launcher = spawn(process.execPath, [path.join(fixtureRoot, "openclaw.mjs")], {
      cwd: fixtureRoot,
      env: launcherEnv({
        NODE_COMPILE_CACHE: path.join(fixtureRoot, ".node-compile-cache"),
      }),
      stdio: "ignore",
    });
    let respawnChildPid: number | undefined;

    try {
      const childInfo = await waitForJsonFile<{ pid: number }>(childInfoPath, 5000);
      respawnChildPid = childInfo.pid;

      launcher.kill(testCase.signal);

      await expect(waitForProcessExit(launcher, "launcher", 5000)).resolves.toEqual({
        code: testCase.exitCode,
        signal: null,
      });
      expect(isProcessAlive(respawnChildPid)).toBe(false);
    } finally {
      if (isProcessAlive(respawnChildPid)) {
        process.kill(respawnChildPid!, "SIGKILL");
      }
      if (isProcessAlive(launcher.pid)) {
        process.kill(launcher.pid!, "SIGKILL");
      }
    }
  });

  it.runIf(process.platform !== "win32")(
    "exits after SIGTERM when the respawn child ignores the forwarded signal",
    async () => {
      const fixtureRoot = await makeLauncherFixture(fixtureRoots);
      await addGitMarker(fixtureRoot);
      const childInfoPath = path.join(fixtureRoot, "child-info.json");
      await fs.writeFile(
        path.join(fixtureRoot, "dist", "entry.js"),
        [
          'import { writeFileSync } from "node:fs";',
          'process.title = "openclaw-launcher-sigterm-ignore-test-child";',
          'process.on("SIGTERM", () => {});',
          `writeFileSync(${JSON.stringify(childInfoPath)}, JSON.stringify({ pid: process.pid }) + "\\n");`,
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
        "utf8",
      );

      const launcher = spawn(process.execPath, [path.join(fixtureRoot, "openclaw.mjs")], {
        cwd: fixtureRoot,
        env: launcherEnv({
          NODE_COMPILE_CACHE: path.join(fixtureRoot, ".node-compile-cache"),
        }),
        stdio: "ignore",
      });
      let respawnChildPid: number | undefined;

      try {
        const childInfo = await waitForJsonFile<{ pid: number }>(childInfoPath, 5000);
        respawnChildPid = childInfo.pid;

        launcher.kill("SIGTERM");

        await expect(waitForProcessExit(launcher, "launcher", 5000)).resolves.toEqual({
          code: 1,
          signal: null,
        });
        expect(isProcessAlive(launcher.pid)).toBe(false);
        expect(isProcessAlive(respawnChildPid)).toBe(false);
      } finally {
        if (isProcessAlive(respawnChildPid)) {
          process.kill(respawnChildPid!, "SIGKILL");
        }
        if (isProcessAlive(launcher.pid)) {
          process.kill(launcher.pid!, "SIGKILL");
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "respawns symlinked source-checkout launchers without inherited NODE_COMPILE_CACHE",
    async () => {
      const fixtureRoot = await makeLauncherFixture(fixtureRoots);
      await addGitMarker(fixtureRoot);
      await addCompileCacheProbe(fixtureRoot);
      const linkParent = makeTempDir(fixtureRoots, "openclaw-launcher-link-");
      const linkedRoot = path.join(linkParent, "openclaw-linked");
      await fs.symlink(fixtureRoot, linkedRoot, "dir");

      const result = spawnSync(process.execPath, [path.join(linkedRoot, "openclaw.mjs")], {
        cwd: linkParent,
        env: launcherEnv({
          NODE_COMPILE_CACHE: path.join(linkParent, ".node-compile-cache"),
        }),
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("cache:disabled;respawn:1");
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves a packaged pnpm project path through compile-cache respawn",
    async () => {
      const fixtureRoot = await makeLauncherFixture(fixtureRoots);
      await fs.writeFile(path.join(fixtureRoot, "package.json"), '{"version":"2026.8.1"}\n');
      await fs.writeFile(
        path.join(fixtureRoot, "dist", "entry.js"),
        'process.stdout.write(process.argv[1] ?? "");\n',
        "utf8",
      );
      const globalRoot = makeTempDir(fixtureRoots, "openclaw-pnpm-global-");
      const packageRoot = path.join(globalRoot, "v11", "active", "node_modules", "openclaw");
      await fs.mkdir(path.dirname(packageRoot), { recursive: true });
      await fs.symlink(fixtureRoot, packageRoot, "dir");
      const launcher = path.join(packageRoot, "openclaw.mjs");

      const result = spawnSync(process.execPath, [launcher], {
        cwd: globalRoot,
        env: launcherEnv({ NODE_COMPILE_CACHE: path.join(globalRoot, ".node-compile-cache") }),
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(launcher);
    },
  );

  it("keeps compile cache enabled for packaged launchers when NODE_COMPILE_CACHE is configured", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    await addCompileCacheProbe(fixtureRoot);

    const result = spawnSync(process.execPath, [path.join(fixtureRoot, "openclaw.mjs")], {
      cwd: fixtureRoot,
      env: launcherEnv({
        NODE_COMPILE_CACHE: path.join(fixtureRoot, ".node-compile-cache"),
      }),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("cache:enabled;respawn:0");
  });

  it.runIf(process.platform !== "win32")(
    "does not respawn native hook relays for packaged compile-cache scoping",
    async () => {
      const fixtureRoot = await makeLauncherFixture(fixtureRoots);
      await fs.writeFile(path.join(fixtureRoot, "package.json"), '{"version":"2026.4.29"}\n');
      await fs.writeFile(
        path.join(fixtureRoot, "dist", "entry.js"),
        'process.stdout.write(process.env.OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED ?? "0");\n',
        "utf8",
      );

      const result = spawnSync(
        process.execPath,
        [path.join(fixtureRoot, "openclaw.mjs"), "hooks", "relay"],
        {
          cwd: fixtureRoot,
          env: launcherEnv({
            NODE_COMPILE_CACHE: path.join(fixtureRoot, ".node-compile-cache"),
          }),
          encoding: "utf8",
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("0");
    },
  );

  it("scopes packaged launcher compile cache inside configured cache roots", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    await fs.writeFile(path.join(fixtureRoot, "package.json"), '{"version":"2026.4.29"}\n');
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      [
        'import module from "node:module";',
        'process.stdout.write(module.getCompileCacheDir?.() ?? "cache:disabled");',
      ].join("\n"),
      "utf8",
    );

    const result = spawnSync(process.execPath, [path.join(fixtureRoot, "openclaw.mjs")], {
      cwd: fixtureRoot,
      env: launcherEnv({
        NODE_COMPILE_CACHE: path.join(fixtureRoot, ".node-compile-cache"),
      }),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(path.join(".node-compile-cache", "openclaw", "2026.4.29"));
  });

  it("falls back to the default packaged launcher compile cache when NODE_COMPILE_CACHE is empty", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    const runCwd = makeTempDir(fixtureRoots, "openclaw-launcher-cwd-");
    const tmpRoot = makeTempDir(fixtureRoots, "openclaw-launcher-tmp-");
    await fs.writeFile(path.join(fixtureRoot, "package.json"), '{"version":"2026.4.29"}\n');
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      [
        'import module from "node:module";',
        'process.stdout.write(module.getCompileCacheDir?.() ?? "cache:disabled");',
      ].join("\n"),
      "utf8",
    );

    const result = spawnSync(process.execPath, [path.join(fixtureRoot, "openclaw.mjs")], {
      cwd: runCwd,
      env: launcherEnv({
        NODE_COMPILE_CACHE: "",
        TMP: tmpRoot,
        TEMP: tmpRoot,
        TMPDIR: tmpRoot,
      }),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(path.join("node-compile-cache", "openclaw", "2026.4.29"));
    expect(result.stdout).not.toContain(path.join(runCwd, "openclaw"));
  });

  it("enables compile cache for packaged launchers", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    const tmpRoot = makeTempDir(fixtureRoots, "openclaw-launcher-tmp-");
    await addCompileCacheProbe(fixtureRoot);

    const result = spawnSync(process.execPath, [path.join(fixtureRoot, "openclaw.mjs")], {
      cwd: fixtureRoot,
      env: launcherEnv({
        TMP: tmpRoot,
        TEMP: tmpRoot,
        TMPDIR: tmpRoot,
      }),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("cache:enabled;respawn:0");
  });
});
