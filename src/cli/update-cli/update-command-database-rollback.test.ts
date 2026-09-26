// Keep network/package-manager admission outside this database recovery regression.
import "./update-command-execution.test-support.js";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { stopChildProcess } from "../../../test/helpers/stop-child-process.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { buildBackupArchivePath } from "../../commands/backup-shared.js";
import { createConfigIO } from "../../config/io.js";
import * as serviceMembership from "../../daemon/service-process-membership.js";
import { swapStagedPackageInstall } from "../../infra/package-update-swap.js";
import { createPackageSwapFixture } from "../../infra/package-update-swap.test-support.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { acquireGatewayLifecycleCoordinator } from "../../infra/state-database-coordinator.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import * as schemas from "../../infra/update-candidate-state.js";
import type { UpdateDatabaseBackup } from "../../infra/update-database-backup.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import type { PreManagedServiceStop } from "./update-command-service-context-types.js";

const { executionParams, mocks } = await import("./update-command-execution.test-support.js");
const dirs = createTempDirTracker();
let service: ChildProcess | undefined;
let port = 0;
let packageRoot = "";
let serviceEnv: NodeJS.ProcessEnv = {};
const starts: string[] = [];
const restart = vi.fn<typeof import("./update-command-service.js").maybeRestartService>();
const verification =
  vi.fn<typeof import("./update-command-verification.js").verifyUpdatedGateway>();
const convergence = vi.fn<typeof import("./update-command-convergence.js").convergeUpdatePlugins>();

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
vi.doMock("../../daemon/service.js", async () => ({
  ...(await vi.importActual<typeof import("../../daemon/service.js")>("../../daemon/service.js")),
  readGatewayServiceState: async () => serviceState(),
  resolveGatewayService: () => ({ readRuntime: async () => serviceState().runtime }),
}));
vi.doMock("./update-command-service-maintenance.js", async () => ({
  ...(await vi.importActual<typeof import("./update-command-service-maintenance.js")>(
    "./update-command-service-maintenance.js",
  )),
  revalidateManagedGatewayServiceAfterUpdate: async () => ({
    kind: "owned",
    root: packageRoot,
    fingerprint: "database-rollback-service",
    refreshDefinition: false,
  }),
}));
vi.doMock("./update-command-service.js", async () => ({
  ...(await vi.importActual<typeof import("./update-command-service.js")>(
    "./update-command-service.js",
  )),
  maybeRestartService: restart,
  maybeStopManagedServiceBeforeMutableUpdate: mocks.maybeStopService,
  maybeRestartServiceAfterFailedMutableUpdate: mocks.maybeRestartService,
  resolveUpdatedGatewayRestartPort: async () => port,
}));
vi.doMock("./update-command-service-plan.js", async () => ({
  ...(await vi.importActual<typeof import("./update-command-service-plan.js")>(
    "./update-command-service-plan.js",
  )),
  readManagedGatewayServiceForUpdate: async () => serviceState(),
  resolveUpdatedGatewayRestartPort: async () => port,
}));
vi.doMock("./update-command-verification.js", async () => ({
  ...(await vi.importActual<typeof import("./update-command-verification.js")>(
    "./update-command-verification.js",
  )),
  verifyUpdatedGateway: verification,
}));
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

afterEach(async () => {
  if (service) {
    await stopChildProcess(service, 5_000);
    service = undefined;
  }
  await closeOpenClawStateDatabaseAsync();
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
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      version: db.prepare("PRAGMA user_version").get()?.user_version,
      rows: db.prepare("SELECT rowid, value FROM payload ORDER BY rowid").all(),
      columns: db
        .prepare("PRAGMA table_info(payload)")
        .all()
        .map((column) => column.name),
    };
  } finally {
    db.close();
  }
}

it.each([
  "package",
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
    const outsideWrite =
      scenario === "intervening" ||
      scenario === "post-migration-write" ||
      scenario === "schema-neutral-write";
    const migratedVersions = scenario === "schema-neutral-write" ? [15, 21] : [18, 23];
    const initialFailure =
      scenario === "package" ||
      scenario === "verification" ||
      scenario === "serving" ||
      scenario === "config-refused" ||
      outsideWrite;
    const restores =
      scenario !== "serving" && !outsideWrite && (initialFailure || scenario === "convergence");
    const base = await fs.realpath(dirs.make("update-database-rollback-"));
    const swapFixture = await createPackageSwapFixture(base);
    packageRoot = swapFixture.packageRoot;
    const stateDir = path.join(base, "service-state");
    const controlDir = path.join(base, "control-state");
    const coordinator = path.join(base, "coordinator");
    const shared = path.join(stateDir, "state/openclaw.sqlite");
    const agent = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
    const missing = path.join(stateDir, "agents/unused/agent/openclaw-agent.sqlite");
    for (const directory of [
      stateDir,
      controlDir,
      coordinator,
      path.dirname(shared),
      path.dirname(agent),
    ]) {
      await fs.mkdir(directory, { recursive: true });
    }
    vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(coordinator);
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
    await fs.writeFile(serviceEnv.OPENCLAW_CONFIG_PATH!, JSON.stringify(config));
    const configSnapshot = await createConfigIO({
      env: serviceEnv,
      observe: false,
      pluginValidation: "skip",
    }).readConfigFileSnapshot();
    for (const [file, version] of [
      [shared, 15],
      [agent, 21],
    ] as const) {
      const db = new DatabaseSync(file);
      db.exec(
        `PRAGMA user_version=${version}; CREATE TABLE payload(value TEXT); INSERT INTO payload(rowid,value) VALUES(7,'first'),(42,'retained');`,
      );
      if (file === shared) {
        db.exec("CREATE TABLE agent_databases(path TEXT)");
        db.prepare("INSERT INTO agent_databases VALUES (?)").run(agent);
      }
      db.close();
    }
    const before = { shared: readDatabase(shared), agent: readDatabase(agent) };
    const gatewayLease = acquireGatewayLifecycleCoordinator({ databasePath: shared });
    const gatewayCoordinatorPath = gatewayLease.path;
    gatewayLease.release();
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
      process.env.TSX_TSCONFIG_PATH=${JSON.stringify(fileURLToPath(new URL("../../../tsconfig.json", import.meta.url)))};
      await import(${JSON.stringify(new URL("../../../scripts/tsx.mjs", import.meta.url).href)});
      const {readUpdateDatabaseGenerations}=await import(${JSON.stringify(new URL("../../infra/update-database-generations.ts", import.meta.url).href)});
      const custody=new DatabaseSync(${JSON.stringify(gatewayCoordinatorPath)});
      custody.exec('PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE');
      try {
        const expected=input.databaseGenerations;
        const unchanged=expected && isDeepStrictEqual(readUpdateDatabaseGenerations(Object.keys(expected)),expected);
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
        if(expected) result.databaseWrites={unchanged,generations:readUpdateDatabaseGenerations(Object.keys(expected))};
        fs.writeFileSync(process.env.OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH,JSON.stringify(result));
      } finally {
        custody.close();
      }
    } else {
      const {version}=manifest;
      assert.equal(version,'1.0.0','candidate must never serve');
      assert.deepEqual(files.map(file=>read(file).version),[15,21],'retained runtime refuses migrated schemas');
      const custody=new DatabaseSync(${JSON.stringify(gatewayCoordinatorPath)});
      custody.exec('PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE');
      const server=http.createServer((request,response)=>{
        if(request.url==='/commit') for(const file of files) {const db=new DatabaseSync(file);db.exec("INSERT INTO payload(rowid,value) VALUES(99,'after-capture')");db.close();}
        response.setHeader('content-type','application/json');response.end(JSON.stringify({version,databases:files.map(read)}));
      });
      server.listen(Number(process.argv[3]),'127.0.0.1',()=>process.send(server.address().port));
      const shutdown=()=>server.close(()=>{custody.close();process.exit(0);});
      process.on('SIGTERM',shutdown);
      process.on('disconnect',shutdown);
    }
  `;
    for (const [root, version, versions] of [
      [packageRoot, "1.0.0", { state: 15, agent: 21 }],
      [swapFixture.params.stage.packageRoot, "2.0.0", { state: 18, agent: 23 }],
    ] as const) {
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({
          name: "openclaw",
          type: "module",
          version,
          openclaw: { schemaVersions: versions },
        }),
      );
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
    starts.length = 0;
    port = 0;
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
      candidateSchemaVersions: { state: 18, agent: 23 },
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
        serviceUpdateVerdict: {
          kind: "owned",
          root: packageRoot,
          fingerprint: "database-rollback-service",
          refreshDefinition: false,
        },
      } satisfies PreManagedServiceStop;
    });
    // Synthetic packages omit the source inspection worker; inspect real state with this driver's worker.
    const readSchemas = schemas.readUpdateStateSchemaVersions;
    vi.spyOn(schemas, "readUpdateStateSchemaVersions").mockImplementation((params) =>
      readSchemas({ ...params, root: undefined }),
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
              await fs.writeFile(
                serviceEnv.OPENCLAW_CONFIG_PATH!,
                JSON.stringify({ ...config, gateway: { ...config.gateway, port } }),
              );
            }
            if (scenario === "post-migration-write" || scenario === "schema-neutral-write") {
              for (const file of [shared, agent]) {
                const db = new DatabaseSync(file);
                db.exec("INSERT INTO payload(rowid,value) VALUES(99,'after-migration')");
                db.close();
              }
            }
            return step;
          },
        });
        assert(swap.postVerifyStep);
        expect(swap.postVerifyStep.exitCode, JSON.stringify(swap.postVerifyStep, null, 2)).toBe(
          initialFailure && scenario !== "verification" ? 1 : 0,
        );
        expect(swap.postVerifyStep.advisory).toBeUndefined();
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
    const opts = { json: true, run };
    let databaseBackup: UpdateDatabaseBackup | undefined;
    let executionResult: UpdateRunResult | undefined;
    const laterDoctor = (assertCurrent?: () => void) =>
      withOwnedManagedUpdateEnv(serviceEnv, () =>
        runUpdateFinalizationDoctorInFreshProcess({
          phase: "post-plugin",
          root: packageRoot,
          opts,
          databaseBackup,
          onDatabaseWriteStep: (step) => executionResult?.steps.push(step),
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
      expect({ shared: readDatabase(shared), agent: readDatabase(agent) }).toEqual(before);
      await expect(fs.stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
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
    verification.mockImplementation(async ({ result }) => {
      if (!restores) {
        result.verification = { serviceRunning: false, readyz: false, settled: false };
        return { ok: false, score: 0, summary: "Candidate activation failed after writing state" };
      }
      expect(await readServing()).toEqual(servedBefore);
      result.verification = {
        serviceRunning: true,
        runningVersion: "1.0.0",
        versionMatch: true,
        readyz: true,
        settled: true,
        channelsReady: true,
        pluginErrors: [],
      };
      return { ok: true, score: 7, summary: "Fixture retained runtime serves restored data" };
    });
    await withUpdateCommandExecutor(run.runId, async (executor) => {
      mocks.prepareMutableUpdate.mockImplementation(async (_env, _timeout, admit) =>
        admit(await executor.enter(packageRoot)),
      );
      const params = {
        ...executionParams("package"),
        root: packageRoot,
        packageInstallTarget: swapFixture.params.installTarget,
        opts,
        startedAt: Date.now(),
        invocationCwd: base,
        packageTargetSchemaVersions: { state: 18, agent: 23 },
        shouldRestart: scenario !== "serving",
      };
      const execution = await executeMutableUpdate(params);
      assert(execution);
      databaseBackup = execution.databaseBackup;
      executionResult = execution.result;
      expect(
        execution.result.reason,
        JSON.stringify(
          {
            result: execution.result,
            failure: execution.failure && {
              detail: execution.failure.detail,
              cause: String(execution.failure.cause),
            },
          },
          null,
          2,
        ),
      ).toBe(
        outsideWrite
          ? "state-migrated-no-rollback"
          : scenario === "package" || scenario === "serving" || scenario === "config-refused"
            ? "doctor-failed"
            : scenario === "verification"
              ? "runtime-verification-failed"
              : undefined,
      );
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
          scenario === "intervening"
            ? "databases changed after snapshot capture"
            : "databases changed after migration";
        expect(starts).toEqual(scenario === "intervening" ? ["1.0.0", "1.0.0"] : ["1.0.0"]);
        const rollback = execution.result.steps.find((step) => step.name === "database rollback");
        expect(rollback).toMatchObject({ exitCode: 1, cwd: retainedSnapshotDirectory });
        expect(rollback?.stderrTail).toContain(reason);
        expect(rollback?.stderrTail).toContain("Current databases were preserved");
        expect(rollback?.stderrTail).toContain(
          `retained snapshots at ${retainedSnapshotDirectory}`,
        );
        for (const file of [shared, agent]) {
          expect(readDatabase(file).rows).toContainEqual({
            rowid: 99,
            value: scenario === "intervening" ? "after-capture" : "after-migration",
          });
          expect(readDatabase(file).version).toBe(migratedVersions[file === shared ? 0 : 1]);
          await expect(fs.stat(`${file}.migrated-${run.runId}`)).rejects.toMatchObject({
            code: "ENOENT",
          });
          const snapshot = path.join(retainedSnapshotDirectory, buildBackupArchivePath("", file));
          expect(readDatabase(snapshot)).toEqual(file === shared ? before.shared : before.agent);
        }
        await expect(finalize()).rejects.toMatchObject({
          result: { reason: "state-migrated-no-rollback" },
        });
        const active = JSON.parse(
          await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        );
        expect(active.version).toBe("2.0.0");
        expect(restart).not.toHaveBeenCalled();
        expect(observedStart).not.toHaveBeenCalled();
        expect(service).toBeUndefined();
        const record = getUpdateRun(run.runId, { env });
        assert(record);
        expect(renderUpdateRunReport(record).lines.join("\n")).toContain(reason);
        return;
      }
      if (scenario === "serving") {
        for (const file of [shared, agent]) {
          expect(readDatabase(file).rows).toContainEqual({ rowid: 99, value: "after-capture" });
          await expect(fs.stat(`${file}.migrated-${run.runId}`)).rejects.toMatchObject({
            code: "ENOENT",
          });
          const snapshot = path.join(retainedSnapshotDirectory, buildBackupArchivePath("", file));
          expect(readDatabase(snapshot)).toEqual(file === shared ? before.shared : before.agent);
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
      expect({ shared: readDatabase(shared), agent: readDatabase(agent) }).toEqual(before);
      expect(execution.databaseBackup?.databases).toHaveLength(2);
      expect(execution.databaseBackup?.missingPaths).toContain(missing);
      expect(execution.result.steps.map((step) => step.name)).toEqual(
        expect.arrayContaining([
          "database snapshot",
          ...(initialFailure ? ["database rollback"] : []),
        ]),
      );
      expect(starts).toEqual(["1.0.0"]);
      let finishFailure: unknown;
      try {
        await finalize();
      } catch (error) {
        finishFailure = error;
      }
      expect(
        JSON.parse(await fs.readFile(doctorEvidence, "utf8")).map(
          (entry: { version: number }) => entry.version,
        ),
      ).toEqual([18, 23]);
      if (scenario === "config-refused") {
        expect(finishFailure).toBeInstanceOf(UpdateCommandFailure);
        assert(finishFailure instanceof UpdateCommandFailure);
        expect(finishFailure.result.reason).toBe("state-migrated-no-rollback");
        expect(restart).not.toHaveBeenCalled();
        expect(observedStart).not.toHaveBeenCalled();
        expect(service).toBeUndefined();
        expect(starts).toEqual(["1.0.0"]);
        const active = JSON.parse(
          await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        );
        const retained = JSON.parse(
          await fs.readFile(
            path.join(execution.packageTransaction!.backupRoot, "package.json"),
            "utf8",
          ),
        );
        expect([active.version, retained.version]).toEqual(["2.0.0", "1.0.0"]);
        expect({ shared: readDatabase(shared), agent: readDatabase(agent) }).toEqual(before);
        expect(
          [shared, agent].map((file) => readDatabase(`${file}.migrated-${run.runId}`).version),
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
          expect(readDatabase(file).rows).toEqual([
            { rowid: 7, value: "candidate" },
            { rowid: 42, value: "candidate" },
          ]);
          await expect(fs.stat(`${file}.migrated-${run.runId}`)).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
        return;
      }
      expect({ shared: readDatabase(shared), agent: readDatabase(agent) }).toEqual(before);
      expect(
        finishFailure,
        finishFailure instanceof Error ? finishFailure.stack : String(finishFailure),
      ).toBeInstanceOf(UpdateCommandFailure);
      expect(restart).toHaveBeenCalledOnce();
      expect(observedStart).toHaveBeenCalledOnce();
      expect(starts).toEqual(["1.0.0", "1.0.0"]);
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
        expect(await fs.stat(entry.snapshotPath)).toMatchObject({ size: entry.sizeBytes });
        expect(readDatabase(`${entry.path}.migrated-${run.runId}`).version).toBe(
          entry.path === shared ? 18 : 23,
        );
      }
    });
  },
);
