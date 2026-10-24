import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build as esbuild } from "esbuild";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolveNodeProgramArguments } from "../src/daemon/program-args.js";
import { buildSystemdUnit, parseSystemdExecStart } from "../src/daemon/systemd-unit.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const processes = new Map<ChildProcessWithoutNullStreams, Promise<unknown>>();
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
      metafile: true,
      banner: {
        js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
      },
      write: false,
    });
    expect(
      Object.keys(built.metafile!.inputs).filter(
        (file) =>
          /(?:^|\/)src\/(?:agents|gateway|tui|cron)\//u.test(file) ||
          file.endsWith("src/cli/program/subcli-descriptors.ts"),
      ),
    ).toEqual([]);
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
    [...processes].map(async ([child, closed]) => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
      await closed;
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
    "cli-invocation.mjs",
    "node-host-launcher.mjs",
    "node-compile-cache.mjs",
    "node-version.mjs",
    "node-sqlite.mjs",
    "node-runtime-update.mjs",
    "node-runtime-recovery.mjs",
    "cli-parent-lifetime.mjs",
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
  isNodeHostLauncherChild,
  notifyNodeHostLauncherReady,
  requestNodeHostLauncherBootstrap,
  requestNodeHostLauncherRestart,
  setNodeHostLauncherRestartArguments,
} from './launcher-client.js';
const version = ${JSON.stringify(version)};
const report = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const ready = () => notifyNodeHostLauncherReady(version);
const restart = () => requestNodeHostLauncherRestart({ runtimeRoot: process.env.TEST_RUNTIME_ROOT, version: process.env.TEST_VERSION });
async function restartAndExit(failureLabel, successCode = 0, failureCode = 2) {
  try {
    await restart();
    report({ok: true});
    process.exit(successCode);
  } catch (error) {
    report({ok: false, error: error.message});
    if (failureLabel) report(failureLabel);
    process.exit(failureCode);
  }
}
${body}
`,
  );
  return root;
}

async function fixture(body = "throw new Error('the selected runtime must own the run');") {
  const root = temporary.make("node-launcher-");
  const base = await writePackage(path.join(root, "base"), "2026.9.1", body);
  const stateDir = path.join(root, "state");
  const runtimeDirectory = path.join(stateDir, "node-runtime");
  const release = async (source: string, version = "2026.9.2", schema = 1) => {
    const prefix = path.join(runtimeDirectory, "releases", version);
    const packageRoot = path.join(prefix, "lib", "node_modules", "openclaw");
    await writePackage(packageRoot, version, source, schema);
    return { prefix, packageRoot, version };
  };
  const current = path.join(runtimeDirectory, "current");
  const select = async (prefix: string, options: { stale?: boolean } = {}) => {
    await fs.symlink(prefix, current, process.platform === "win32" ? "junction" : "dir");
    if (options.stale) {
      const old = new Date(Date.now() - 13 * 60 * 60 * 1_000);
      await fs.lutimes(current, old, old);
    }
  };
  const run = (env: NodeJS.ProcessEnv = {}, args = ["node", "run"], execArgv: string[] = []) =>
    runProgram(
      base,
      stateDir,
      [process.execPath, ...execArgv, path.join(base, "openclaw.mjs"), ...args],
      env,
    );
  const update = (
    candidate: Awaited<ReturnType<typeof release>>,
    env: NodeJS.ProcessEnv = {},
    args?: string[],
    execArgv?: string[],
  ) =>
    run(
      {
        TEST_RUNTIME_ROOT: candidate.prefix,
        TEST_VERSION: candidate.version,
        TEST_CURRENT: current,
        TEST_ATTEMPT: path.join(root, "attempt"),
        ...env,
      },
      args,
      execArgv,
    );
  return {
    root,
    base,
    stateDir,
    runtimeDirectory,
    current,
    release,
    select,
    run,
    update,
    state: path.join(stateDir, "state", "openclaw.sqlite"),
    lock: path.join(runtimeDirectory, "activation.lock"),
  };
}

function runProgram(
  base: string,
  stateDir: string,
  programArguments: string[],
  extraEnv: NodeJS.ProcessEnv = {},
) {
  const [command, ...args] = programArguments;
  if (!command) {
    throw new Error("The service definition did not contain an executable.");
  }
  const child = spawn(command, args, {
    cwd: base,
    env: {
      ...process.env,
      HOME: path.join(stateDir, "home"),
      OPENCLAW_CONFIG_PATH: undefined,
      OPENCLAW_CONTAINER: undefined,
      OPENCLAW_HOME: undefined,
      OPENCLAW_PROFILE: undefined,
      OPENCLAW_STATE_DIR: stateDir,
      NODE_COMPILE_CACHE: undefined,
      ...extraEnv,
    },
    stdio: "pipe",
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const done = once(child, "close").then(([code, signal]) => ({ code, signal, stdout, stderr }));
  processes.set(child, done);
  return { child, done, output: () => stdout };
}

const requestUpdate = "await ready(); await restartAndExit();";
const restartingRuntime = (onRepeat: string) => `
if (fs.existsSync(process.env.TEST_ATTEMPT)) {
  ${onRepeat}
} else {
  fs.writeFileSync(process.env.TEST_ATTEMPT, 'started');
  ${requestUpdate}
}
`;
const jsonLines = (stdout: string) =>
  stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

async function completed(process: ReturnType<typeof runProgram>, code = 0) {
  const result = await process.done;
  expect(result.code, result.stderr).toBe(code);
  return result;
}

async function expectSelection(selector: string, prefix: string, mtime?: number) {
  expect(await fs.realpath(selector)).toBe(await fs.realpath(prefix));
  if (mtime !== undefined) {
    expect((await fs.lstat(selector)).mtimeMs).toBe(mtime);
  }
}

const expectMissing = (file: string) => expect(fs.access(file)).rejects.toThrow();

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
  it("runs the stored node service command through a live launcher parent", async () => {
    const f = await fixture(`
await ready();
report({pid: process.pid, parentPid: process.ppid, launcherChild: isNodeHostLauncherChild(), argv: process.argv.slice(2)});
process.exit(0);
`);
    const legacyEntrypoint = path.join(f.base, "dist", "index.js");
    await fs.writeFile(legacyEntrypoint, "await import('./entry.js');\n");
    const command = await resolveNodeProgramArguments({
      cliEntrypoint: legacyEntrypoint,
      host: "127.0.0.1",
      port: 18789,
      runtime: "node",
      runtimePath: process.execPath,
    });
    const definitionPath = path.join(f.root, "openclaw-node.service");
    await fs.writeFile(definitionPath, buildSystemdUnit(command));
    const definition = await fs.readFile(definitionPath, "utf8");
    const execStart = definition.split("\n").find((line) => line.startsWith("ExecStart="));
    expect(execStart).toBeDefined();
    const storedArguments = parseSystemdExecStart(execStart!.slice("ExecStart=".length));
    const service = runProgram(f.base, f.stateDir, storedArguments);
    const result = await completed(service);
    const child = JSON.parse(result.stdout.trim());
    expect(child).toMatchObject({
      parentPid: service.child.pid,
      launcherChild: true,
      argv: ["node", "run", "--host", "127.0.0.1", "--port", "18789"],
    });
    expect(child.pid).not.toBe(service.child.pid);
  });

  it("rejects private managed-child arguments without supervisor IPC", async () => {
    const f = await fixture("throw new Error('private arguments must not reach the entry point');");
    const result = await f.run({}, ["--openclaw-node-host-managed-child", f.state, "node", "run"])
      .done;
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("requires a supervisor connection");
  });

  it("revokes the managed state path when supervisor IPC disconnects", async () => {
    const f = await fixture();
    const managed = await f.release(`
await ready();
const before = getManagedNodeHostStatePath();
process.disconnect();
report({before, after: getManagedNodeHostStatePath() ?? null});
process.exit(0);
`);
    await f.select(managed.prefix);
    const result = await completed(f.run());
    expect(JSON.parse(result.stdout.trim())).toEqual({
      before: f.state,
      after: null,
    });
  });

  it("restarts into a healthy candidate, preserving root flags and replacing one-use pairing arguments", async () => {
    const f = await fixture(`
await setNodeHostLauncherRestartArguments(['node', 'run', '--display-name', 'paired']);
${requestUpdate}
`);
    const candidate = await f.release(`
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
`);
    const result = await completed(
      f.update(candidate, {}, ["connect", "one-use-code", "--profile", "work", "--no-color"]),
    );
    const lines = jsonLines(result.stdout);
    expect(lines[0]).toMatchObject({ ok: true });
    expect(lines[1]).toMatchObject({
      argv: ["--profile", "work", "--no-color", "node", "run", "--display-name", "paired"],
      cwd: f.base,
      state: f.state,
      execArgv: ["--disable-warning=ExperimentalWarning"],
    });
    expect(lines[1].first).toBe(lines[1].second);
    await expectSelection(f.current, candidate.prefix);
    await expectMissing(f.lock);
  });

  it("keeps an authenticated candidate serving when its selector cannot be persisted", async () => {
    const f = await fixture();
    const previous = await f.release(
      restartingRuntime("report('fallback-started'); process.exit(9);"),
      "2026.9.1",
    );
    const candidate = await f.release(`
fs.mkdirSync(process.env.TEST_CURRENT + '.' + process.ppid + '.next');
report('candidate-work-started');
await ready();
setTimeout(() => {
  report('candidate-work-complete');
  process.exit(0);
}, 100);
`);
    await f.select(previous.prefix, { stale: true });
    const before = await fs.lstat(f.current);
    const result = await completed(f.update(candidate));
    expect(result.stdout).toContain('"candidate-work-started"');
    expect(result.stdout).toContain('"candidate-work-complete"');
    expect(result.stdout).not.toContain("fallback-started");
    expect(result.stderr).toContain("could not remove the staged node selector");
    expect(result.stderr).toMatch(/could not record the updated node runtime: [^\n]*\bsymlink\b/);
    await expectSelection(f.current, previous.prefix, before.mtimeMs);
    await expectMissing(f.lock);
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
      const f = await fixture();
      const previous = await f.release(body);
      const candidate = await f.release(body, "2026.9.3");
      await f.select(previous.prefix, { stale: true });
      const previousMtime = (await fs.lstat(f.current)).mtimeMs;
      const { env, execArgv } = await windowsSelectorFixture(f.root, f.current, failure);
      const result = await completed(
        f.update(candidate, env, undefined, execArgv),
        failure === "crash" ? 91 : 0,
      );
      const backup = `${f.current}.previous`;
      const interrupted = failure === "rollback-fails" || failure === "crash";
      const persisted = interrupted ? backup : f.current;
      await expectSelection(persisted, previous.prefix, previousMtime);
      await expectMissing(interrupted ? f.current : backup);
      if (failure === "rollback-fails") {
        expect(result.stderr).toContain(backup);
      }
      const restarted = await completed(
        f.run(
          { ...env, TEST_SELECT_ONLY: "1", TEST_RENAME_FAILURE: undefined },
          undefined,
          execArgv,
        ),
      );
      expect(JSON.parse(restarted.stdout.trim())).toEqual({
        version: "2026.9.2",
      });
      if (interrupted) {
        if (failure === "crash") {
          // Crash recovery keeps the existing operator-owned stale-lock policy.
          await fs.unlink(f.lock);
        }
        await completed(
          f.update(candidate, { ...env, TEST_RENAME_FAILURE: undefined }, undefined, execArgv),
        );
        await expectSelection(f.current, candidate.prefix);
        await expectMissing(backup);
      }
      await expectMissing(f.lock);
    },
  );

  it("keeps the previous managed runtime serving after a failed candidate", async () => {
    const reportRuntime =
      "report({version,state:getManagedNodeHostStatePath() ?? null,argv:process.argv.slice(2)});";
    const body = `
${reportRuntime}
${restartingRuntime("await ready(); await restartAndExit('old-runtime-serving', 3, 0);")}
`;
    const f = await fixture(body);
    const previous = await f.release(body, "2026.9.1");
    await f.select(previous.prefix, { stale: true });
    const candidate = await f.release(`${reportRuntime} process.exit(42);`);
    const result = await completed(f.update(candidate));
    expect(result.stdout).toContain('"old-runtime-serving"');
    expect(result.stdout).toContain("12 hours");
    expect(result.stderr).toContain("restarting the previous runtime");
    expect(jsonLines(result.stdout).filter((entry) => entry.version)).toEqual(
      ["2026.9.1", "2026.9.2", "2026.9.1"].map((version) => ({
        version,
        state: f.state,
        argv: ["node", "run"],
      })),
    );
    await expectSelection(f.current, previous.prefix);
  });

  it("keeps the selected runtime when an acknowledged candidate changes before shutdown", async () => {
    const f = await fixture();
    const previous = await f.release(
      `
await ready();
if (fs.existsSync(process.env.TEST_ATTEMPT)) {
  await restartAndExit('previous-runtime-serving', 3, 0);
} else {
  fs.writeFileSync(process.env.TEST_ATTEMPT, 'started');
  await restart();
  report('restart-accepted');
  const manifest = JSON.parse(fs.readFileSync(process.env.TEST_CANDIDATE_MANIFEST, 'utf8'));
  manifest.openclaw.schemaVersions.state += 1;
  fs.writeFileSync(process.env.TEST_CANDIDATE_MANIFEST, JSON.stringify(manifest));
  process.exit(0);
}
`,
      "2026.9.1",
    );
    const candidate = await f.release(`
fs.writeFileSync(process.env.TEST_CANDIDATE_STARTED, 'started');
await ready();
process.exit(0);
`);
    await f.select(previous.prefix, { stale: true });
    const before = await fs.lstat(f.current);
    const candidateStarted = path.join(f.root, "candidate-started");
    const result = await completed(
      f.update(candidate, {
        TEST_CANDIDATE_MANIFEST: path.join(candidate.packageRoot, "package.json"),
        TEST_CANDIDATE_STARTED: candidateStarted,
      }),
    );
    expect(result.stdout).toContain('"restart-accepted"');
    expect(result.stdout).toContain('"previous-runtime-serving"');
    expect(result.stdout).toContain("12 hours");
    expect(result.stderr).toContain("staged node runtime changed before restart");
    await expectSelection(f.current, previous.prefix, before.mtimeMs);
    await expectMissing(candidateStarted);
    await expectMissing(f.lock);
  });

  it("refuses an already-published shared runtime at the backup selector", async () => {
    const f = await fixture(`
fs.symlinkSync(process.env.TEST_SHARED_RUNTIME, process.env.TEST_CURRENT, process.platform === 'win32' ? 'junction' : 'dir');
const old = new Date(Date.now() - 13 * 60 * 60 * 1000);
fs.lutimesSync(process.env.TEST_CURRENT, old, old);
${requestUpdate}
`);
    const current = await f.release(
      "throw new Error('must not relaunch shared runtime');",
      "2026.9.2-1",
    );
    const selectedPath = path.join(f.runtimeDirectory, "current.previous");
    const result = await completed(
      f.update(current, {
        TEST_SHARED_RUNTIME: current.prefix,
        TEST_CURRENT: selectedPath,
      }),
      2,
    );
    expect(result.stdout).toContain("Another node already selected");
    await expectSelection(selectedPath, current.prefix);
  });

  it("rejects automatic activation across database schema versions", async () => {
    const f = await fixture(requestUpdate);
    const candidate = await f.release("throw new Error('must not launch');", undefined, 2);
    const result = await completed(f.update(candidate), 2);
    expect(jsonLines(result.stdout)).toEqual([expect.objectContaining({ ok: false })]);
    expect(result.stdout).toContain("schema");
  });

  it("serializes competing parents until the candidate reconnects", async () => {
    const f = await fixture(requestUpdate);
    const releaseFile = path.join(f.root, "release-candidate");
    const candidate = await f.release(`
report('candidate-started');
const poll = setInterval(async () => {
  if (fs.existsSync(process.env.TEST_RELEASE)) {
    clearInterval(poll);
    await ready();
    setTimeout(() => process.exit(0), 20);
  }
}, 10);
`);
    const env = { TEST_RELEASE: releaseFile };
    const first = f.update(candidate, env);
    await expect.poll(() => first.output(), { timeout: 10_000 }).toContain("candidate-started");
    const second = await completed(f.update(candidate, env), 2);
    expect(second.stdout).toContain("activation lock");
    await fs.writeFile(releaseFile, "release");
    await completed(first);
    await expectSelection(f.current, candidate.prefix);
  });
});
