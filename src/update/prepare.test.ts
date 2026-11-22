import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getUpdateRunAsync, listUpdateRunsAsync } from "../infra/update-run-reader.js";
import { createUpdateRunAsync } from "../infra/update-run-write.async.js";
import type { OpenClawSchemaVersions } from "../state/openclaw-schema-versions.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import * as serviceConversion from "./convert-service.js";
import { preflight } from "./preflight.js";
import { prepareGit } from "./prepare-git.js";
import { preparePackage } from "./prepare-package.js";
import { prepareUpdate } from "./run.js";
import { readTrial, resolvePrefix } from "./store.js";
import * as targets from "./target.js";
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

async function repository(
  failBuild = false,
  engine = ">=1",
  releaseAware = false,
  schemaVersions?: OpenClawSchemaVersions,
) {
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
      ...(schemaVersions ? { openclaw: { schemaVersions } } : {}),
    }),
  );
  await fs.writeFile(path.join(source, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  if (releaseAware) {
    await fs.mkdir(path.join(source, "src", "update"), { recursive: true });
    await fs.writeFile(path.join(source, "src", "update", "check-release.ts"), "");
  }
  await fs.writeFile(
    path.join(source, "openclaw.mjs"),
    `if (process.argv[3] === 'check-release') {
      ${releaseAware ? "console.log(JSON.stringify({ok:true,surfaces:[]}));" : "throw new Error('unsupported command');"}
    } else console.log(JSON.stringify({status:'ok',changed:false,warnings:[],sync:{warnings:[],errors:[]},npm:{outcomes:[]}}));`,
  );
  await fs.writeFile(
    path.join(source, "build.cjs"),
    failBuild
      ? "process.stderr.write('x'.repeat(10000) + 'fixture build failed'); process.exit(42);"
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
  it("keeps the repository HEAD recognizable as release-aware", async () => {
    const checkout = await fs.realpath(new URL("../../", import.meta.url));
    expect(await targets.gitTargetSupportsReleaseUpdates(checkout, "HEAD", 30_000)).toBe(true);
  });

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

  it.each([
    { engine: ">=1", source: "tag" },
    { engine: ">=999", source: "override" },
  ])(
    "checks package Node $engine from the $source before installing production dependencies",
    async ({ engine, source }) => {
      const packedRoot = path.join(root, "packed", "package");
      await fs.mkdir(packedRoot, { recursive: true });
      await fs.writeFile(
        path.join(packedRoot, "package.json"),
        JSON.stringify({
          name: "openclaw",
          version: "2026.11.21",
          engines: { node: engine },
          devDependencies: { "fixture-development-only": "1.0.0" },
          dependencies: { "fixture-runtime": "2.0.0" },
          scripts: { prepare: "node development-only.mjs", postinstall: "node production.mjs" },
        }),
      );
      const archive = path.join(root, "openclaw.tgz");
      await exec("tar", ["-czf", archive, "-C", path.dirname(packedRoot), "package"]);
      const npm = await executable(
        "npm",
        `
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
if (process.env.OPENCLAW_UPDATE_IN_PROGRESS) process.exit(7);
if (args[0] === 'pack') {
  fs.copyFileSync(${JSON.stringify(archive)}, 'openclaw.tgz');
  console.log(JSON.stringify([{filename:'openclaw.tgz',name:'openclaw',version:'2026.11.21'}]));
} else {
  if (process.cwd().split(path.sep).includes('node_modules')) process.exit(8);
  if (!args.includes('--ignore-scripts=false') || !args.includes('--omit=dev') || args.includes('-g')) process.exit(9);
  const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  if ('devDependencies' in manifest || 'prepare' in manifest.scripts) process.exit(10);
  if (manifest.dependencies['fixture-runtime'] !== '2.0.0' || manifest.scripts.postinstall !== 'node production.mjs') process.exit(11);
  fs.writeFileSync(${JSON.stringify(path.join(root, "dependencies-installed"))}, 'yes');
  fs.writeFileSync('argv.json', JSON.stringify(args));
}
`,
      );
      if (source === "override") {
        vi.stubEnv("OPENCLAW_UPDATE_PACKAGE_SPEC", `file:${archive}`);
      }
      expect(
        await resolveTarget({
          kind: "package",
          channel: "stable",
          ...(source === "tag" ? { tag: `file:${archive}` } : {}),
        }),
      ).toEqual({
        kind: "package",
        spec: `file:${archive}`,
        version: "2026.11.21",
        engines: { node: engine },
      });
      vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
      const staging = path.join(root, "staging");
      const result = await preparePackage({
        spec: "openclaw@2026.11.21",
        staging,
        npm,
        node,
        timeoutMs: 10_000,
      });
      if (engine === ">=999") {
        expect(result).toMatchObject({ ok: false, reason: "node-engine-mismatch" });
        await expect(fs.stat(path.join(root, "dependencies-installed"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(fs.stat(staging)).rejects.toMatchObject({ code: "ENOENT" });
        return;
      }
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(result.stderrTail);
      }
      expect(
        JSON.parse(await fs.readFile(path.join(result.releaseRoot, "argv.json"), "utf8")),
      ).toEqual(["install", "--omit=dev", "--no-fund", "--no-audit", "--ignore-scripts=false"]);
      expect(result.releaseRoot).toBe(path.join(staging, "openclaw"));
      await expect(fs.stat(path.join(staging, "openclaw.tgz"))).rejects.toMatchObject({
        code: "ENOENT",
      });
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
    },
  );
});

describe("package release conversion", () => {
  it.each([true, false])("publishes a Git target with release support %s", async (releaseAware) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    const target = await repository(false, ">=1", releaseAware);
    try {
      openOpenClawStateDatabase({ env: process.env });
      const run = await createUpdateRunAsync({ trigger: "cli", before: { version: "2026.11.6" } });
      const outcome = await prepareUpdate({
        runId: run.runId,
        runningRoot: target.checkout,
        runningVersion: "2026.11.6",
        channel: "dev",
        node,
      });
      expect(outcome.status).toBe(releaseAware ? "pending" : "published");
      if (releaseAware) {
        expect(await readTrial()).toMatchObject({ phase: "pending", runId: run.runId });
      } else {
        expect((await getUpdateRunAsync(run.runId))?.steps).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ step: "legacy-target", status: "completed" }),
          ]),
        );
        expect((await getUpdateRunAsync(run.runId))?.status).toBe("succeeded");
        expect(await readTrial()).toBeNull();
        if (outcome.status === "published") {
          expect(await fs.realpath(path.join(resolvePrefix(), "openclaw"))).toBe(
            outcome.releaseRoot,
          );
        }
      }
    } finally {
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
    }
  });

  it("refuses an unwritable global package before preparing or forwarding it", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    const runningRoot = path.join(root, "global-package");
    await fs.mkdir(runningRoot);
    vi.spyOn(targets, "resolveTarget").mockResolvedValue({
      kind: "package",
      version: "2026.11.21",
      spec: "openclaw@2026.11.21",
    });
    const access = vi.mocked(fs.access).getMockImplementation()!;
    vi.mocked(fs.access).mockImplementation(async (file, mode) => {
      if (file === runningRoot) {
        throw Object.assign(new Error("Read-only global package"), { code: "EACCES" });
      }
      return access(file, mode);
    });
    try {
      openOpenClawStateDatabase({ env: process.env });
      const run = await createUpdateRunAsync({ trigger: "cli", before: { version: "2026.11.6" } });
      expect(
        await prepareUpdate({
          runId: run.runId,
          runningRoot,
          runningVersion: "2026.11.6",
          channel: "stable",
          node,
        }),
      ).toMatchObject({ status: "failed", reason: "package-not-writable" });
      expect(await fs.readdir(runningRoot)).toEqual([]);
      expect(await readTrial()).toBeNull();
    } finally {
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
    }
  });

  it.each([true, false])("prepares a package with release support %s", async (releaseAware) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    const runningRoot = path.join(root, "global", "node_modules", "openclaw");
    await fs.mkdir(path.join(runningRoot, "dist"), { recursive: true });
    await fs.writeFile(path.join(runningRoot, "package.json"), '{"type":"module"}');
    await fs.copyFile(
      new URL("../../release-launcher-forward.mjs", import.meta.url),
      path.join(runningRoot, "release-launcher-forward.mjs"),
    );
    for (const entry of ["openclaw.mjs", "dist/index.js"]) {
      const relative = entry === "openclaw.mjs" ? "./" : "../";
      await fs.writeFile(
        path.join(runningRoot, entry),
        `import { forwardToReleaseLauncher } from '${relative}release-launcher-forward.mjs';
if (!(await forwardToReleaseLauncher(new URL('${relative}', import.meta.url)))) console.log('running');`,
      );
    }
    await fs.writeFile(path.join(runningRoot, "dist", "entry.js"), "console.log('running');");
    const packedRoot = path.join(root, "packed", "package");
    await fs.mkdir(packedRoot, { recursive: true });
    await fs.mkdir(path.join(packedRoot, "dist"));
    if (releaseAware) {
      for (const name of ["check-release", "gateway-trial"]) {
        await fs.writeFile(path.join(packedRoot, "dist", `${name}-fixture.mjs`), "");
      }
    }
    await fs.writeFile(
      path.join(packedRoot, "package.json"),
      '{"name":"openclaw","version":"2026.11.21","type":"module"}',
    );
    await fs.writeFile(
      path.join(packedRoot, "openclaw.mjs"),
      `console.log(JSON.stringify(process.argv[3] === 'check-release'
  ? {ok:true,surfaces:[]}
  : {status:'ok',changed:false,warnings:[],sync:{warnings:[],errors:[]},npm:{outcomes:[]}}));`,
    );
    const archive = path.join(root, "candidate.tgz");
    await exec("tar", ["-czf", archive, "-C", path.dirname(packedRoot), "package"]);
    await executable(
      "npm",
      `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('11.0.0');
else if (args[0] === 'view') console.log('{}');
else if (args[0] === 'pack') {
  fs.copyFileSync(${JSON.stringify(archive)}, 'candidate.tgz');
  console.log('[{"filename":"candidate.tgz"}]');
}`,
    );
    vi.spyOn(targets, "resolveTarget").mockResolvedValue({
      kind: "package",
      version: "2026.11.21",
      spec: archive,
      engines: {},
    });
    const prefix = resolvePrefix();
    // Native service publication has its own backup/reload proof. At its boundary the
    // running link must already work, while the global package must not yet forward.
    vi.spyOn(serviceConversion, "stageReleaseService").mockImplementation(async () => {
      expect(await fs.realpath(path.join(prefix, "openclaw"))).toBe(await fs.realpath(runningRoot));
      await expect(fs.stat(path.join(runningRoot, ".openclaw-launcher"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
    try {
      openOpenClawStateDatabase({ env: process.env });
      const run = await createUpdateRunAsync({ trigger: "cli", before: { version: "2026.11.21" } });
      const outcome = await prepareUpdate({
        runId: run.runId,
        runningRoot,
        runningVersion: "2026.11.21",
        channel: "stable",
        node,
      });
      if (!releaseAware) {
        expect(outcome).toMatchObject({ status: "published", target: { version: "2026.11.21" } });
        expect(await readTrial(prefix)).toBeNull();
        if (outcome.status === "published") {
          expect(await fs.realpath(path.join(prefix, "openclaw"))).toBe(outcome.releaseRoot);
        }
        expect((await getUpdateRunAsync(run.runId))?.status).toBe("succeeded");
        expect((await getUpdateRunAsync(run.runId))?.steps).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ step: "legacy-target", status: "completed" }),
          ]),
        );
        expect(serviceConversion.stageReleaseService).toHaveBeenCalledOnce();
        return;
      }
      expect(outcome).toMatchObject({ status: "pending", target: { version: "2026.11.21" } });
      expect(await readTrial(prefix)).toMatchObject({
        phase: "pending",
        previous: runningRoot,
      });
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("OPENCLAW_")),
      );
      for (const entry of ["openclaw.mjs", "dist/index.js"]) {
        const result = await exec(node, [path.join(runningRoot, entry), "--version"], { env });
        expect(result.stdout.trim()).toBe("running");
      }
      expect((await readTrial(prefix))?.phase).toBe("pending");
    } finally {
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
    }
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

  it("uses an artifact target's engine metadata without querying it as a registry version", async () => {
    await executable(
      "npm",
      "if (process.argv[2] !== '--version') process.exit(91); console.log('11.0.0');",
    );
    expect(
      await preflight({
        kind: "package",
        target: {
          kind: "package",
          spec: path.join(root, "release.tgz"),
          version: "2026.11.21",
          engines: { node: ">=999" },
        },
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
