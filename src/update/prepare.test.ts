import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getUpdateRunAsync, getUpdateRunStatusAsync } from "../infra/update-run-reader.js";
import { createUpdateRunAsync } from "../infra/update-run-write.async.js";
import { defaultRuntime } from "../runtime.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { runReleaseUpdateCli } from "./cli.js";
import { preflight } from "./preflight.js";
import { prepareGit } from "./prepare-git.js";
import { preparePackage } from "./prepare-package.js";
import { prepareUpdate } from "./run.js";
import { resolveTarget } from "./target.js";

const exec = promisify(execFile);
let root: string;
let bin: string;
let node: string;
const originalPath = process.env.PATH;

async function executable(name: string, source: string) {
  const file = path.join(bin, name);
  await fs.writeFile(file, `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
  return file;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-prepare-"));
  bin = path.join(root, "bin");
  await fs.mkdir(bin);
  node = path.join(bin, "node");
  await fs.symlink(process.execPath, node);
  vi.stubEnv("PATH", `${bin}${path.delimiter}${originalPath}`);
  const access = fs.access.bind(fs);
  vi.spyOn(fs, "access").mockImplementation(async (file, mode) => {
    if (file === "/.dockerenv") {
      throw Object.assign(new Error("No container marker in this fixture"), { code: "ENOENT" });
    }
    return access(file, mode);
  });
  for (const key of ["container", "DOCKER_CONTAINER", "OPENCLAW_CONTAINER", "IN_NIX_SHELL"]) {
    vi.stubEnv(key, "");
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

async function repository(failBuild = false, engine = ">=1") {
  const source = path.join(root, "source");
  const bare = path.join(root, "remote.git");
  const checkout = path.join(root, "checkout");
  await fs.mkdir(source);
  const git = (...args: string[]) => exec("git", ["-C", source, ...args]);
  await git("init", "-b", "main");
  await git("config", "user.email", "prepare@example.invalid");
  await git("config", "user.name", "Prepare Fixture");
  await fs.writeFile(
    path.join(source, "package.json"),
    JSON.stringify({
      name: "openclaw",
      version: "2026.11.21",
      engines: { node: engine },
      scripts: { build: "node build.cjs", "ui:build": "node ui.cjs" },
    }),
  );
  await fs.writeFile(path.join(source, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await fs.writeFile(
    path.join(source, "build.cjs"),
    failBuild
      ? "process.stderr.write('\\x1b[33mwarning: build notice\\x1b[0m\\n'.repeat(400) + '\\x1b[31mfixture build failed\\x1b[0m\\n'); process.exit(42);"
      : "const fs=require('node:fs'); fs.mkdirSync('dist'); fs.writeFileSync('dist/build-info.json', JSON.stringify({buildId:'fixture-build'}));",
  );
  await fs.writeFile(
    path.join(source, "ui.cjs"),
    "require('node:fs').writeFileSync('dist/ui-built', 'ready');",
  );
  await git("add", ".");
  await git("commit", "-m", "fixture");
  await exec("git", ["clone", "--bare", source, bare]);
  await exec("git", ["clone", bare, checkout]);
  const sha = (await exec("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
  await executable(
    "pnpm",
    `
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('10.0.0'); process.exit(0); }
fs.appendFileSync('steps.txt', args.join(' ') + '\\n');
if (args[0] === 'install') {
  if (args.join(' ') !== 'install --frozen-lockfile') process.exit(9);
  process.exit(0);
}
const pkg = JSON.parse(fs.readFileSync('package.json'));
const result = cp.spawnSync(pkg.scripts[args[0]], {shell:true, stdio:'inherit'});
process.exit(result.status ?? 1);
`,
  );
  return { checkout, sha };
}

describe("release preparation", () => {
  it("builds the pinned revision in a detached worktree without changing the checkout", async () => {
    const target = await repository();
    const staging = path.join(root, "staging");
    const result = await prepareGit({ ...target, staging, node, timeoutMs: 30_000 });
    expect(result).toMatchObject({ ok: true, version: "2026.11.21", buildId: "fixture-build" });
    expect(await fs.readFile(path.join(staging, "openclaw", "dist", "ui-built"), "utf8")).toBe(
      "ready",
    );
    expect(await fs.readFile(path.join(staging, "openclaw", "steps.txt"), "utf8")).toBe(
      "install --frozen-lockfile\nbuild\nui:build\n",
    );
    expect((await exec("git", ["-C", target.checkout, "status", "--porcelain"])).stdout).toBe("");
    expect(
      await resolveTarget({ kind: "git", channel: "dev", checkout: target.checkout }),
    ).toMatchObject({
      kind: "git",
      sha: target.sha,
      version: "2026.11.21",
    });
  });

  it("removes failed staging and Git registration while preserving the stderr tail", async () => {
    const target = await repository(true);
    const staging = path.join(root, "staging");
    const result = await prepareGit({ ...target, staging, node, timeoutMs: 30_000 });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected failed build");
    }
    expect(result.reason).toBe("build-failed");
    expect(result.stderrTail).toContain("fixture build failed");
    expect(result.stderrTail.length).toBeLessThanOrEqual(8192);
    await expect(fs.access(staging)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await exec("git", ["-C", target.checkout, "worktree", "list"])).stdout).not.toContain(
      staging,
    );
  });

  it("stores and reports the actual build error after ANSI-colored warnings", async () => {
    const { checkout } = await repository(true);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("GIT_COMMIT", "");
    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    try {
      openOpenClawStateDatabase({ env: process.env });
      await runReleaseUpdateCli({
        json: false,
        restart: false,
        runningRoot: checkout,
        storedChannel: "dev",
        timeoutMs: 30_000,
      });
      const { lastRun } = await getUpdateRunStatusAsync();
      expect(lastRun).toMatchObject({ status: "failed", reason: "build-failed" });
      const detail = lastRun?.steps.find(({ step }) => step === "outcome")?.detail;
      expect(detail).toContain("fixture build failed");
      expect(detail).not.toContain("\x1b");
      expect(detail?.length).toBeLessThanOrEqual(1024);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("fixture build failed"));
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = undefined;
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
    }
  });

  it("installs a package with lifecycle scripts enabled and without the migration marker", async () => {
    const npm = await executable(
      "npm",
      `
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
if (process.env.OPENCLAW_UPDATE_IN_PROGRESS || !args.includes('--ignore-scripts=false')) process.exit(7);
const prefix = args[args.indexOf('--prefix') + 1];
const root = path.join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules', 'openclaw');
fs.mkdirSync(root, {recursive:true});
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({name:'openclaw',version:'2026.11.21'}));
fs.writeFileSync(path.join(root, 'argv.json'), JSON.stringify(args));
`,
    );
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
    const staging = path.join(root, "staging");
    const result = await preparePackage({
      spec: "openclaw@2026.11.21",
      staging,
      npm,
      node,
      timeoutMs: 10_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.stderrTail);
    }
    expect(
      JSON.parse(await fs.readFile(path.join(result.releaseRoot, "argv.json"), "utf8")),
    ).toEqual([
      "install",
      "-g",
      "--prefix",
      staging,
      "openclaw@2026.11.21",
      "--no-fund",
      "--no-audit",
      "--ignore-scripts=false",
    ]);
    const published = path.join(root, "published");
    await fs.rename(staging, published);
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(published, path.relative(staging, result.releaseRoot), "package.json"),
          "utf8",
        ),
      ).version,
    ).toBe("2026.11.21");
  });
});

describe("already-current update", () => {
  const pluginResult = (overrides: object) => ({
    status: "ok",
    changed: false,
    warnings: [],
    sync: { changed: false, switchedToBundled: [], switchedToNpm: [], warnings: [], errors: [] },
    npm: { changed: false, outcomes: [] },
    integrityDrifts: [],
    ...overrides,
  });
  const linked =
    'Retained linked plugin "irc" at extensions/irc; update this plugin at its source.';

  it.each([
    {
      name: "a change",
      result: pluginResult({ changed: true }),
      changed: true,
      detail: undefined,
    },
    {
      // The existing updater's warning result is a note, not a failed step.
      name: "a warning note",
      result: pluginResult({
        status: "warning",
        sync: {
          changed: false,
          switchedToBundled: [],
          switchedToNpm: [],
          warnings: [linked],
          errors: [],
        },
      }),
      changed: false,
      detail: linked,
    },
  ])("still maintains plugins with the serving code and records $name", async (expected) => {
    const { checkout, sha } = await repository();
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    // The serving build was made from the target commit.
    vi.stubEnv("GIT_COMMIT", sha);
    // The serving release's own `update plugins`: records its argv and prints its result.
    await fs.writeFile(
      path.join(checkout, "openclaw.mjs"),
      [
        "import fs from 'node:fs';",
        "fs.writeFileSync('plugins-argv.json', JSON.stringify(process.argv.slice(2)));",
        `console.log(${JSON.stringify(JSON.stringify(expected.result))});`,
      ].join("\n"),
    );
    try {
      openOpenClawStateDatabase({ env: process.env });
      const run = await createUpdateRunAsync({ trigger: "cli", before: { version: "2026.11.21" } });
      const outcome = await prepareUpdate({
        runId: run.runId,
        runningRoot: checkout,
        runningVersion: "2026.11.21",
        channel: "dev",
        sha,
        node,
      });
      expect(outcome).toMatchObject({ status: "current", pluginsChanged: expected.changed });
      expect(
        JSON.parse(await fs.readFile(path.join(checkout, "plugins-argv.json"), "utf8")),
      ).toEqual([
        "update",
        "plugins",
        "--json",
        "--channel",
        "dev",
        "--timeout",
        expect.stringMatching(/^\d+$/),
      ]);
      const record = await getUpdateRunAsync(run.runId);
      expect(record).toMatchObject({ status: "skipped", reason: "already-current" });
      const plugins = record?.steps.find(({ step }) => step === "plugins");
      expect(plugins?.status).toBe("completed");
      expect(plugins?.detail).toBe(expected.detail);
    } finally {
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
    }
  });
});

describe("update preflight", () => {
  it("refuses an incompatible engine before preparation", async () => {
    const target = await repository(false, ">=999");
    expect(
      await preflight({
        kind: "git",
        target: { kind: "git", ...target, version: "2026.11.21" },
        prefix: root,
        stateDir: root,
        node,
      }),
    ).toMatchObject({ ok: false, reason: "node-engine-mismatch" });
  });

  it("refuses a missing required tool", async () => {
    const target = await repository();
    await fs.rm(path.join(bin, "pnpm"));
    expect(
      await preflight({
        kind: "git",
        target: { kind: "git", ...target, version: "2026.11.21" },
        prefix: root,
        stateDir: root,
        env: { ...process.env, PATH: bin },
      }),
    ).toMatchObject({ ok: false, reason: "missing-tool" });
  });

  it("refuses a checkout with local changes before preparation", async () => {
    const target = await repository();
    await fs.appendFile(path.join(target.checkout, "package.json"), "\n");
    expect(
      await preflight({
        kind: "git",
        target: { kind: "git", ...target, version: "2026.11.21" },
        prefix: root,
        stateDir: root,
        node,
      }),
    ).toMatchObject({ ok: false, reason: "dirty" });
  });

  it("refuses insufficient installation and state disk space", async () => {
    const target = await repository();
    const params = {
      kind: "git" as const,
      target: { kind: "git" as const, ...target, version: "2026.11.21" },
      prefix: root,
      stateDir: path.join(root, "data"),
      node,
    };
    expect(
      await preflight({ ...params, statfs: async () => ({ bavail: 1, bsize: 1 }) }),
    ).toMatchObject({ ok: false, reason: "insufficient-install-space" });
    await fs.mkdir(path.join(params.stateDir, "state"), { recursive: true });
    await fs.writeFile(path.join(params.stateDir, "state", "openclaw.sqlite"), "database bytes");
    expect(
      await preflight({
        ...params,
        statfs: async (file) => ({ bavail: file === root ? 2_000_000_000 : 1, bsize: 1 }),
      }),
    ).toMatchObject({ ok: false, reason: "insufficient-state-space" });
  });

  it("counts state databases past a dangling link a tool left in an agent home", async () => {
    const target = await repository();
    const stateDir = path.join(root, "data");
    const shims = path.join(stateDir, "agents", "main", "agent", "codex-home", "tmp", "arg0");
    await fs.mkdir(shims, { recursive: true });
    await fs.symlink(path.join(root, "gone", "apply_patch"), path.join(shims, "apply_patch"));
    await fs.writeFile(
      path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
      "database bytes",
    );
    const params = {
      kind: "git" as const,
      target: { kind: "git" as const, ...target, version: "2026.11.21" },
      prefix: root,
      stateDir,
      node,
    };
    expect(
      await preflight({
        ...params,
        statfs: async (file) => ({ bavail: file === root ? 2_000_000_000 : 1, bsize: 1 }),
      }),
    ).toMatchObject({ ok: false, reason: "insufficient-state-space" });
  });

  it("refuses a Docker marker without running any preparation", async () => {
    const access = fs.access.bind(fs);
    vi.spyOn(fs, "access").mockImplementation(async (file, mode) => {
      if (file === "/.dockerenv") {
        return;
      }
      return access(file, mode);
    });
    expect(
      await preflight({
        kind: "package",
        target: { kind: "package", spec: "openclaw@2026.11.21", version: "2026.11.21" },
        prefix: root,
        stateDir: root,
      }),
    ).toMatchObject({ ok: false, reason: "container-install" });
  });
});
