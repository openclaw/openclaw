import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import * as nodeService from "../daemon/node-service.js";
import * as runtimePaths from "../daemon/runtime-paths.js";
import * as gatewayService from "../daemon/service.js";
import { createMockGatewayService } from "../daemon/service.test-helpers.js";
import { createDoctorRuntimeProjection } from "../flows/doctor-health-contributions.test-support.js";
import { readGatewayLockProcessNamespace } from "../infra/gateway-lock-payload.js";
import { readGatewayLockProcessStartTime } from "../infra/gateway-lock-process.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import * as processCensus from "../infra/openclaw-process-census.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import {
  getUpdateRunAsync,
  getUpdateRunStatusAsync,
  listUpdateRunsAsync,
} from "../infra/update-run-reader.js";
import { createUpdateRunAsync } from "../infra/update-run-write.async.js";
import { pluginProcessRuntimeEntrypoints } from "../plugins/process-runtime.test-support.js";
import { defaultRuntime } from "../runtime.js";
import { stateNativeProcessEntrypoints } from "../state/native-process-runtime.test-support.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "../state/openclaw-schema-versions.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { VERSION } from "../version.js";
import { runReleaseUpdateCli } from "./cli.js";
import * as serviceConversion from "./convert-service.js";
import { settleRunFromTrial } from "./gateway-trial.js";
import { preflight } from "./preflight.js";
import { registerAlreadyCurrentUpdateTests } from "./prepare-current.test-support.js";
import { prepareGit } from "./prepare-git.js";
import { preparePackage } from "./prepare-package.js";
import { bin, executable, node, repository, root } from "./prepare.test-support.js";
import { prepareUpdate } from "./run.js";
import { readTrial, resolvePrefix, switchLink } from "./store.js";
import * as targets from "./target.js";
import { resolveTarget } from "./target.js";

const exec = promisify(execFile);
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
    expect(await fs.readFile(path.join(staging, "openclaw", "ui-builds.txt"), "utf8")).toBe("ui\n");
    expect(await fs.readFile(path.join(staging, "openclaw", "steps.txt"), "utf8")).toBe(
      "install --frozen-lockfile\nbuild\n",
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

  it("builds with the target's pnpm when no pnpm is on PATH", async () => {
    // Installers bootstrap pnpm only for their own build; the update must provision it again.
    const target = await repository();
    const pnpm = path.join(root, "pnpm-from-corepack");
    await fs.rename(path.join(bin, "pnpm"), pnpm);
    await executable(
      "corepack",
      `
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('0.34.0'); process.exit(0); }
if (args[0] !== 'enable' || args.at(-1) !== 'pnpm') process.exit(5);
fs.copyFileSync(${JSON.stringify(pnpm)}, path.join(args[args.indexOf('--install-directory') + 1], 'pnpm'));
`,
    );
    const [git = ""] = (
      await exec(process.platform === "win32" ? "where" : "which", ["git"])
    ).stdout
      .trim()
      .split(/\r?\n/u);
    const gitPath = (process.env.PATH ?? "")
      .split(path.delimiter)
      .filter((entry) => entry !== bin)
      .join(path.delimiter);
    // Git wrappers need their own tools without exposing host pnpm to the updater.
    await executable(
      "git",
      `
const { spawnSync } = require('node:child_process');
const result = spawnSync(${JSON.stringify(git)}, process.argv.slice(2), {
  env: { ...process.env, PATH: ${JSON.stringify(gitPath)} },
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`,
    );
    vi.stubEnv("PATH", bin);
    const staging = path.join(root, "staging");
    const result = await prepareGit({ ...target, staging, node, timeoutMs: 30_000 });
    expect(result).toMatchObject({ ok: true, version: "2026.11.21", buildId: "fixture-build" });
    expect(await fs.readFile(path.join(staging, "openclaw", "steps.txt"), "utf8")).toBe(
      "install --frozen-lockfile\nbuild\n",
    );
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
    const { checkout } = await repository(true, ">=1", true);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("GIT_COMMIT", "");
    // An earlier updater's leftover is reclaimed before the update; the outcome stays the build's.
    const abandoned = createDoctorRuntimeProjection(path.join(root, "tmp"), checkout, "Gone01");
    vi.spyOn(processCensus, "inspectOtherOpenClawProcesses").mockReturnValue({ pids: [] });
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    try {
      openOpenClawStateDatabase({ env: process.env });
      await runReleaseUpdateCli({
        json: false,
        restart: false,
        runningRoot: checkout,
        storedChannel: "dev",
      });
      const { lastRun } = await getUpdateRunStatusAsync();
      expect(lastRun).toMatchObject({ status: "failed", reason: "build-failed" });
      expect(lastRun?.steps.find(({ step }) => step === "prepare:install")).toMatchObject({
        status: "completed",
        endedAtMs: expect.any(Number),
      });
      expect(lastRun?.steps.find(({ step }) => step === "prepare:build")?.status).toBe("failed");
      const detail = lastRun?.steps.find(({ step }) => step === "outcome")?.detail;
      expect(detail).toContain("fixture build failed");
      expect(detail).not.toContain("\x1b");
      expect(detail?.length).toBeLessThanOrEqual(1024);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("fixture build failed"));
      expect(process.exitCode).toBe(1);
      await expect(fs.access(abandoned)).rejects.toMatchObject({ code: "ENOENT" });
      expect(log).toHaveBeenCalledWith(`Removed abandoned updater runtime: ${abandoned}`);
    } finally {
      process.exitCode = undefined;
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
    }
  });

  it.each([
    { version: "2026.11.6", maintained: true },
    { version: VERSION, maintained: false },
  ])(
    "maintains plugins before a trial only for a downgrade ($version)",
    async ({ version, maintained }) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
      const marker = path.join(root, "plugin-maintained");
      const { checkout } = await repository(
        false,
        ">=1",
        true,
        undefined,
        `fs.writeFileSync(${JSON.stringify(marker)}, 'maintained');
       console.log(JSON.stringify({status:'ok',changed:false,warnings:[],sync:{warnings:[],errors:[]},npm:{outcomes:[]}}));`,
        version,
      );
      try {
        const run = await createUpdateRunAsync({ trigger: "cli", before: { version: VERSION } });
        expect(
          await prepareUpdate({
            runId: run.runId,
            runningRoot: checkout,
            runningVersion: "2026.11.5",
            channel: "dev",
            node,
          }),
        ).toMatchObject({ status: "pending" });
        expect(await fs.readFile(marker, "utf8").catch(() => null)).toBe(
          maintained ? "maintained" : null,
        );
        const record = await getUpdateRunAsync(run.runId);
        expect(record?.steps.filter(({ step }) => step === "plugins")).toMatchObject(
          maintained ? [{ status: "completed" }] : [],
        );
        expect(await readTrial()).toMatchObject({ phase: "pending", version });
      } finally {
        await closeOpenClawStateDatabaseAsync();
        closeOpenClawStateDatabaseForTest();
      }
    },
  );

  it("defers candidate plugin maintenance while the old Gateway owns an older state schema", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("GIT_COMMIT", "");
    const lifecycleUrl = resolveRuntimeWorkerUrl(pluginProcessRuntimeEntrypoints.lifecycleLease);
    const database = openOpenClawStateDatabase({ env: process.env });
    // Exercise the candidate's real plugin lease and schema admission, not plugin-result JSON.
    const admission = `
      import { withPluginLifecycleLease } from ${JSON.stringify(lifecycleUrl.href)};
      import { closeOpenClawStateDatabaseAsync } from ${JSON.stringify(
        resolveRuntimeWorkerUrl(stateNativeProcessEntrypoints.stateDatabase).href,
      )};
      try {
        await withPluginLifecycleLease({waitMs:0}, async (lease) => lease.assertOwned());
      } finally {
        await closeOpenClawStateDatabaseAsync();
      }
    `;
    const { checkout } = await repository(
      false,
      ">=1",
      true,
      { state: OPENCLAW_STATE_SCHEMA_VERSION, agent: OPENCLAW_AGENT_SCHEMA_VERSION },
      `const child = spawnSync(process.execPath, ${JSON.stringify([
        ...resolveRuntimeWorkerArgv(lifecycleUrl).slice(0, -1),
        "--input-type=module",
        "--eval",
        admission,
      ])}, {stdio:'inherit'});
       process.exit(child.status ?? 1);`,
      VERSION,
    );
    const owner = acquireGatewayStateOwner({
      databasePath: database.path,
      payload: {
        pid: process.pid,
        createdAt: new Date().toISOString(),
        configPath: path.join(root, "openclaw.json"),
        port: 18789,
        startTime:
          readGatewayLockProcessStartTime(process.pid, process.platform, 1000) ?? undefined,
        processNamespace: readGatewayLockProcessNamespace(),
        role: "gateway",
      },
    });
    const argv = process.argv;
    process.argv = [node, path.join(checkout, "openclaw.mjs"), "gateway"];
    try {
      await owner.run(async () => {
        const run = await createUpdateRunAsync({
          trigger: "cli",
          before: { version: "2026.11.6" },
        });
        // Keep the serving handles and ledger alive, but expose an older on-disk schema
        // to the separate candidate process, whose compiled schema contract is current.
        database.db.exec(`
          PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1};
          UPDATE schema_meta SET schema_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1} WHERE meta_key = 'primary';
        `);
        const outcome = await prepareUpdate({
          runId: run.runId,
          runningRoot: checkout,
          runningVersion: "2026.11.6",
          channel: "dev",
          node,
          acceptCapabilities: true,
        });
        expect(outcome).toMatchObject({ status: "pending" });
        const record = await getUpdateRunAsync(run.runId);
        expect(record?.steps.filter(({ step }) => step === "plugins")).toEqual([]);
        expect(await readTrial()).toMatchObject({ phase: "pending", acceptCapabilities: true });
        owner.assertCurrent();
      });
    } finally {
      process.argv = argv;
      database.db.exec(`
        PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};
        UPDATE schema_meta SET schema_version = ${OPENCLAW_STATE_SCHEMA_VERSION} WHERE meta_key = 'primary';
      `);
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      owner.release();
    }
  });

  it.each([
    { engine: ">=1", source: "tag", runtime: "node", npm: 11 },
    { engine: ">=999", source: "override", runtime: "node", npm: 11 },
    { engine: ">=999", source: "tag", runtime: "bun", npm: 12 },
  ])(
    "checks package $runtime with Node $engine and npm $npm from the $source before installing production dependencies",
    async ({ engine, source, runtime, npm: npmVersion }) => {
      const packedRoot = path.join(root, "packed", "package");
      await fs.mkdir(packedRoot, { recursive: true });
      await fs.writeFile(
        path.join(packedRoot, "package.json"),
        JSON.stringify({
          name: "openclaw",
          version: "2026.11.21",
          engines: { node: engine },
          devDependencies: { "fixture-development-only": "1.0.0" },
          workspaces: ["ui", "tools/solid-lint"],
          dependencies: { "fixture-runtime": "2.0.0" },
          scripts: { prepare: "node development-only.mjs", postinstall: "node production.mjs" },
        }),
      );
      await fs.writeFile(path.join(packedRoot, "pnpm-workspace.yaml"), "packages:\n  - ui\n");
      const archive = path.join(root, "openclaw.tgz");
      await exec("tar", ["-czf", archive, "-C", path.dirname(packedRoot), "package"]);
      const installScript = `
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
if (process.env.OPENCLAW_UPDATE_IN_PROGRESS) process.exit(7);
if (args[0] === 'pack') {
  fs.copyFileSync(${JSON.stringify(archive)}, 'openclaw.tgz');
  const entry = {id:'openclaw@2026.11.21',filename:'openclaw.tgz',name:'openclaw',version:'2026.11.21'};
  const output = JSON.stringify(${npmVersion} === 12 ? {openclaw:entry} : [entry]);
  process.stdout.write(${npmVersion} === 12 ? output.slice(0, 32) : output);
} else {
  if (process.cwd().split(path.sep).includes('node_modules')) process.exit(8);
  if (${JSON.stringify(runtime)} === 'bun'
    ? args.includes('--production') || !args.includes('--trust')
    : !args.includes('--ignore-scripts=false') || !args.includes('--omit=dev')) process.exit(9);
  if (args.includes('-g')) process.exit(12);
  const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  if ('devDependencies' in manifest || 'workspaces' in manifest || 'prepare' in manifest.scripts) process.exit(10);
  if (fs.existsSync('pnpm-workspace.yaml')) process.exit(13);
  if (manifest.dependencies['fixture-runtime'] !== '2.0.0' || manifest.scripts.postinstall !== 'node production.mjs') process.exit(11);
  fs.writeFileSync(${JSON.stringify(path.join(root, "dependencies-installed"))}, 'yes');
  fs.writeFileSync('argv.json', JSON.stringify(args));
}
`;
      const npm = await executable("npm", installScript);
      const runner = runtime === "bun" ? await executable("bun", installScript) : node;
      if (source === "override") {
        vi.stubEnv("OPENCLAW_UPDATE_PACKAGE_SPEC", `file:${archive}`);
      }
      const staging = path.join(root, "staging");
      await fs.mkdir(staging);
      const selected = await resolveTarget({
        kind: "package",
        channel: "stable",
        archiveWorkspace: staging,
        ...(source === "tag" ? { tag: `file:${archive}` } : {}),
      });
      if (selected.kind !== "package" || !selected.archivePath) {
        throw new Error("Expected a package target with an owned archive");
      }
      expect(selected).toEqual({
        kind: "package",
        spec: `file:${archive}`,
        archivePath: expect.any(String),
        version: "2026.11.21",
        engines: { node: engine },
        schemaVersions: undefined,
      });
      expect(path.dirname(selected.archivePath)).toBe(staging);
      vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
      // The original source can disappear: preparation must consume the metadata's one archive.
      await fs.rm(archive);
      const result = await preparePackage({
        spec: selected.spec,
        archivePath: selected.archivePath,
        staging,
        npm: [npm],
        node: runner,
        timeoutMs: 10_000,
      });
      if (engine === ">=999" && runtime === "node") {
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
      ).toEqual(
        runtime === "bun"
          ? ["install", "--trust"]
          : ["install", "--omit=dev", "--no-fund", "--no-audit", "--ignore-scripts=false"],
      );
      expect(result.releaseRoot).toBe(path.join(staging, "openclaw"));
      await expect(fs.stat(selected.archivePath)).rejects.toMatchObject({
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
  it.each([true, false])("admits a Git target with release support %s", async (releaseAware) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    const target = await repository(false, ">=1", releaseAware);
    vi.stubEnv("HOME", root);
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
      expect(outcome.status).toBe(releaseAware ? "pending" : "failed");
      if (releaseAware) {
        expect(await readTrial()).toMatchObject({ phase: "pending", runId: run.runId });
      } else {
        expect(outcome).toMatchObject({
          reason: "release-updates-unsupported",
          message: expect.stringContaining(`git checkout ${target.sha}`),
        });
        if (outcome.status !== "failed") {
          throw new Error("Expected unsupported-target refusal");
        }
        expect(outcome.message).not.toContain("~");
        expect(outcome.message).not.toContain(`"${target.checkout}"`);
        expect(await listUpdateRunsAsync()).toMatchObject([{ runId: run.runId, status: "failed" }]);
        expect(await readTrial()).toBeNull();
        expect(await fs.readdir(path.join(resolvePrefix(), "releases"))).toEqual([]);
        await expect(
          fs.stat(path.join(target.checkout, ".openclaw-launcher")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
    }
  });

  it.each(["git", "package"] as const)(
    "refuses an older %s schema before staging",
    async (kind) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
      const schemaVersions = { state: 36, agent: 43 };
      const target = await repository(false, ">=1", false, schemaVersions);
      const runningRoot = kind === "git" ? target.checkout : path.join(root, "global-package");
      if (kind === "package") {
        await fs.mkdir(runningRoot);
        vi.spyOn(targets, "resolveTarget").mockResolvedValue({
          kind: "package",
          version: "2026.11.6",
          spec: "openclaw@2026.11.6",
          engines: {},
          schemaVersions,
        });
      }
      try {
        openOpenClawStateDatabase({ env: process.env });
        const run = await createUpdateRunAsync({
          trigger: "cli",
          before: { version: "2026.11.21" },
        });
        const outcome = await prepareUpdate({
          runId: run.runId,
          runningRoot,
          runningVersion: "2026.11.21",
          channel: kind === "git" ? "dev" : "stable",
          node,
        });
        expect(outcome).toMatchObject({ status: "failed", reason: "database-schema-preflight" });
        expect(await listUpdateRunsAsync()).toMatchObject([{ runId: run.runId, status: "failed" }]);
        expect(await fs.readdir(path.join(resolvePrefix(), "releases"))).toEqual([]);
        await expect(fs.stat(path.join(runningRoot, ".openclaw-launcher"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(await readTrial()).toBeNull();
      } finally {
        await closeOpenClawStateDatabaseAsync();
        closeOpenClawStateDatabaseForTest();
      }
    },
  );

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

  it.each([
    { releaseAware: true, runtime: "node", adopt: false, readOnly: false },
    { releaseAware: false, runtime: "node", adopt: false, readOnly: false },
    { releaseAware: true, runtime: "bun", adopt: false, readOnly: false },
    { releaseAware: true, runtime: "node", adopt: true, readOnly: false, nodeOnly: true },
    { releaseAware: true, runtime: "node", adopt: true, readOnly: true },
    { releaseAware: false, runtime: "node", adopt: true, readOnly: false },
    // An explicit artifact rebuilt at the installed version is still a new release.
    { releaseAware: true, runtime: "node", build: "rebuilt" },
    { releaseAware: true, runtime: "node", build: "installed" },
  ])(
    "prepares a $runtime package with release support $releaseAware (npm adoption=$adopt, readOnly=$readOnly, build=$build, deferred node-only=$nodeOnly)",
    async ({ releaseAware, runtime, adopt = false, readOnly = false, build, nodeOnly }) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
      const runningVersion = adopt ? "2026.11.20" : "2026.11.21";
      const runningRoot = adopt
        ? path.join(resolvePrefix(), "releases", "resident", "openclaw")
        : path.join(root, "global", "node_modules", "openclaw");
      const npmPrefix = path.join(root, "npm");
      const frontend = adopt
        ? path.join(
            npmPrefix,
            ...(process.platform === "win32" ? [] : ["lib"]),
            "node_modules",
            "openclaw",
          )
        : runningRoot;
      await fs.mkdir(path.join(runningRoot, "dist"), { recursive: true });
      await fs.writeFile(
        path.join(runningRoot, "package.json"),
        JSON.stringify({ type: "module", version: runningVersion }),
      );
      if (adopt) {
        await fs.mkdir(path.join(frontend, "dist"), { recursive: true });
        await fs.writeFile(
          path.join(frontend, "package.json"),
          '{"name":"openclaw","type":"module","version":"2026.11.21"}',
        );
        const npmBin = process.platform === "win32" ? npmPrefix : path.join(npmPrefix, "bin");
        await fs.mkdir(npmBin, { recursive: true });
        await fs.writeFile(path.join(npmBin, process.platform === "win32" ? "npm.cmd" : "npm"), "");
        await switchLink(runningRoot);
      }
      await fs.copyFile(
        new URL("../../release-launcher-forward.mjs", import.meta.url),
        path.join(frontend, "release-launcher-forward.mjs"),
      );
      for (const entry of ["openclaw.mjs", "dist/index.js"]) {
        const relative = entry === "openclaw.mjs" ? "./" : "../";
        await fs.writeFile(
          path.join(frontend, entry),
          `import { forwardToReleaseLauncher } from '${relative}release-launcher-forward.mjs';
if (!(await forwardToReleaseLauncher(new URL('${relative}', import.meta.url)))) console.log('running');`,
        );
      }
      await fs.writeFile(path.join(runningRoot, "dist", "entry.js"), "console.log('running');");
      if (adopt) {
        await fs.writeFile(path.join(runningRoot, "openclaw.mjs"), "console.log('running');");
      }
      const packedRoot = path.join(root, "packed", "package");
      await fs.mkdir(packedRoot, { recursive: true });
      await fs.mkdir(path.join(packedRoot, "dist"));
      if (releaseAware) {
        for (const name of ["check-release", "gateway-trial"]) {
          await fs.writeFile(path.join(packedRoot, "dist", `${name}-fixture.mjs`), "");
        }
      }
      if (build) {
        await fs.writeFile(
          path.join(runningRoot, "dist", "build-info.json"),
          '{"buildId":"2026.11.21-installed"}',
        );
        await fs.writeFile(
          path.join(packedRoot, "dist", "build-info.json"),
          JSON.stringify({ buildId: `2026.11.21-${build}` }),
        );
      }
      await fs.writeFile(
        path.join(packedRoot, "package.json"),
        '{"name":"openclaw","version":"2026.11.21","type":"module"}',
      );
      await fs.writeFile(
        path.join(packedRoot, "openclaw.mjs"),
        `import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(path.join(root, "release-commands"))}, process.argv[3] + ':' + (process.env.FIXTURE_RUNTIME ?? 'node') + '\\n');
console.log(JSON.stringify(process.argv[3] === 'check-release'
  ? {ok:true,surfaces:[],warnings:[{code:'configured-plugin-path-unavailable',message:'Fixture plugin path is unavailable'}]}
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
      const runner =
        runtime === "bun"
          ? await executable(
              "bun",
              `const {spawnSync} = require('node:child_process');
if (process.argv[2] !== 'install') {
  const result = spawnSync(process.execPath, process.argv.slice(2), {
    env: {...process.env, FIXTURE_RUNTIME: 'bun'}, stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}`,
            )
          : node;
      if (runtime === "bun") {
        vi.spyOn(runtimePaths, "resolveBunRuntimeInfo").mockResolvedValue({
          status: "supported",
          version: "1.4.5",
          sqliteVersion: "3.51.3",
          nodeSharedSqlite: false,
          sqliteProbe: { available: true, version: "3.51.3", text: true, blob: true, json: true },
        });
      }
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
        expect(await fs.realpath(path.join(prefix, "openclaw"))).toBe(
          await fs.realpath(runningRoot),
        );
        await expect(fs.stat(path.join(runningRoot, ".openclaw-launcher"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      });
      // A converted deferred update keeps its owner even after only the node service remains.
      if (nodeOnly) {
        vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(
          createMockGatewayService({ hasInstalledDefinition: async () => false }),
        );
        vi.spyOn(nodeService, "resolveNodeService").mockReturnValue(
          createMockGatewayService({ hasInstalledDefinition: async () => true }),
        );
      }
      if (readOnly) {
        const writeFile = fs.writeFile.bind(fs);
        vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
          if (file === path.join(frontend, ".openclaw-launcher")) {
            throw Object.assign(new Error("Read-only npm package"), { code: "EACCES" });
          }
          await writeFile(file, data, options);
        });
      }
      try {
        openOpenClawStateDatabase({ env: process.env });
        const run = await createUpdateRunAsync({
          trigger: "cli",
          before: { version: runningVersion },
        });
        const outcome = await prepareUpdate({
          runId: run.runId,
          runningRoot,
          runningVersion,
          channel: "stable",
          node: runner,
          ...(adopt ? { tag: `file:${frontend}` } : {}),
        });
        // Preparation owns these facts before the trial (or a later refusal) can settle.
        const preparedRun = await getUpdateRunAsync(run.runId);
        for (const name of ["pack", "install"]) {
          expect(preparedRun?.steps.find(({ step }) => step === `prepare:${name}`)).toMatchObject({
            status: "completed",
            endedAtMs: expect.any(Number),
          });
        }
        if (!releaseAware) {
          expect(preparedRun?.origin.releaseAdmission).toBeUndefined();
          expect(outcome).toMatchObject({
            status: "failed",
            reason: "release-updates-unsupported",
            message: expect.stringContaining("npm i -g"),
          });
          expect(await readTrial(prefix)).toBeNull();
          expect(await listUpdateRunsAsync()).toMatchObject([
            { runId: run.runId, status: "failed" },
          ]);
          expect(await fs.readdir(path.join(prefix, "releases"))).toEqual(
            adopt ? ["resident"] : [],
          );
          await expect(fs.stat(path.join(frontend, ".openclaw-launcher"))).rejects.toMatchObject({
            code: "ENOENT",
          });
          expect(serviceConversion.stageReleaseService).not.toHaveBeenCalled();
          return;
        }
        if (build === "installed") {
          // The installed build again: nothing is published and the serving install is untouched.
          expect(outcome).toMatchObject({ status: "current", version: "2026.11.21" });
          expect(await getUpdateRunAsync(run.runId)).toMatchObject({
            status: "skipped",
            reason: "already-current",
          });
          expect(await readTrial(prefix)).toBeNull();
          expect(await fs.readdir(path.join(prefix, "releases"))).toEqual([]);
          await expect(fs.stat(path.join(runningRoot, ".openclaw-launcher"))).rejects.toMatchObject(
            { code: "ENOENT" },
          );
          expect(serviceConversion.stageReleaseService).not.toHaveBeenCalled();
          return;
        }
        expect(outcome).toMatchObject({ status: "pending", target: { version: "2026.11.21" } });
        expect(preparedRun?.steps).toContainEqual(
          expect.objectContaining({ step: "candidate-release-check", status: "completed" }),
        );
        expect(preparedRun?.origin.releaseAdmission).toEqual({
          owner: "candidate",
          candidateVersion: "2026.11.21",
          verdict: "admit",
          warnings: [
            {
              code: "configured-plugin-path-unavailable",
              message: "Fixture plugin path is unavailable",
            },
          ],
        });
        if (adopt) {
          expect(serviceConversion.stageReleaseService).not.toHaveBeenCalled();
          if (readOnly) {
            await expect(fs.stat(path.join(frontend, ".openclaw-launcher"))).rejects.toMatchObject({
              code: "ENOENT",
            });
            expect(preparedRun?.steps.find(({ step }) => step === "forwarding")).toMatchObject({
              status: "failed",
              detail: expect.stringContaining("It remains a separate CLI"),
            });
          } else {
            expect(await fs.readFile(path.join(frontend, ".openclaw-launcher"), "utf8")).toBe(
              `${path.join(prefix, "openclaw-launcher.mjs")}\n`,
            );
          }
        }
        expect(await fs.readFile(path.join(root, "release-commands"), "utf8")).toBe(
          `check-release:${runtime}\n`,
        );
        expect(await readTrial(prefix)).toMatchObject({
          phase: "pending",
          previous: runningRoot,
        });
        const env = Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith("OPENCLAW_")),
        );
        for (const entry of ["openclaw.mjs", "dist/index.js"]) {
          const result = await exec(node, [path.join(frontend, entry), "--version"], { env });
          expect(result.stdout.trim()).toBe("running");
        }
        expect((await readTrial(prefix))?.phase).toBe("pending");
        await settleRunFromTrial({
          ...(await readTrial(prefix))!,
          phase: "rolled-back",
          outcome: { status: "rolled-back", reason: "new build failed to start", at: Date.now() },
        });
        const rolledBack = await getUpdateRunAsync(run.runId);
        expect(rolledBack?.status).toBe("failed");
        expect(rolledBack?.origin.releaseAdmission).toEqual(preparedRun?.origin.releaseAdmission);
        for (const name of ["pack", "install"]) {
          expect(rolledBack?.steps.find(({ step }) => step === `prepare:${name}`)).toMatchObject({
            status: "completed",
            startedAtMs: expect.any(Number),
            endedAtMs: expect.any(Number),
          });
        }
      } finally {
        await closeOpenClawStateDatabaseAsync();
        closeOpenClawStateDatabaseForTest();
      }
    },
  );
});

registerAlreadyCurrentUpdateTests();

describe("retained updater runtimes", () => {
  // Updaters before owner records projected the package they replaced into the temp dir.
  const project = (checkout: string, name: string) =>
    createDoctorRuntimeProjection(path.join(root, "tmp"), checkout, name);

  it("reclaims an earlier updater's runtime and keeps uncertain ones without failing", async () => {
    const { checkout, sha } = await repository();
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("GIT_COMMIT", sha);
    const abandoned = project(checkout, "Gone01");
    const held = project(checkout, "Held01");
    const unseen = project(checkout, "Blind1");
    // One runtime is still used by another process; for another, processes cannot be listed.
    vi.spyOn(processCensus, "inspectOtherOpenClawProcesses").mockImplementation(((
      directory: string,
    ) =>
      directory === held
        ? { pids: [4242] }
        : directory === unseen
          ? { error: "Could not inspect OpenClaw processes: census unavailable" }
          : { pids: [] }) as typeof processCensus.inspectOtherOpenClawProcesses);
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    try {
      openOpenClawStateDatabase({ env: process.env });
      await runReleaseUpdateCli({
        json: false,
        restart: false,
        runningRoot: checkout,
        storedChannel: "dev",
      });
      expect(process.exitCode).toBe(0);
      expect((await getUpdateRunStatusAsync()).lastRun).toMatchObject({
        status: "skipped",
        reason: "already-current",
      });
      await expect(fs.access(abandoned)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(held)).resolves.toBeUndefined();
      await expect(fs.access(unseen)).resolves.toBeUndefined();
      // Kept runtimes are reported by the cleanup owner's log; the command prints removals.
      expect(log.mock.calls.map(([line]) => String(line))).toEqual([
        `Removed abandoned updater runtime: ${abandoned}`,
        "Already up to date.",
      ]);
    } finally {
      process.exitCode = undefined;
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

  it("prepares an install that runs inside a container", async () => {
    // Devcontainers, LXC and self-built images update their own installs; the official
    // image refuses through its install owner marker instead.
    const target = await repository();
    expect(
      await preflight({
        kind: "git",
        target: { kind: "git", ...target, version: "2026.11.21" },
        prefix: root,
        stateDir: root,
        node,
        env: { ...process.env, container: "podman" },
        statfs: async () => ({ bavail: 2_000_000_000, bsize: 1 }),
      }),
    ).toMatchObject({ ok: true });
  });
});
