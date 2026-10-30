import assert from "node:assert/strict";
// Keep network/package-manager admission outside this database recovery regression.
import "./update-command-execution.test-support.js";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stopChildProcess } from "../../../test/helpers/stop-child-process.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createConfigIO } from "../../config/io.js";
import * as serviceMembership from "../../daemon/service-process-membership.js";
import { buildBackupArchivePath } from "../../infra/backup-archive-path-policy.js";
import { swapStagedPackageInstall } from "../../infra/package-update-swap.js";
import { createPackageSwapFixture } from "../../infra/package-update-swap.test-support.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as schemas from "../../infra/update-candidate-state.js";
import * as stateMetadata from "../../infra/update-candidate-state.sizes.js";
import type { UpdateDatabaseBackup } from "../../infra/update-database-backup.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import {
  isolateGitIdentity,
  runFixtureGit as git,
} from "../../infra/update-runner-git-candidate.test-support.js";
import { updateGitCheckout } from "../../infra/update-runner-git.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { acquireTestPortBlock, type TestPortClaim } from "../../test-utils/port-claims.js";
import { leaveExitedWriterWalFamily } from "./update-command-database-rollback.test-support.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";
import type { PreManagedServiceStop } from "./update-command-service-context-types.js";

const { bindExecutionGuards, executionParams, mocks } =
  await import("./update-command-execution.test-support.js");
const dirs = createTempDirTracker();
let service: ChildProcess | undefined;
let port = 0;
let portClaim: TestPortClaim | undefined;
let packageRoot = "";
let serviceEnv: NodeJS.ProcessEnv = {};
const starts: string[] = [];
const restart = vi.fn<typeof import("./update-command-service.js").maybeRestartService>();
const verification =
  vi.fn<typeof import("./update-command-verification.js").verifyUpdatedGateway>();
const convergence = vi.fn<typeof import("./update-command-convergence.js").convergeUpdatePlugins>();
const serviceVerdict = () => ({
  kind: "owned" as const,
  root: packageRoot,
  fingerprint: "database-rollback-service",
  refreshDefinition: false,
});
function mockActual(module: string, overrides: Record<string, unknown>) {
  vi.doMock(module, async () => ({
    ...(await vi.importActual<Record<string, unknown>>(module)),
    ...overrides,
  }));
}

function serviceState() {
  return {
    installed: true,
    loadState: { status: "loaded" as const },
    running: service !== undefined,
    runtime: { status: service ? "running" : "stopped", pid: service?.pid },
    env: serviceEnv,
    command: {
      programArguments: [process.execPath, path.join(packageRoot, "dist/index.js"), "gateway"],
    },
  };
}

const { defaultRuntime: fixtureRuntime } = await import("../../runtime.js");
const actualRuntime = await vi.importActual<typeof import("../../runtime.js")>("../../runtime.js");
// Previously loaded execution helpers retain this object; complete their output contract too.
Object.assign(fixtureRuntime, actualRuntime.defaultRuntime, {
  log: vi.fn(),
  error: mocks.runtimeError,
  exit: vi.fn(),
});
vi.doMock("../../runtime.js", () => ({ ...actualRuntime, defaultRuntime: fixtureRuntime }));
mockActual("../../daemon/service.js", {
  readGatewayServiceState: async () => serviceState(),
  resolveGatewayService: () => ({ readRuntime: async () => serviceState().runtime }),
});
mockActual("./update-command-service-maintenance.js", {
  revalidateManagedGatewayServiceAfterUpdate: async () => serviceVerdict(),
});
mockActual("./update-command-service.js", {
  maybeRestartService: restart,
  maybeStopManagedServiceBeforeMutableUpdate: mocks.maybeStopService,
  maybeRestartServiceAfterFailedMutableUpdate: mocks.maybeRestartService,
  resolveUpdatedGatewayRestartPort: async () => port,
});
mockActual("./update-command-service-plan.js", {
  readManagedGatewayServiceForUpdate: async () => serviceState(),
  resolveUpdatedGatewayRestartPort: async () => port,
});
mockActual("./update-command-verification.js", {
  verifyUpdatedGateway: verification,
});
vi.doMock("./update-command-convergence.js", () => ({ convergeUpdatePlugins: convergence }));

const { executeMutableUpdate } = await import("./update-command-execution.js");
const { withUpdateCommandExecutor } = await import("./update-command-executor.js");
const { runPackageUpdateDoctor } = await import("./update-command-package.js");
const { finishUpdate } = await import("./update-command-post-update.js");
const { UpdateCommandFailure } = await import("./update-command-result.js");
const readiness = await import("./update-command-readiness.js");
const { runUpdateFinalizationDoctorInFreshProcess } =
  await import("./update-command-fresh-doctor.js");
const { withOwnedManagedUpdateEnv } = await import("./update-command-service-env.js");
const gatewayLockUrl = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.gatewayLock);
const databaseGenerationsUrl = resolveRuntimeWorkerUrl(
  updateExecutorNativeEntrypoints.databaseGenerations,
);
const sourceLoader = gatewayLockUrl.pathname.endsWith(".ts")
  ? `process.env.TSX_TSCONFIG_PATH=${JSON.stringify(fileURLToPath(new URL("../../../tsconfig.json", import.meta.url)))};
     await import(${JSON.stringify(new URL("../../../scripts/tsx.mjs", import.meta.url).href)});`
  : "";

beforeEach(() => {
  vi.spyOn(stateMetadata, "readUpdateStateDatabaseSizes").mockImplementation((files, { signal }) =>
    stateMetadata.readUpdateStateDatabaseSizesInProcess(files, signal),
  );
});

afterEach(async () => {
  if (service) {
    await stopChildProcess(service, 5_000);
    service = undefined;
  }
  await closeOpenClawStateDatabaseAsync();
  await portClaim?.release();
  portClaim = undefined;
  vi.unstubAllEnvs();
  dirs.cleanup();
});

async function startService() {
  const child = fork(path.join(packageRoot, "dist/index.js"), ["gateway", String(port)], {
    env: serviceEnv,
    execArgv: [],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  service = child;
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const controller = new AbortController();
  try {
    const [message]: unknown[] = await Promise.race([
      once(child, "message", { signal: controller.signal }),
      once(child, "exit", { signal: controller.signal }).then(([code]) => {
        throw new Error(`Fixture service exited before readiness (${code}): ${stderr}`);
      }),
    ]);
    assert(typeof message === "number");
    port = message;
    const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
    starts.push(manifest.version);
  } finally {
    controller.abort();
  }
}

function readDatabase(file: string) {
  using db = new DatabaseSync(file, { readOnly: true });
  return {
    version: db.prepare("PRAGMA user_version").get()?.user_version,
    rows: db.prepare("SELECT rowid, value FROM payload ORDER BY rowid").all(),
    columns: db
      .prepare("PRAGMA table_info(payload)")
      .all()
      .map((column) => column.name),
  };
}

const writeJson = (file: string, value: unknown) => fs.writeFile(file, JSON.stringify(value));
const expectMissing = (file: string) =>
  expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
const readVersion = async (root: string) =>
  JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).version;
const candidateRows = [
  { rowid: 7, value: "candidate" },
  { rowid: 42, value: "candidate" },
];

it.each([
  "package",
  "exited-writer",
  "git",
  "git-edited",
  "verification",
  "convergence",
  "started",
  "unsettled",
  "serving",
  "intervening",
  "post-migration-write",
  "schema-neutral-write",
  "config-refused",
] as const)(
  "restores pre-migration databases only before settled activation: %s",
  async (scenario) => {
    const gitInstall = scenario === "git" || scenario === "git-edited";
    const outsideWrite = [
      "git-edited",
      "intervening",
      "post-migration-write",
      "schema-neutral-write",
    ].includes(scenario);
    const preservesMigrated = outsideWrite && scenario !== "git-edited";
    const candidateSchemas =
      scenario === "schema-neutral-write" ? { state: 15, agent: 21 } : { state: 18, agent: 23 };
    const migratedVersions = scenario === "schema-neutral-write" ? [15, 21] : [18, 23];
    const initialFailure = !["convergence", "started", "unsettled"].includes(scenario);
    const restores =
      scenario !== "serving" && !outsideWrite && (initialFailure || scenario === "convergence");
    const base = await fs.realpath(dirs.make("update-database-rollback-"));
    const swapFixture = await createPackageSwapFixture(base);
    packageRoot = swapFixture.packageRoot;
    const stateDir = path.join(base, "service-state");
    const controlDir = path.join(base, "control-state");
    const shared = path.join(stateDir, "state/openclaw.sqlite");
    const agent = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
    const missing = path.join(stateDir, "agents/unused/agent/openclaw-agent.sqlite");
    const files = [shared, agent];
    const readState = () => ({ shared: readDatabase(shared), agent: readDatabase(agent) });
    const expectSnapshot = (file: string) => {
      const snapshot = path.join(retainedSnapshotDirectory, buildBackupArchivePath("", file));
      expect(readDatabase(snapshot)).toEqual(file === shared ? before.shared : before.agent);
    };
    const expectNoMigratedFile = (file: string) => expectMissing(`${file}.migrated-${run.runId}`);
    for (const directory of [stateDir, controlDir, path.dirname(shared), path.dirname(agent)]) {
      await fs.mkdir(directory, { recursive: true });
    }
    serviceEnv = {
      ...process.env,
      HOME: base,
      USERPROFILE: base,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_PROFILE: undefined,
      OPENCLAW_HOME: undefined,
      OPENCLAW_AGENT_DIR: undefined,
      PI_CODING_AGENT_DIR: undefined,
    };
    const config = {
      gateway: { mode: "local" },
      plugins: { enabled: false },
      agents: { entries: { unused: {} } },
    };
    await writeJson(serviceEnv.OPENCLAW_CONFIG_PATH!, config);
    const configSnapshot = await createConfigIO({
      env: serviceEnv,
      observe: false,
      pluginValidation: "skip",
    }).readConfigFileSnapshot();
    for (const [file, version] of [
      [shared, 15],
      [agent, 21],
    ] as const) {
      using db = new DatabaseSync(file);
      db.exec(
        `PRAGMA user_version=${version}; CREATE TABLE payload(value TEXT); INSERT INTO payload(rowid,value) VALUES(7,'first'),(42,'retained');`,
      );
      if (file === shared) {
        db.exec("CREATE TABLE agent_databases(path TEXT)");
        db.prepare("INSERT INTO agent_databases VALUES (?)").run(agent);
      }
    }
    const before = readState();
    let retainedSnapshotDirectory = "";
    const doctorEvidence = path.join(base, "doctor-observed.json");
    const initialDoctor = path.join(base, "initial-doctor.json");
    // Model package IPC with real fingerprints and physical maintenance custody.
    const source = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import http from 'node:http';
    import { DatabaseSync } from 'node:sqlite';
    import { isDeepStrictEqual } from 'node:util';
    const files = ${JSON.stringify([shared, agent])};
    const manifest=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'));
    const acquireCustody = async (role, port) => {
      ${sourceLoader}
      const {acquireGatewayLock}=await import(${JSON.stringify(gatewayLockUrl.href)});
      const owner=await acquireGatewayLock({env:process.env,role,port,allowInTests:true,timeoutMs:0});
      assert(owner);
      return owner;
    };
    const read = file => {
      const db = new DatabaseSync(file, {readOnly:true});
      try { return { version:db.prepare('PRAGMA user_version').get().user_version, rows:db.prepare('SELECT rowid,value FROM payload ORDER BY rowid').all() }; }
      finally { db.close(); }
    };
    if (process.argv[2] === '--check') {
      process.stdout.write(JSON.stringify({...manifest.openclaw.schemaVersions,doctorConfigWrites:'pid-start-v1'}));
    } else if (process.argv[2] === '--doctor') {
      assert.equal(process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION,'0');
      const input=JSON.parse(fs.readFileSync(0,'utf8'));
      assert(input.executor && input.runId && input.root);
      assert.equal(fs.realpathSync(input.root),fs.realpathSync(new URL('../',import.meta.url)));
      ${sourceLoader}
      const {readUpdatePhysicalDatabaseGenerations}=await import(${JSON.stringify(databaseGenerationsUrl.href)});
      const custody=await acquireCustody('sqlite-maintenance');
      try {
        const expected=input.databaseGenerations;
        const fromGenerations=expected && await readUpdatePhysicalDatabaseGenerations(Object.keys(expected));
        const unchanged=expected && isDeepStrictEqual(fromGenerations,expected);
        let result;
        if (${!initialFailure} && !fs.existsSync(${JSON.stringify(initialDoctor)})) {
          fs.writeFileSync(${JSON.stringify(initialDoctor)},'completed without migration');
          result={status:'ok'};
        } else {
          for (const [index,file] of files.entries()) {
            const db = new DatabaseSync(file);
            try { db.exec("BEGIN; ALTER TABLE payload ADD COLUMN migrated TEXT; UPDATE payload SET value='candidate' WHERE rowid IN (7,42); PRAGMA user_version=" + ${JSON.stringify(migratedVersions)}[index] + '; COMMIT;'); }
            finally { db.close(); }
          }
          if (${scenario !== "schema-neutral-write"}) {
            fs.mkdirSync(${JSON.stringify(path.dirname(missing))},{recursive:true});
            const created = new DatabaseSync(${JSON.stringify(missing)});
            created.exec('PRAGMA user_version=23'); created.close();
          }
          fs.writeFileSync(${JSON.stringify(doctorEvidence)},JSON.stringify(files.map(read)));
          result=${JSON.stringify(scenario === "verification" ? { status: "ok" } : { status: "error", maintenanceRefusal: { kind: "data-at-risk", reason: "incomplete-migration" } })};
          process.exitCode=${scenario === "verification" ? 0 : 1};
        }
        if(expected) result.databaseWrites={unchanged,fromGenerations,generations:await readUpdatePhysicalDatabaseGenerations(Object.keys(expected))};
        fs.writeFileSync(process.env.OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH,JSON.stringify(result));
      } finally {
        await custody.release();
      }
    } else {
      const {version}=manifest;
      assert(version==='1.0.0'||${preservesMigrated},'only the compatible candidate may serve preserved writes');
      const custody=await acquireCustody('gateway',Number(process.argv[3]));
      assert.deepEqual(files.map(file=>read(file).version),version==='1.0.0'?[15,21]:${JSON.stringify(migratedVersions)},'runtime must match the retained state');
      const server=http.createServer((request,response)=>{
        if(request.url==='/commit') for(const file of files) {const db=new DatabaseSync(file);db.exec("INSERT INTO payload(rowid,value) VALUES(99,'after-capture')");db.close();}
        response.setHeader('content-type','application/json');response.end(JSON.stringify({version,databases:files.map(read)}));
      });
      server.listen(Number(process.argv[3]),'127.0.0.1',()=>process.send(server.address().port));
      const shutdown=()=>server.close(async()=>{await custody.release();process.exit(0);});
      process.on('SIGTERM',shutdown);
      process.on('disconnect',shutdown);
    }
  `;
    for (const [root, version, versions] of [
      [packageRoot, "1.0.0", { state: 15, agent: 21 }],
      [swapFixture.params.stage.packageRoot, "2.0.0", candidateSchemas],
    ] as const) {
      await writeJson(path.join(root, "package.json"), {
        name: "openclaw",
        packageManager: "pnpm@12.0.0",
        type: "module",
        version,
        openclaw: { schemaVersions: versions },
      });
      await fs.writeFile(path.join(root, "dist/index.js"), source);
      const worker = path.join(
        root,
        "dist",
        runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath,
      );
      await fs.mkdir(path.dirname(worker), { recursive: true });
      const entry = path
        .relative(path.dirname(worker), path.join(root, "dist/index.js"))
        .split(path.sep)
        .join("/");
      await fs.writeFile(worker, `import ${JSON.stringify(entry)};\n`);
    }
    let beforeGitSha: string | undefined;
    const writeGitRuntime = async (root: string) => {
      const sha = await git(root, "rev-parse", "HEAD");
      const dist = path.join(root, "dist");
      await fs.mkdir(path.join(dist, "control-ui"), { recursive: true });
      await Promise.all([
        writeJson(path.join(dist, "build-info.json"), { commit: sha, buildId: sha }),
        writeJson(path.join(dist, ".buildstamp"), { head: sha }),
        writeJson(path.join(dist, ".runtime-postbuildstamp"), { head: sha }),
        fs.writeFile(path.join(dist, "control-ui", "index.html"), "ready"),
        fs.writeFile(path.join(dist, "entry.js"), "import './index.js';\n"),
      ]);
    };
    if (gitInstall) {
      isolateGitIdentity();
      await git(packageRoot, "init", "--initial-branch=main");
      await git(packageRoot, "config", "user.name", "OpenClaw Test");
      await git(packageRoot, "config", "user.email", "openclaw@example.com");
      await fs.writeFile(
        path.join(packageRoot, ".gitignore"),
        "dist/\nnode_modules/\n.artifacts/\n",
      );
      await git(packageRoot, "add", ".");
      await git(packageRoot, "commit", "-m", "previous installation");
      beforeGitSha = await git(packageRoot, "rev-parse", "HEAD");
      await writeGitRuntime(packageRoot);
      const remote = path.join(base, "remote");
      await git(base, "clone", "--quiet", packageRoot, remote);
      await git(remote, "config", "user.name", "OpenClaw Test");
      await git(remote, "config", "user.email", "openclaw@example.com");
      await fs.copyFile(
        path.join(swapFixture.params.stage.packageRoot, "package.json"),
        path.join(remote, "package.json"),
      );
      await git(remote, "add", ".");
      await git(remote, "commit", "-m", "candidate installation");
      await git(packageRoot, "remote", "add", "origin", remote);
      await git(packageRoot, "fetch", "origin");
      await git(packageRoot, "branch", "--set-upstream-to=origin/main", "main");
      mocks.runGitUpdate.mockImplementation(
        async (params: Parameters<typeof import("./update-command-git.js").updateGitInstall>[0]) =>
          updateGitCheckout({
            gitRoot: packageRoot,
            startedAt: Date.now(),
            timeoutMs: 5000,
            defaultCommandEnv: undefined,
            runCommand: async (argv, options) => {
              if (argv[0] !== "pnpm") {
                return runCommandWithTimeout(argv, options);
              }
              if (argv[1] === "build") {
                await fs.cp(
                  path.join(swapFixture.params.stage.packageRoot, "dist"),
                  path.join(options.cwd!, "dist"),
                  { recursive: true },
                );
                await writeGitRuntime(options.cwd!);
              }
              return { code: 0, stdout: argv[1] === "--version" ? "12.0.0" : "", stderr: "" };
            },
            opts: {
              inspectGitTarget: params.inspectGitTarget,
              beforeGitMutation: params.beforeGitMutation,
              validateCandidate: params.validateCandidate,
              onTransaction: params.onTransaction,
              runGitDoctor: async (root, results) => {
                const step = await runPackageUpdateDoctor({
                  ...params,
                  root,
                  results,
                  managedServiceEnv: params.getManagedServiceEnv(),
                });
                if (scenario === "git-edited") {
                  await fs.appendFile(path.join(root, "package.json"), "\n");
                }
                return step;
              },
            },
          }),
      );
    }
    starts.length = 0;
    portClaim = await acquireTestPortBlock({ offsets: [0] });
    port = portClaim.port;
    await startService();
    // The fixture owns this live child, but it is not a native launchd/systemd job.
    vi.spyOn(serviceMembership, "inspectServiceProcessMembershipSync").mockImplementation((pid) =>
      service && service.pid === pid && service.exitCode === null && service.signalCode === null
        ? "outside"
        : "unknown",
    );
    const readServing = async () => {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(response.status).toBe(200);
      return response.json();
    };
    const servedBefore = await readServing();
    const context = {
      env: serviceEnv,
      readEnv: serviceEnv,
      config: configSnapshot.config,
      configSnapshot,
    };
    mocks.captureSchemaContext.mockResolvedValue(context);
    mocks.captureManagedPreflight.mockResolvedValue(context);
    mocks.captureManagedContext.mockResolvedValue({ ...context, pluginInstallRecords: {} });
    // Native commands are owned by this fixture's child manager, not the synthetic package.
    mocks.nativeSupport.mockImplementation(async ({ executor }) => {
      executor.assertCurrent();
      return true;
    });
    mocks.validateCanary.mockResolvedValue({
      status: "ok",
      phase: "readiness",
      steps: [],
      durationMs: 0,
      logTail: [],
      candidateSchemaVersions: candidateSchemas,
      doctorConfigWrites: true,
    });
    vi.spyOn(readiness, "verifyPreviousGatewayForUpdate").mockImplementation(async () => {
      expect(await readServing()).toEqual(servedBefore);
      return true;
    });
    mocks.maybeStopService.mockImplementation(async ({ phase, shouldRestart }) => {
      const running = service !== undefined;
      const servicePid = service?.pid;
      if (phase !== "inspect" && shouldRestart && service) {
        await stopChildProcess(service, 5_000);
        service = undefined;
      }
      return {
        stopped: phase !== "inspect" && shouldRestart,
        inspected: true,
        runtimeInspected: true,
        running,
        servicePid,
        serviceEnv,
        servicePort: port,
        serviceNodeRunner: process.execPath,
        serviceIdentity: { version: "1.0.0" },
        serviceUpdateVerdict: serviceVerdict(),
      } satisfies PreManagedServiceStop;
    });
    // Synthetic packages omit the source inspection worker; inspect real state with this driver's worker.
    const readSchemas = schemas.readUpdateStateSchemaVersions;
    vi.spyOn(schemas, "readUpdateStateSchemaVersions").mockImplementation((params) =>
      readSchemas({ ...params, root: undefined }),
    );
    const readGenerations = schemas.readUpdateDatabaseGenerationsIsolated;
    vi.spyOn(schemas, "readUpdateDatabaseGenerationsIsolated").mockImplementation(
      (paths, options) => readGenerations(paths, { ...options, root: undefined }),
    );
    mocks.runPackageUpdate.mockImplementation(
      async (
        params: Parameters<typeof import("./update-command-package.js").runPackageInstallUpdate>[0],
      ) => {
        await params.validateCandidate(swapFixture.params.stage.packageRoot);
        const swap = await swapStagedPackageInstall({
          ...swapFixture.params,
          beforeActivate: params.beforeActivate,
          onTransaction: async (transaction) => {
            if (scenario === "exited-writer") {
              await leaveExitedWriterWalFamily(agent, path.join(base, "exited-writer"));
            }
            await params.onTransaction?.(transaction);
            retainedSnapshotDirectory = `${transaction.backupRoot}.databases`;
            if (scenario === "intervening") {
              await startService();
            }
            if (scenario === "serving" || scenario === "intervening") {
              expect((await fetch(`http://127.0.0.1:${port}/commit`)).status).toBe(200);
              assert(service);
              await stopChildProcess(service, 5_000);
              service = undefined;
            }
          },
          postVerifyStep: async (root) => {
            const step = await runPackageUpdateDoctor({ ...params, root });
            if (scenario === "config-refused") {
              await writeJson(serviceEnv.OPENCLAW_CONFIG_PATH!, {
                ...config,
                gateway: { ...config.gateway, port },
              });
            }
            if (scenario === "post-migration-write" || scenario === "schema-neutral-write") {
              for (const file of files) {
                using db = new DatabaseSync(file);
                db.exec("INSERT INTO payload(rowid,value) VALUES(99,'after-migration')");
              }
            }
            return step;
          },
        });
        assert(swap.postVerifyStep);
        expect([swap.postVerifyStep.exitCode, swap.postVerifyStep.advisory]).toEqual([
          initialFailure && scenario !== "verification" ? 1 : 0,
          undefined,
        ]);
        return {
          status: initialFailure ? "error" : "ok",
          mode: "npm",
          root: packageRoot,
          before: { version: "1.0.0" },
          after: { version: "2.0.0" },
          reason:
            initialFailure && scenario !== "verification"
              ? "doctor-failed"
              : scenario === "verification"
                ? "runtime-verification-failed"
                : undefined,
          steps: [swap.step, swap.postVerifyStep],
          durationMs: 1,
        };
      },
    );
    const env = {
      ...serviceEnv,
      OPENCLAW_STATE_DIR: controlDir,
      OPENCLAW_CONFIG_PATH: path.join(controlDir, "openclaw.json"),
    };
    const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
    const opts: import("./shared.js").UpdateCommandOptions = { json: true, run };
    let databaseBackup: UpdateDatabaseBackup | undefined;
    let executionResult: UpdateRunResult | undefined;
    const laterDoctor = (assertCurrent?: () => void) =>
      withOwnedManagedUpdateEnv(serviceEnv, () =>
        runUpdateFinalizationDoctorInFreshProcess({
          phase: "post-plugin",
          root: packageRoot,
          opts,
          databaseBackup,
          onDoctorStep: (step) => executionResult?.steps.push(step),
          yes: true,
          json: true,
          nodeRunner: process.execPath,
          timeoutMs: 30_000,
          assertCurrent,
        }),
      );
    const unsettled = new CommandProcessCleanupError();
    convergence.mockImplementation(async (params) => {
      if (scenario === "started") {
        return { resultWithPostUpdate: params.result, postUpdateConfigSnapshot: configSnapshot };
      }
      try {
        await laterDoctor(params.assertCurrent);
      } catch (error) {
        // The transport's uncertain-settlement result cannot authorize restoration of committed bytes.
        if (scenario === "unsettled") {
          throw unsettled;
        }
        params.result.status = "error";
        throw error;
      }
      throw new Error("Expected the convergence Doctor to fail after migration");
    });
    restart.mockImplementation(async ({ onVerified, onGatewayStartAttempted }) => {
      onGatewayStartAttempted?.();
      if (scenario === "started") {
        await expect(laterDoctor()).rejects.toThrow();
        return "failed";
      }
      expect(readState()).toEqual(before);
      await expectMissing(missing);
      await startService();
      expect(await readServing()).toEqual(servedBefore);
      recordUpdateRunVerification(
        run.runId,
        {
          serviceRunning: true,
          runningVersion: "1.0.0",
          versionMatch: true,
          readyz: true,
          settled: true,
        },
        { env },
      );
      onVerified?.(Date.now());
      return "ok";
    });
    mocks.maybeRestartService.mockImplementation(async ({ recovery, onGatewayStartAttempted }) => {
      expect(preservesMigrated).toBe(true);
      expect(recovery).toMatchObject({ serviceRestartSafe: true, version: "2.0.0" });
      onGatewayStartAttempted?.();
      await startService();
      expect(await readServing()).toMatchObject({ version: "2.0.0" });
      return "healthy";
    });
    verification.mockImplementation(async ({ result }) => {
      if (!restores && !preservesMigrated) {
        result.verification = { serviceRunning: false, readyz: false, settled: false };
        return { ok: false, score: 0, summary: "Candidate activation failed after writing state" };
      }
      if (preservesMigrated) {
        expect(await readServing()).toMatchObject({ version: "2.0.0" });
      } else {
        expect(await readServing()).toEqual(servedBefore);
      }
      result.verification = {
        serviceRunning: true,
        runningVersion: preservesMigrated ? "2.0.0" : "1.0.0",
        versionMatch: true,
        readyz: true,
        settled: true,
        channelsReady: true,
        pluginErrors: [],
      };
      return { ok: true, score: 7, summary: "Fixture retained runtime serves restored data" };
    });
    try {
      await withUpdateCommandExecutor(run.runId, async (executor) => {
        mocks.prepareMutableUpdate.mockImplementation(async (_env, _timeout, admit) =>
          admit(await executor.enter(packageRoot)),
        );
        const params = {
          ...executionParams(gitInstall ? "git" : "package"),
          root: packageRoot,
          packageInstallTarget: swapFixture.params.installTarget,
          opts,
          startedAt: Date.now(),
          invocationCwd: base,
          packageTargetSchemaVersions: candidateSchemas,
          shouldRestart: scenario !== "serving",
        };
        const execution = await executeMutableUpdate(await bindExecutionGuards(params));
        assert(execution);
        databaseBackup = execution.databaseBackup;
        executionResult = execution.result;
        if (gitInstall) {
          assert(databaseBackup, "Git update must capture pre-migration databases");
          retainedSnapshotDirectory = databaseBackup.directory;
        }
        if (scenario === "exited-writer") {
          // Capture under maintenance custody must not rebuild the source WAL index.
          const captured = execution.result.steps.find((step) => step.name === "database snapshot");
          expect(captured?.warnings ?? []).toEqual([]);
          expect(databaseBackup?.sourceGenerations[agent]).toEqual(expect.any(String));
        }
        const expectedReason = outsideWrite
          ? "state-migrated-no-rollback"
          : scenario === "verification"
            ? "runtime-verification-failed"
            : initialFailure
              ? "doctor-failed"
              : undefined;
        expect(execution.result.reason).toBe(expectedReason);
        const observedStart = vi.fn();
        const finalize = () =>
          finishUpdate(
            {
              ...execution,
              root: packageRoot,
              ownedManagedUpdateEnv: serviceEnv,
              opts: params.opts,
              shouldRestart: true,
              updateStepTimeoutMs: 30_000,
              installKindChanged: false,
              configSnapshot,
              requestedChannel: null,
              storedChannel: "stable",
              channel: "stable",
              downgradeRisk: false,
              preUpdatePluginInstallRecords: {},
              startedAt: params.startedAt,
              controlPlaneUpdateSentinelMeta: null,
            },
            { onGatewayStartAttempted: observedStart },
          );
        if (outsideWrite) {
          const reason =
            scenario === "git-edited"
              ? "Git checkout changed after activation"
              : scenario === "intervening"
                ? "databases changed after snapshot capture"
                : "restoring the backup would discard later writes";
          expect(starts).toEqual(scenario === "intervening" ? ["1.0.0", "1.0.0"] : ["1.0.0"]);
          const rollback = execution.result.steps.find((step) => step.name === "database rollback");
          expect(rollback).toMatchObject({ exitCode: 1, cwd: retainedSnapshotDirectory });
          for (const file of files) {
            if (scenario === "git-edited") {
              expect(readDatabase(file).rows).toEqual(candidateRows);
            } else {
              expect(readDatabase(file).rows).toContainEqual({
                rowid: 99,
                value: scenario === "intervening" ? "after-capture" : "after-migration",
              });
            }
            expect(readDatabase(file).version).toBe(migratedVersions[file === shared ? 0 : 1]);
            await expectNoMigratedFile(file);
            expectSnapshot(file);
          }
          const preserved = readState();
          if (preservesMigrated) {
            expect(execution.result.recovery).toMatchObject({
              serviceRestartSafe: false,
              dataAtRisk: "state-migrated-no-rollback",
            });
          }
          await expect(finalize()).rejects.toMatchObject({
            result: {
              reason: preservesMigrated ? "post-update-failed" : "state-migrated-no-rollback",
            },
          });
          expect(readState()).toEqual(preserved);
          expect(await readVersion(packageRoot)).toBe("2.0.0");
          if (scenario === "git-edited") {
            expect(await git(packageRoot, "diff", "--name-only")).toBe("package.json");
            expect(await git(packageRoot, "rev-parse", "HEAD")).not.toBe(beforeGitSha);
          }
          expect(restart).not.toHaveBeenCalled();
          if (preservesMigrated) {
            expect(await readServing()).toMatchObject({ version: "2.0.0" });
          } else {
            expect(observedStart).not.toHaveBeenCalled();
            expect(service).toBeUndefined();
          }
          const record = getUpdateRun(run.runId, { env });
          assert(record);
          expect(rollback?.stderrTail).toContain(reason);
          expect(renderUpdateRunReport(record).lines.join("\n")).toContain(reason);
          if (preservesMigrated) {
            expect(record).toMatchObject({
              status: "failed",
              reason: "post-update-failed",
              verification: {
                serviceRunning: true,
                readyz: true,
                runningVersion: "2.0.0",
                recovery: { serviceRestartSafe: true, service: "healthy", version: "2.0.0" },
              },
            });
            expect(record.verification.recovery).not.toHaveProperty("dataAtRisk");
            expect(renderUpdateRunReport(record).lines.join("\n")).toContain(
              "running on the retained state",
            );
          }
          return;
        }
        if (scenario === "serving") {
          for (const file of files) {
            expect(readDatabase(file).rows).toContainEqual({ rowid: 99, value: "after-capture" });
            await expectNoMigratedFile(file);
            expectSnapshot(file);
          }
          expect(execution.databaseBackup).toBeUndefined();
          const captured = execution.result.steps.find((step) => step.name === "database snapshot");
          expect(captured?.warnings).toEqual([
            expect.stringContaining("Automatic database restoration is disabled"),
          ]);
          expect(execution.result.steps.some((step) => step.name === "database rollback")).toBe(
            false,
          );
          expect(service).toBeUndefined();
          return;
        }
        expect(readState()).toEqual(before);
        expect(execution.databaseBackup?.missingPaths).toContain(missing);
        expect(starts).toEqual(["1.0.0"]);
        const finishFailure = await finalize().catch((error: unknown) => error);
        expect(
          JSON.parse(await fs.readFile(doctorEvidence, "utf8")).map(
            (entry: { version: number }) => entry.version,
          ),
        ).toEqual([18, 23]);
        if (scenario === "config-refused") {
          assert(finishFailure instanceof UpdateCommandFailure);
          expect(finishFailure.result.reason).toBe("state-migrated-no-rollback");
          expect(restart).not.toHaveBeenCalled();
          expect(observedStart).not.toHaveBeenCalled();
          expect(service).toBeUndefined();
          expect(starts).toEqual(["1.0.0"]);
          expect([
            await readVersion(packageRoot),
            await readVersion(execution.packageTransaction!.backupRoot),
          ]).toEqual(["2.0.0", "1.0.0"]);
          expect(readState()).toEqual(before);
          expect(
            files.map((file) => readDatabase(`${file}.migrated-${run.runId}`).version),
          ).toEqual([18, 23]);
          expect(JSON.parse(await fs.readFile(serviceEnv.OPENCLAW_CONFIG_PATH!, "utf8"))).toEqual({
            ...config,
            gateway: { ...config.gateway, port },
          });
          expect(finishFailure.result.steps).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ name: "database rollback", exitCode: 0 }),
              expect.objectContaining({ name: "config-rollback", exitCode: 1 }),
            ]),
          );
          return;
        }
        if (!restores) {
          if (scenario === "unsettled") {
            expect(finishFailure).toBe(unsettled);
            expect(restart).not.toHaveBeenCalled();
            expect(observedStart).not.toHaveBeenCalled();
          } else {
            expect(finishFailure).toBeInstanceOf(UpdateCommandFailure);
            expect(restart).toHaveBeenCalledOnce();
            expect(observedStart).toHaveBeenCalledOnce();
          }
          expect(starts).toEqual(["1.0.0"]);
          for (const [file, version] of [
            [shared, 18],
            [agent, 23],
          ] as const) {
            expect(readDatabase(file).version).toBe(version);
            expect(readDatabase(file).rows).toEqual(candidateRows);
            await expectNoMigratedFile(file);
          }
          return;
        }
        expect(readState()).toEqual(before);
        expect(finishFailure).toBeInstanceOf(UpdateCommandFailure);
        expect(restart).toHaveBeenCalledOnce();
        expect(observedStart).toHaveBeenCalledOnce();
        expect(starts).toEqual(["1.0.0", "1.0.0"]);
        if (beforeGitSha) {
          expect(await git(packageRoot, "rev-parse", "HEAD")).toBe(beforeGitSha);
          expect(await git(packageRoot, "status", "--porcelain")).toBe("");
        }
        const record = getUpdateRun(run.runId, { env });
        expect(record).toMatchObject({
          status: "rolled-back",
          verification: { serviceRunning: true, runningVersion: "1.0.0", versionMatch: true },
        });
        assert(record);
        const report = renderUpdateRunReport(record).lines.join("\n");
        expect(report).toContain("Databases snapshotted at");
        expect(report).toContain("Migrated database file retained");
        expect(await fs.readFile(swapFixture.launcher, "utf8")).toBe("old launcher\n");
        for (const entry of execution.databaseBackup!.databases) {
          expect(readDatabase(`${entry.path}.migrated-${run.runId}`).version).toBe(
            entry.path === shared ? 18 : 23,
          );
        }
      });
    } finally {
      await opts.run?.sourceArtifactLock?.release();
    }
  },
);
