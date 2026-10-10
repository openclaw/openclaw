import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build as esbuild } from "esbuild";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const processes = new Set<ChildProcessWithoutNullStreams>();
let bootstrapSource: string;
let launcherClientSource: string;

beforeAll(async () => {
  const compile = async (entry: string) => {
    const built = await esbuild({
      bundle: true,
      entryPoints: [path.resolve(entry)],
      external: ["@openclaw/fs-safe", "@openclaw/fs-safe/*"],
      format: "esm",
      platform: "node",
      target: "node24",
      banner: {
        js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
      },
      write: false,
    });
    const output = built.outputFiles[0];
    if (!output) {
      throw new Error(`The ${entry} fixture did not compile.`);
    }
    return output.text;
  };
  [bootstrapSource, launcherClientSource] = await Promise.all([
    compile("src/node-host/launcher-bootstrap.ts"),
    compile("src/node-host/launcher-client.ts"),
  ]);
});

afterEach(async () => {
  await Promise.all(
    [...processes].map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
    }),
  );
  processes.clear();
});

async function writePackage(root: string, version: string, body: string, schema = 1) {
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.writeFile(path.join(root, "dist", "node-host-launcher-bootstrap.js"), bootstrapSource);
  await fs.writeFile(path.join(root, "dist", "launcher-client.js"), launcherClientSource);
  await fs.symlink(
    path.resolve("node_modules"),
    path.join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  for (const name of [
    "openclaw.mjs",
    "node-host-launcher.mjs",
    "node-compile-cache.mjs",
    "node-version.mjs",
    "node-sqlite.mjs",
    "node-runtime-update.mjs",
    "node-runtime-recovery.mjs",
    "node-runtime-env.mjs",
    "cli-root-options.mjs",
    "gateway-run-argv.mjs",
    "gateway-shutdown-budget.mjs",
  ]) {
    await fs.copyFile(path.resolve(name), path.join(root, name));
  }
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "openclaw",
      type: "module",
      version,
      openclaw: { schemaVersions: { state: schema, agent: schema } },
    }),
  );
  await fs.writeFile(
    path.join(root, "dist", "entry.js"),
    `
import fs from 'node:fs';
import {
  getManagedNodeHostStatePath,
  notifyNodeHostLauncherReady,
  requestNodeHostLauncherBootstrap,
  requestNodeHostLauncherRestart,
  setNodeHostLauncherRestartArguments,
} from './launcher-client.js';
const version = ${JSON.stringify(version)};
const report = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const ready = () => notifyNodeHostLauncherReady(version);
${body}
`,
  );
  return root;
}

async function fixture(body: string) {
  const root = temporary.make("node-launcher-");
  const base = await writePackage(path.join(root, "base"), "2026.9.1", body);
  const stateDir = path.join(root, "state");
  const runtimeDirectory = path.join(stateDir, "node-runtime");
  const release = async (version: string, source: string, schema = 1) => {
    const prefix = path.join(runtimeDirectory, "releases", version);
    const packageRoot = path.join(prefix, "lib", "node_modules", "openclaw");
    await writePackage(packageRoot, version, source, schema);
    return { prefix, packageRoot };
  };
  const current = path.join(runtimeDirectory, "current");
  const select = async (prefix: string, options: { stale?: boolean } = {}) => {
    await fs.symlink(prefix, current, process.platform === "win32" ? "junction" : "dir");
    if (options.stale) {
      const old = new Date(Date.now() - 13 * 60 * 60 * 1_000);
      await fs.lutimes(current, old, old);
    }
  };
  return { root, base, stateDir, runtimeDirectory, current, release, select };
}

function run(
  base: string,
  stateDir: string,
  args = ["node", "run"],
  extraEnv: NodeJS.ProcessEnv = {},
  execArgv: readonly string[] = [],
) {
  const child = spawn(process.execPath, [...execArgv, path.join(base, "openclaw.mjs"), ...args], {
    cwd: base,
    env: {
      ...process.env,
      OPENCLAW_CONTAINER: undefined,
      OPENCLAW_HOME: undefined,
      OPENCLAW_PROFILE: undefined,
      OPENCLAW_STATE_DIR: stateDir,
      NODE_COMPILE_CACHE: undefined,
      ...extraEnv,
    },
    stdio: "pipe",
  });
  processes.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const done = once(child, "close").then(([code, signal]) => ({ code, signal, stdout, stderr }));
  return { child, done, output: () => stdout };
}

const requestUpdate = `
await ready();
try {
  await requestNodeHostLauncherRestart({ runtimeRoot: process.env.TEST_RUNTIME_ROOT, version: process.env.TEST_VERSION });
  report({ok: true});
  process.exit(0);
} catch (error) {
  report({ok: false, error: error.message});
  process.exit(2);
}
`;

async function windowsSelectorFixture(root: string, current: string, failure: string) {
  const preload = path.join(root, "windows-selector.mjs");
  await fs.writeFile(
    preload,
    `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const current = process.env.TEST_CURRENT;
const previous = current + '.previous';
const rename = fs.renameSync;
fs.renameSync = (source, destination) => {
  if (destination === current) {
    if (fs.existsSync(destination)) {
      throw Object.assign(new Error('Windows cannot replace an existing directory junction'), {code:'EPERM'});
    }
    if ((source.endsWith('.next') && process.env.TEST_RENAME_FAILURE?.endsWith('fails')) ||
        (source === previous && process.env.TEST_RENAME_FAILURE === 'rollback-fails')) {
      throw Object.assign(new Error('injected selector rename failure'), {code:'EACCES'});
    }
  }
  const result = rename(source, destination);
  if (source === current && process.env.TEST_RENAME_FAILURE === 'crash') {
    process.exit(91);
  }
  return result;
};
syncBuiltinESMExports();
`,
  );
  return {
    execArgv: ["--import", pathToFileURL(preload).href],
    env: {
      TEST_CURRENT: current,
      TEST_RENAME_FAILURE: failure,
    },
  };
}

describe("managed node launcher", () => {
  it("rejects private managed-child arguments without supervisor IPC", async () => {
    const f = await fixture("throw new Error('private arguments must not reach the entry point');");
    const result = await run(f.base, f.stateDir, [
      "--openclaw-node-host-managed-child",
      path.join(f.stateDir, "state", "openclaw.sqlite"),
      "node",
      "run",
    ]).done;
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("requires a supervisor connection");
  });

  it("revokes the managed state path when supervisor IPC disconnects", async () => {
    const f = await fixture("throw new Error('the managed runtime must own the run');");
    const managed = await f.release(
      "2026.9.2",
      `
await ready();
const before = getManagedNodeHostStatePath();
process.disconnect();
report({before, after: getManagedNodeHostStatePath() ?? null});
process.exit(0);
`,
    );
    await f.select(managed.prefix);
    const result = await run(f.base, f.stateDir).done;
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      before: path.join(f.stateDir, "state", "openclaw.sqlite"),
      after: null,
    });
  });

  it("restarts into a healthy candidate, preserving root flags and replacing one-use pairing arguments", async () => {
    const f = await fixture(`
await setNodeHostLauncherRestartArguments(['node', 'run', '--display-name', 'paired']);
${requestUpdate}
`);
    const candidate = await f.release(
      "2026.9.2",
      `
if (!process.env.TEST_CANDIDATE_BOOTSTRAPPED) {
  await requestNodeHostLauncherBootstrap({ execArgv: [...process.execArgv, '--disable-warning=ExperimentalWarning'], env: {...process.env, TEST_CANDIDATE_BOOTSTRAPPED:'1'} });
  process.exit(0);
}
await ready();
setTimeout(async () => {
  const first = fs.lstatSync(process.env.TEST_CURRENT).mtimeMs;
  await ready();
  setTimeout(() => {
    report({ argv: process.argv.slice(2), first, second: fs.lstatSync(process.env.TEST_CURRENT).mtimeMs, cwd: process.cwd(), state: getManagedNodeHostStatePath() ?? null, execArgv: process.execArgv });
    process.exit(0);
  }, 30);
}, 30);
`,
    );
    const result = await run(
      f.base,
      f.stateDir,
      ["connect", "one-use-code", "--profile", "work", "--no-color"],
      {
        TEST_RUNTIME_ROOT: candidate.prefix,
        TEST_VERSION: "2026.9.2",
        TEST_CURRENT: f.current,
      },
    ).done;
    expect(result.code, result.stderr).toBe(0);
    const lines = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ ok: true });
    expect(lines[1]).toMatchObject({
      argv: ["--profile", "work", "--no-color", "node", "run", "--display-name", "paired"],
      cwd: f.base,
      state: path.join(f.stateDir, "state", "openclaw.sqlite"),
      execArgv: ["--disable-warning=ExperimentalWarning"],
    });
    expect(lines[1].first).toBe(lines[1].second);
    expect(await fs.realpath(f.current)).toBe(await fs.realpath(candidate.prefix));
    await expect(fs.access(path.join(f.runtimeDirectory, "activation.lock"))).rejects.toThrow();
  });

  it("keeps an authenticated candidate serving when its selector cannot be persisted", async () => {
    const f = await fixture("throw new Error('the selected runtime must own the run');");
    const previous = await f.release(
      "2026.9.1",
      `
if (fs.existsSync(process.env.TEST_ATTEMPT)) {
  report('fallback-started');
  process.exit(9);
}
fs.writeFileSync(process.env.TEST_ATTEMPT, 'started');
${requestUpdate}
`,
    );
    const candidate = await f.release(
      "2026.9.2",
      `
fs.mkdirSync(process.env.TEST_CURRENT + '.' + process.ppid + '.next');
report('candidate-work-started');
await ready();
setTimeout(() => {
  report('candidate-work-complete');
  process.exit(0);
}, 100);
`,
    );
    await f.select(previous.prefix, { stale: true });
    const before = await fs.lstat(f.current);
    const result = await run(f.base, f.stateDir, ["node", "run"], {
      TEST_RUNTIME_ROOT: candidate.prefix,
      TEST_VERSION: "2026.9.2",
      TEST_CURRENT: f.current,
      TEST_ATTEMPT: path.join(f.root, "attempt"),
    }).done;
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('"candidate-work-started"');
    expect(result.stdout).toContain('"candidate-work-complete"');
    expect(result.stdout).not.toContain("fallback-started");
    expect(result.stderr).toContain("could not remove the staged node selector");
    expect(result.stderr).toMatch(/could not record the updated node runtime: [^\n]*\bsymlink\b/);
    expect(await fs.realpath(f.current)).toBe(await fs.realpath(previous.prefix));
    expect((await fs.lstat(f.current)).mtimeMs).toBe(before.mtimeMs);
    await expect(fs.access(path.join(f.runtimeDirectory, "activation.lock"))).rejects.toThrow();
  });

  it.each(["publish-fails", "rollback-fails", "crash"])(
    "preserves Windows runtime selection across replacement and restart (%s)",
    async (failure) => {
      const body = `
if (process.env.TEST_SELECT_ONLY || version === process.env.TEST_VERSION) {
  await ready();
  report({version});
} else {
  ${requestUpdate}
}
`;
      const f = await fixture("throw new Error('the global runtime must not load');");
      const previous = await f.release("2026.9.2", body);
      const candidate = await f.release("2026.9.3", body);
      await f.select(previous.prefix, { stale: true });
      const previousMtime = (await fs.lstat(f.current)).mtimeMs;
      const { env, execArgv } = await windowsSelectorFixture(f.root, f.current, failure);
      const result = await run(
        f.base,
        f.stateDir,
        ["node", "run"],
        {
          ...env,
          TEST_RUNTIME_ROOT: candidate.prefix,
          TEST_VERSION: "2026.9.3",
        },
        execArgv,
      ).done;
      expect(result.code, result.stderr).toBe(failure === "crash" ? 91 : 0);
      const backup = `${f.current}.previous`;
      const interrupted = failure === "rollback-fails" || failure === "crash";
      const persisted = interrupted ? backup : f.current;
      expect(await fs.realpath(persisted)).toBe(await fs.realpath(previous.prefix));
      expect((await fs.lstat(persisted)).mtimeMs).toBe(previousMtime);
      await expect(fs.access(interrupted ? f.current : backup)).rejects.toThrow();
      if (failure === "rollback-fails") {
        expect(result.stderr).toContain(backup);
      }
      const restarted = await run(
        f.base,
        f.stateDir,
        ["node", "run"],
        {
          ...env,
          TEST_SELECT_ONLY: "1",
          TEST_RENAME_FAILURE: undefined,
        },
        execArgv,
      ).done;
      expect(restarted.code, restarted.stderr).toBe(0);
      expect(JSON.parse(restarted.stdout.trim())).toEqual({
        version: "2026.9.2",
      });
      if (interrupted) {
        if (failure === "crash") {
          // Crash recovery keeps the existing operator-owned stale-lock policy.
          await fs.unlink(path.join(f.runtimeDirectory, "activation.lock"));
        }
        const recovered = await run(
          f.base,
          f.stateDir,
          ["node", "run"],
          {
            ...env,
            TEST_RUNTIME_ROOT: candidate.prefix,
            TEST_VERSION: "2026.9.3",
            TEST_RENAME_FAILURE: undefined,
          },
          execArgv,
        ).done;
        expect(recovered.code, recovered.stderr).toBe(0);
        expect(await fs.realpath(f.current)).toBe(await fs.realpath(candidate.prefix));
        await expect(fs.access(backup)).rejects.toThrow();
      }
      await expect(fs.access(path.join(f.runtimeDirectory, "activation.lock"))).rejects.toThrow();
    },
  );

  it("keeps the previous managed runtime serving after a failed candidate", async () => {
    const reportRuntime =
      "report({version,state:getManagedNodeHostStatePath() ?? null,argv:process.argv.slice(2)});";
    const body = `
${reportRuntime}
if (fs.existsSync(process.env.TEST_ATTEMPT)) {
  await ready();
  try {
    await requestNodeHostLauncherRestart({ runtimeRoot: process.env.TEST_RUNTIME_ROOT, version: process.env.TEST_VERSION });
    report({ok: true});
    process.exit(3);
  } catch (error) {
    report({ok: false, error: error.message});
    report('old-runtime-serving');
    process.exit(0);
  }
} else {
  fs.writeFileSync(process.env.TEST_ATTEMPT, 'started');
  ${requestUpdate}
}
`;
    const f = await fixture(body);
    const previous = await f.release("2026.9.1", body);
    await f.select(previous.prefix, { stale: true });
    const candidate = await f.release("2026.9.2", `${reportRuntime} process.exit(42);`);
    const result = await run(f.base, f.stateDir, ["node", "run"], {
      TEST_RUNTIME_ROOT: candidate.prefix,
      TEST_VERSION: "2026.9.2",
      TEST_ATTEMPT: path.join(f.root, "attempt"),
    }).done;
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('"old-runtime-serving"');
    expect(result.stdout).toContain("12 hours");
    expect(result.stderr).toContain("restarting the previous runtime");
    const state = path.join(f.stateDir, "state", "openclaw.sqlite");
    const observed = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(observed.filter((entry) => entry.version)).toEqual([
      { version: "2026.9.1", state, argv: ["node", "run"] },
      { version: "2026.9.2", state, argv: ["node", "run"] },
      { version: "2026.9.1", state, argv: ["node", "run"] },
    ]);
    expect(await fs.realpath(f.current)).toBe(await fs.realpath(previous.prefix));
  });

  it("keeps the selected runtime when an acknowledged candidate changes before shutdown", async () => {
    const f = await fixture("throw new Error('the selected previous runtime must own the run');");
    const previous = await f.release(
      "2026.9.1",
      `
await ready();
if (fs.existsSync(process.env.TEST_ATTEMPT)) {
  try {
    await requestNodeHostLauncherRestart({ runtimeRoot: process.env.TEST_RUNTIME_ROOT, version: process.env.TEST_VERSION });
    report({ok: true});
    process.exit(3);
  } catch (error) {
    report({ok: false, error: error.message});
    report('previous-runtime-serving');
    process.exit(0);
  }
} else {
  fs.writeFileSync(process.env.TEST_ATTEMPT, 'started');
  await requestNodeHostLauncherRestart({ runtimeRoot: process.env.TEST_RUNTIME_ROOT, version: process.env.TEST_VERSION });
  report('restart-accepted');
  const manifest = JSON.parse(fs.readFileSync(process.env.TEST_CANDIDATE_MANIFEST, 'utf8'));
  manifest.openclaw.schemaVersions.state += 1;
  fs.writeFileSync(process.env.TEST_CANDIDATE_MANIFEST, JSON.stringify(manifest));
  process.exit(0);
}
`,
    );
    const candidate = await f.release(
      "2026.9.2",
      `
fs.writeFileSync(process.env.TEST_CANDIDATE_STARTED, 'started');
await ready();
process.exit(0);
`,
    );
    await f.select(previous.prefix, { stale: true });
    const before = await fs.lstat(f.current);
    const candidateStarted = path.join(f.root, "candidate-started");
    const result = await run(f.base, f.stateDir, ["node", "run"], {
      TEST_RUNTIME_ROOT: candidate.prefix,
      TEST_VERSION: "2026.9.2",
      TEST_ATTEMPT: path.join(f.root, "attempt"),
      TEST_CANDIDATE_MANIFEST: path.join(candidate.packageRoot, "package.json"),
      TEST_CANDIDATE_STARTED: candidateStarted,
    }).done;
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('"restart-accepted"');
    expect(result.stdout).toContain('"previous-runtime-serving"');
    expect(result.stdout).toContain("12 hours");
    expect(result.stderr).toContain("staged node runtime changed before restart");
    expect(await fs.realpath(f.current)).toBe(await fs.realpath(previous.prefix));
    expect((await fs.lstat(f.current)).mtimeMs).toBe(before.mtimeMs);
    await expect(fs.access(candidateStarted)).rejects.toThrow();
    await expect(fs.access(path.join(f.runtimeDirectory, "activation.lock"))).rejects.toThrow();
  });

  it("refuses an already-published shared runtime at the backup selector", async () => {
    const f = await fixture(`
fs.symlinkSync(process.env.TEST_SHARED_RUNTIME, process.env.TEST_CURRENT, process.platform === 'win32' ? 'junction' : 'dir');
const old = new Date(Date.now() - 13 * 60 * 60 * 1000);
fs.lutimesSync(process.env.TEST_CURRENT, old, old);
${requestUpdate}
`);
    const current = await f.release(
      "2026.9.2-1",
      "throw new Error('must not relaunch shared runtime');",
    );
    const selectedPath = path.join(f.runtimeDirectory, "current.previous");
    const result = await run(f.base, f.stateDir, ["node", "run"], {
      TEST_SHARED_RUNTIME: current.prefix,
      TEST_CURRENT: selectedPath,
      TEST_RUNTIME_ROOT: current.prefix,
      TEST_VERSION: "2026.9.2-1",
    }).done;
    expect(result.code, result.stderr).toBe(2);
    expect(result.stdout).toContain("Another node already selected");
    expect(await fs.realpath(selectedPath)).toBe(await fs.realpath(current.prefix));
  });

  it("rejects automatic activation across database schema versions", async () => {
    const f = await fixture(requestUpdate);
    const candidate = await f.release("2026.9.2", "throw new Error('must not launch');", 2);
    const result = await run(f.base, f.stateDir, ["node", "run"], {
      TEST_RUNTIME_ROOT: candidate.prefix,
      TEST_VERSION: "2026.9.2",
    }).done;
    expect(result.code, result.stderr).toBe(2);
    expect(
      result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([expect.objectContaining({ ok: false })]);
    expect(result.stdout).toContain("schema");
  });

  it("serializes competing parents until the candidate reconnects", async () => {
    const f = await fixture(requestUpdate);
    const releaseFile = path.join(f.root, "release-candidate");
    const candidate = await f.release(
      "2026.9.2",
      `
report('candidate-started');
const poll = setInterval(async () => {
  if (fs.existsSync(process.env.TEST_RELEASE)) {
    clearInterval(poll);
    await ready();
    setTimeout(() => process.exit(0), 20);
  }
}, 10);
`,
    );
    const env = {
      TEST_RUNTIME_ROOT: candidate.prefix,
      TEST_VERSION: "2026.9.2",
      TEST_RELEASE: releaseFile,
    };
    const first = run(f.base, f.stateDir, ["node", "run"], env);
    await expect.poll(() => first.output(), { timeout: 10_000 }).toContain("candidate-started");
    const second = await run(f.base, f.stateDir, ["node", "run"], env).done;
    expect(second.code, second.stderr).toBe(2);
    expect(second.stdout).toContain("activation lock");
    await fs.writeFile(releaseFile, "release");
    const result = await first.done;
    expect(result.code, result.stderr).toBe(0);
    expect(await fs.realpath(f.current)).toBe(await fs.realpath(candidate.prefix));
  });
});
