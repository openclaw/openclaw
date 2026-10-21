import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  noteCommittedSharedAuthStoreOwnership,
  resolveSharedAuthStorePath,
} from "../agents/auth-profiles/path-resolve.js";
import {
  closeAuthProfileReadPool,
  inspectPersistedAuthProfileStoreRaw,
  writePersistedAuthProfileStoreRaw,
} from "../agents/auth-profiles/sqlite.js";
import { operatorMcpOAuthIdentity } from "../agents/mcp-oauth-identity.js";
import { resolveMcpOAuthAccessToken } from "../agents/mcp-oauth.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { clearHealthChecksForTest } from "../flows/health-check-registry.js";
import type { HealthCheckContext } from "../flows/health-checks.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import { cleanupSnapshotOperations } from "../infra/sqlite-readonly-location-cleanup.js";
import * as sqliteSnapshotSource from "../infra/sqlite-snapshot-source.js";
import * as temporaryState from "../infra/tmp-openclaw-dir.js";
import { resolveManagedUpdateLeaseDatabasePath } from "../infra/update-managed-service-handoff-lease.js";
import { resolveActivePluginInstallRoots } from "../plugins/install-root-context.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import {
  executeExistingOpenClawStateRead,
  getActiveOpenClawStateDatabaseReadSnapshot,
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as leaseAcquisition from "../state/openclaw-state-lease-acquisition.js";
import { withOpenClawStateLease } from "../state/openclaw-state-lease.js";
import { captureEnv, withEnvAsync } from "../test-utils/env.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { ensureHeartbeatMonitorJobs } from "./doctor-heartbeat-cadence-migration.js";
import { collectDoctorFindings, runDoctorLintCliInProcess } from "./doctor-lint-runner.js";
import { runDoctorLintCli } from "./doctor-lint.js";
import { verifyDoctorLintOAuthStateIsolation } from "./doctor-lint.oauth-isolation.test-support.js";
import { verifyDoctorLintPrivateAuthRetirement } from "./doctor-lint.private-auth-retirement.test-support.js";
import {
  seedDoctorLintMcpToken,
  snapshotDoctorLintSqliteFamily,
} from "./doctor-lint.test-support.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  resolveDoctorContributionHealthChecks: vi.fn(),
  pairingReadState: vi.fn(),
  sqliteOpen: vi.fn<(filename: string, readOnly: boolean, database: DatabaseSync) => void>(),
}));

vi.mock("../flows/doctor-health-contributions.js", () => ({
  resolveDoctorContributionHealthChecks: mocks.resolveDoctorContributionHealthChecks,
}));
vi.mock("../infra/device-pairing.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/device-pairing.js")>();
  return {
    ...actual,
    listDevicePairingReadOnly(baseDir?: string) {
      mocks.pairingReadState(baseDir ?? process.env.OPENCLAW_STATE_DIR);
      return actual.listDevicePairingReadOnly(baseDir);
    },
  };
});
vi.mock("../infra/node-sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/node-sqlite.js")>();
  return {
    ...actual,
    openNodeSqliteDatabase(...args: Parameters<typeof actual.openNodeSqliteDatabase>) {
      const database = actual.openNodeSqliteDatabase(...args);
      const location = path.toNamespacedPath(database.location() ?? args[0]);
      mocks.sqliteOpen(location, args[1]?.readOnly === true, database);
      return database;
    },
  };
});

const runtime = createTestRuntime();
const handoffDirs = useAutoCleanupTempDirTracker(afterEach);
let handoffResolver: MockInstance<typeof temporaryState.resolvePreferredOpenClawTmpDir> | undefined;

const originalEnv = captureEnv(["HOME", "OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR"]);

describe("doctor lint state isolation", () => {
  beforeEach(() => {
    const privateControl = fs.realpathSync(handoffDirs.make("doctor-lint-handoff-"));
    handoffResolver = vi
      .spyOn(temporaryState, "resolvePreferredOpenClawTmpDir")
      .mockReturnValue(privateControl);
    const handoffPath = resolveManagedUpdateLeaseDatabasePath();
    expect(handoffPath).toBe(path.join(privateControl, "managed-update-handoffs.sqlite"));
    expect(fs.realpathSync(path.dirname(handoffPath))).toBe(privateControl);
    clearHealthChecksForTest();
    mocks.resolveDoctorContributionHealthChecks.mockReset();
    mocks.pairingReadState.mockClear();
    mocks.sqliteOpen.mockClear();
  });

  afterEach(async () => {
    try {
      await closeOpenClawStateDatabaseAsync();
    } finally {
      try {
        closeOpenClawStateDatabaseForTest();
      } finally {
        try {
          await cleanupSnapshotOperations();
        } finally {
          handoffResolver?.mockRestore();
          originalEnv.restore();
        }
      }
    }
  });

  it("keeps retired device-auth detection scoped for --all", async () => {
    await withOpenClawTestState(
      {
        prefix: "openclaw-doctor-lint-device-auth-",
        env: { OPENCLAW_TEST_FAST: "1", OPENCLAW_PROFILE: undefined },
      },
      async (state) => {
        await state.writeConfig({
          gateway: { mode: "local" },
          memory: { search: { enabled: false } },
        });
        const pending = await requestDevicePairing(
          {
            deviceId: "snapshot-device",
            publicKey: "synthetic-public-key",
            role: "operator",
            scopes: ["operator.read"],
          },
          state.stateDir,
        );
        const sourcePath = await state.writeText("identity/device-auth.json", "legacy-file-marker");
        const databasePath = resolveOpenClawStateSqlitePath(state.env);
        await closeOpenClawStateDatabaseByPathAsync(databasePath);
        const before = snapshotDoctorLintSqliteFamily(databasePath);
        const actual = await vi.importActual<
          typeof import("../flows/doctor-health-contributions.js")
        >("../flows/doctor-health-contributions.js");
        const pairingCheck = (await actual.resolveDoctorContributionHealthChecks()).find(
          (check) => check.id === "core/doctor/device-pairing",
        );
        if (!pairingCheck) {
          throw new Error("device-pairing contribution is missing");
        }
        // Keep the real contribution and lint state-mode selection; unrelated core
        // checks must not turn this local state-boundary test into a service audit.
        mocks.resolveDoctorContributionHealthChecks.mockResolvedValue([pairingCheck]);
        mocks.pairingReadState.mockClear();
        mocks.sqliteOpen.mockClear();
        const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        try {
          const exitCode = await runDoctorLintCli(runtime, { json: true, includeAllChecks: true });
          const payload = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
          expect(exitCode).toBe(1);
          expect(payload.findings).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                requirement: "device-auth-store-legacy-file",
                message: expect.stringContaining(sourcePath),
                fixHint: expect.stringContaining("openclaw doctor --fix"),
              }),
              expect.objectContaining({
                requirement: "first-time",
                target: `snapshot-device:${pending.request.requestId}`,
              }),
            ]),
          );
          expect(mocks.pairingReadState).toHaveBeenCalledOnce();
          const inspectedState = mocks.pairingReadState.mock.calls[0]?.[0];
          expect(inspectedState).not.toBe(state.stateDir);
          expect(mocks.sqliteOpen).toHaveBeenCalled();
          expect(
            mocks.sqliteOpen.mock.calls.every(
              ([file]) => file !== path.toNamespacedPath(databasePath),
            ),
          ).toBe(true);
          expect(fs.readFileSync(sourcePath, "utf8")).toBe("legacy-file-marker");
          const after = snapshotDoctorLintSqliteFamily(databasePath);
          expect(after).toEqual(before);
          expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
          expect(process.env.OPENCLAW_PROFILE).toBeUndefined();
        } finally {
          stdout.mockRestore();
        }
      },
    );
  });

  it.each(["rehearsal-worker", "ordinary-default"] as const)(
    "inspects heartbeat source state and restores private inspection state (%s)",
    async (mode) => {
      await withOpenClawTestState({ prefix: "doctor-lint-heartbeat-source-" }, async (state) => {
        const config: OpenClawConfig = {
          agents: {
            ownership: "explicit",
            entries: { main: {} },
          },
          plugins: { enabled: false },
          memory: { search: { enabled: false } },
        };
        await state.writeConfig(config);
        const storePath = resolveCronJobsStorePathFromConfig(config, state.env);
        // Lint requires current config. Keep the pending migration in source state
        // through the real Doctor owner, rather than persisting the retired key.
        await ensureHeartbeatMonitorJobs(
          { ...config, agents: { ...config.agents, defaults: { heartbeat: { every: "15m" } } } },
          storePath,
          state.env,
        );
        writeConfigMachineState("doctorLint.source", "unchanged");
        await closeOpenClawStateDatabaseAsync();
        const sourcePath = resolveOpenClawStateSqlitePath(state.env);
        const before = snapshotDoctorLintSqliteFamily(sourcePath);
        const actual = await vi.importActual<
          typeof import("../flows/doctor-health-contributions.js")
        >("../flows/doctor-health-contributions.js");
        const heartbeat = (await actual.resolveDoctorContributionHealthChecks()).find(
          (check) => check.id === "core/doctor/heartbeat-cadence-migration",
        );
        if (!heartbeat) {
          throw new Error("heartbeat cadence contribution is missing");
        }
        let privateDatabase: ReturnType<typeof openOpenClawStateDatabase> | undefined;
        mocks.resolveDoctorContributionHealthChecks.mockResolvedValue([
          heartbeat,
          {
            id: "core/doctor/project-clone-shape",
            kind: "core",
            description: "inspects mutable plugin state after the source-bound check",
            async detect() {
              expect(process.env.OPENCLAW_STATE_DIR).not.toBe(state.stateDir);
              writeConfigMachineState("doctorLint.private", "private only");
              privateDatabase = openOpenClawStateDatabase();
              return [];
            },
          },
        ]);
        const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        try {
          await withEnvAsync(
            { OPENCLAW_CONFIG_PATH: mode === "rehearsal-worker" ? state.configPath : undefined },
            async () => {
              // Default selection keeps the outer source snapshot eager; --only hides this overlap.
              const exitCode =
                mode === "rehearsal-worker"
                  ? await runDoctorLintCliInProcess(
                      runtime,
                      { json: true },
                      { commandStartedAtMs: Date.now() },
                    )
                  : await runDoctorLintCli(runtime, { json: true });
              const report = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
              expect(report.findings).toEqual([
                expect.objectContaining({
                  checkId: heartbeat.id,
                  severity: "warning",
                  requirement: "heartbeat-retirement",
                  path: storePath,
                }),
              ]);
              expect(exitCode).toBe(1);
              expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
              expect(process.env.OPENCLAW_CONFIG_PATH).toBe(
                mode === "rehearsal-worker" ? state.configPath : undefined,
              );
            },
          );
          expect(privateDatabase).toBeDefined();
          expect(privateDatabase?.db.isOpen).toBe(false);
          expect(fs.existsSync(privateDatabase!.path)).toBe(false);
          expect(snapshotDoctorLintSqliteFamily(sourcePath)).toEqual(before);
        } finally {
          stdout.mockRestore();
        }
      });
    },
  );

  it("retains auth findings and source paths when mixed lint uses legacy-main shared auth", async () => {
    await withOpenClawTestState({ prefix: "openclaw-doctor-lint-auth-" }, async (state) => {
      const customDir = state.path("custom-agent");
      const config: OpenClawConfig = {
        gateway: { mode: "local" },
        agents: {
          ownership: "explicit",
          entries: { alpha: {}, healthy: {}, custom: { agentDir: customDir }, empty: {} },
        },
        plugins: { enabled: false },
      };
      await state.writeConfig(config);
      const store = (profileId: string, expired = true) => ({
        version: 1,
        profiles: {
          [profileId]: {
            type: "token" as const,
            provider: "diagnostic-provider",
            token: "synthetic-not-a-real-credential",
            expires: expired ? 1 : Date.now() + 7 * 86_400_000,
          },
        },
      });
      writeConfigMachineState("auth.sharedStore", { location: "legacy-main" });
      noteCommittedSharedAuthStoreOwnership({ location: "legacy-main" });
      writePersistedAuthProfileStoreRaw(
        store("diagnostic-provider:shared"),
        state.agentDir("main"),
      );
      writePersistedAuthProfileStoreRaw(
        store("diagnostic-provider:alpha"),
        state.agentDir("alpha"),
      );
      writePersistedAuthProfileStoreRaw(store("diagnostic-provider:custom"), customDir);
      writePersistedAuthProfileStoreRaw(
        store("diagnostic-provider:healthy", false),
        state.agentDir("healthy"),
      );
      const ownerDirs = [undefined, state.agentDir("alpha"), customDir, state.agentDir("healthy")];
      const before = ownerDirs.map((dir) => inspectPersistedAuthProfileStoreRaw(dir));
      const expected = [
        ["diagnostic-provider:alpha", path.join(state.agentDir("alpha"), "openclaw-agent.sqlite")],
        ["diagnostic-provider:custom", path.join(customDir, "openclaw-agent.sqlite")],
        ["diagnostic-provider:shared", resolveSharedAuthStorePath()],
      ];
      const actual = await vi.importActual<
        typeof import("../flows/doctor-health-contributions.js")
      >("../flows/doctor-health-contributions.js");
      const checks = await actual.resolveDoctorContributionHealthChecks();
      const sourceDatabase = openOpenClawStateDatabase();
      let privateDatabase: ReturnType<typeof openOpenClawStateDatabase> | undefined;
      const privateInspection = vi.fn(async () => {
        expect(process.env.OPENCLAW_STATE_DIR).not.toBe(state.stateDir);
        // Runtime inspectors can refresh OAuth state; that write must stay private.
        writeConfigMachineState("doctorLint.synthetic.privateWrite", true);
        privateDatabase = openOpenClawStateDatabase();
        return [];
      });
      mocks.resolveDoctorContributionHealthChecks.mockResolvedValue(
        checks.map((check) =>
          check.id === "core/doctor/runtime-tool-schemas"
            ? Object.assign({}, check, { detect: privateInspection })
            : check,
        ),
      );
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        for (const onlyIds of [
          ["core/doctor/auth-profiles"],
          [
            "core/doctor/auth-profiles",
            "memory-core/managed-local-embedding-setup",
            "core/doctor/runtime-tool-schemas",
          ],
        ]) {
          await expect(runDoctorLintCli(runtime, { json: true, onlyIds })).resolves.toBe(1);
          const report = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
          expect(
            report.findings
              .filter(
                (finding: { checkId: string }) => finding.checkId === "core/doctor/auth-profiles",
              )
              .map((finding: { target: string; path: string }) => [finding.target, finding.path])
              .toSorted(),
          ).toEqual(expected);
          expect(report.findings).toHaveLength(3);
          expect(ownerDirs.map((dir) => inspectPersistedAuthProfileStoreRaw(dir))).toEqual(before);
        }
        expect(privateInspection).toHaveBeenCalledOnce();
        expect(privateDatabase).toBeDefined();
        expect(privateDatabase?.db.isOpen).toBe(false);
        expect(fs.existsSync(privateDatabase!.path)).toBe(false);
        expect(sourceDatabase.db.isOpen).toBe(true);
        expect(readConfigMachineState("doctorLint.synthetic.privateWrite")).toBeUndefined();
      } finally {
        stdout.mockRestore();
        closeAuthProfileReadPool({ kind: "root", rootPath: state.root });
      }
    });
  });

  it.each([
    "reader-close-finding",
    "reader-close-full-finding",
    "writer-close",
    "cleanup-detector",
  ] as const)(
    "retires only private runtime-schema handles before snapshot removal (%s)",
    async (mode) => {
      await verifyDoctorLintPrivateAuthRetirement(
        runtime,
        mode,
        (checks) => mocks.resolveDoctorContributionHealthChecks.mockResolvedValue(checks),
        mocks.sqliteOpen,
      );
    },
  );

  it.each(["home", "state-only"] as const)(
    "keeps personal skill discovery scoped to the source profile (%s)",
    async (layout) => {
      await withOpenClawTestState(
        { prefix: "openclaw-doctor-personal-skills-", layout },
        async (state) => {
          await state.writeConfig({
            agents: { entries: { main: { workspace: state.workspaceDir } } },
            memory: { search: { enabled: false } },
          });
          const personal = path.join(state.home, ".agents", "skills", "personal-probe");
          fs.mkdirSync(personal, { recursive: true });
          fs.writeFileSync(
            path.join(personal, "SKILL.md"),
            '---\nname: personal-probe\ndescription: Personal source fixture\nmetadata: {"openclaw":{"requires":{"bins":["missing-personal-probe-bin"]}}}\n---\n',
          );
          const actual = await vi.importActual<
            typeof import("../flows/doctor-health-contributions.js")
          >("../flows/doctor-health-contributions.js");
          const check = (await actual.resolveDoctorContributionHealthChecks()).find(
            (entry) => entry.id === "core/doctor/skills-readiness",
          );
          if (!check) {
            throw new Error("skills-readiness contribution is missing");
          }
          mocks.resolveDoctorContributionHealthChecks.mockResolvedValue([check]);
          const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
          try {
            await runDoctorLintCli(runtime, { json: true, onlyIds: [check.id] });
            const findings = JSON.parse(String(stdout.mock.calls.at(-1)?.[0])).findings;
            expect(
              findings.filter(
                (finding: { path?: string }) =>
                  finding.path === "skills.entries.personal-probe.enabled",
              ),
            ).toEqual(
              layout === "home"
                ? [
                    expect.objectContaining({
                      severity: "warning",
                      message:
                        "personal-probe is allowed but unavailable: bins: missing-personal-probe-bin.",
                    }),
                  ]
                : [],
            );
            expect(fs.existsSync(path.join(state.stateDir, "plugin-skills"))).toBe(false);
            expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
          } finally {
            stdout.mockRestore();
          }
        },
      );
    },
  );

  it.each([true, false])(
    "checks source credentials during isolated lint (exists=%s)",
    async (exists) => {
      await withOpenClawTestState(
        { prefix: "openclaw-doctor-lint-credentials-", env: { OPENCLAW_TEST_FAST: "1" } },
        async (state) => {
          await state.writeConfig({
            gateway: { mode: "local" },
            channels: { telegram: { dmPolicy: "pairing" } },
          });
          fs.chmodSync(state.stateDir, 0o700);
          fs.chmodSync(state.configPath, 0o600);
          const credentials = path.join(state.stateDir, "credentials");
          if (exists) {
            fs.mkdirSync(credentials, { recursive: true, mode: 0o700 });
          }
          const actual = await vi.importActual<
            typeof import("../flows/doctor-health-contributions.js")
          >("../flows/doctor-health-contributions.js");
          const check = (await actual.resolveDoctorContributionHealthChecks()).find(
            (entry) => entry.id === "core/doctor/state-integrity",
          );
          if (!check) {
            throw new Error("state-integrity contribution is missing");
          }
          let isolated = false;
          mocks.resolveDoctorContributionHealthChecks.mockResolvedValue([
            check,
            {
              id: "core/doctor/runtime-tool-schemas",
              kind: "core",
              description: "verifies snapshot isolation",
              async detect(ctx: HealthCheckContext) {
                isolated = process.env.OPENCLAW_STATE_DIR !== state.stateDir;
                if (!check.repair) {
                  throw new Error("state-integrity repair is missing");
                }
                const effects = exists
                  ? []
                  : [
                      {
                        kind: "state",
                        action: "would-create-runtime-state-dir",
                        target: credentials,
                        dryRunSafe: false,
                      },
                    ];
                await expect(
                  check.repair({ ...ctx, mode: "fix", dryRun: true }, []),
                ).resolves.toEqual({
                  status: "repaired",
                  changes: [],
                  effects,
                });
                await expect(
                  check.repair({ ...ctx, mode: "fix", dryRun: false }, []),
                ).resolves.toEqual({
                  status: "skipped",
                  reason: "legacy doctor state integrity contribution owns state repairs",
                  changes: [],
                  effects,
                });
                return [];
              },
            },
          ]);
          const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
          const readFileSync = fs.readFileSync;
          const mountInfo = vi.spyOn(fs, "readFileSync");
          try {
            // Source isolation is independent of the temporary directory's backing filesystem.
            mountInfo.mockImplementation(
              (target, options?: fs.ReadFileSyncOptions | BufferEncoding | null) => {
                if (typeof options === "string") {
                  if (target === "/proc/self/mountinfo" && options === "utf8") {
                    return "22 1 0:21 / / rw,relatime - ext4 /dev/sda1 rw";
                  }
                  return readFileSync(target, options);
                }
                if (options == null) {
                  return readFileSync(target, options);
                }
                return readFileSync(target, options);
              },
            );
            await runDoctorLintCli(runtime, { json: true, includeAllChecks: true });
            const findings = JSON.parse(String(stdout.mock.calls.at(-1)?.[0])).findings;
            expect(isolated).toBe(true);
            expect(findings).toEqual(
              exists ? [] : [expect.objectContaining({ severity: "error", path: credentials })],
            );
            expect(fs.existsSync(credentials)).toBe(exists);
          } finally {
            mountInfo.mockRestore();
            stdout.mockRestore();
          }
        },
      );
    },
  );

  it.each(["live WAL", "closed WAL"] as const)(
    "reuses one writable inspection image per report from %s and prepares none when unused",
    async (mode) => {
      await withOpenClawTestState({ prefix: "doctor-lint-writable-reuse-" }, async (state) => {
        await state.writeConfig({
          plugins: { enabled: false },
          memory: { search: { enabled: false } },
        });
        const source = openOpenClawStateDatabase({ env: state.env });
        const privateStates: Array<ReturnType<typeof openOpenClawStateDatabase>> = [];
        const observed: Array<{ source: unknown; previous: unknown }> = [];
        const checkIds = [
          "core/doctor/skills-readiness",
          "core/doctor/runtime-tool-schemas",
          "core/doctor/project-clone-shape",
        ];
        mocks.resolveDoctorContributionHealthChecks.mockResolvedValue([
          ...checkIds.map((id, index) => ({
            id,
            kind: "core",
            description: "inspects and updates disposable plugin state",
            async detect(ctx: HealthCheckContext) {
              const options = {
                env: {
                  ...ctx.env,
                  OPENCLAW_STATE_DIR: resolveActivePluginInstallRoots().stateDir,
                },
              };
              privateStates.push(openOpenClawStateDatabase(options));
              observed.push({
                source: readConfigMachineState("doctorLint.source", options),
                previous: readConfigMachineState("doctorLint.privateStep", options),
              });
              writeConfigMachineState("doctorLint.privateStep", index, options);
              return [];
            },
          })),
          {
            id: "core/doctor/no-private-state",
            kind: "core",
            description: "does not require writable plugin state",
            async detect() {
              return [];
            },
          },
        ]);
        const prepare = vi.spyOn(sqliteSnapshotSource, "prepareSqliteReadOnlyLocationSync");
        const fork = vi.spyOn(sqliteSnapshotSource, "forkSqlitePrivateSnapshot");
        const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        const previousPaths = new Set<string>();
        try {
          for (const value of ["first report", "next report"]) {
            writeConfigMachineState("doctorLint.source", value, { env: state.env });
            if (mode === "closed WAL") {
              await closeOpenClawStateDatabaseAsync();
              expect(fs.existsSync(`${source.path}-wal`)).toBe(false);
            }
            const before = snapshotDoctorLintSqliteFamily(source.path);
            prepare.mockClear();
            fork.mockClear();
            privateStates.length = 0;
            observed.length = 0;
            const exitCode = await runDoctorLintCli(runtime, { json: true });
            const report = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
            expect(report.findings).toEqual([]);
            expect(exitCode).toBe(0);
            expect(
              prepare.mock.calls.filter(([location]) => location === source.path),
            ).toHaveLength(0);
            expect(fork).toHaveBeenCalledOnce();
            expect(fork.mock.calls[0]![0]).not.toBe(source.path);
            if (mode === "closed WAL") {
              expect(fork.mock.calls[0]![1].wal).toBeNull();
            }
            expect(observed).toEqual([
              { source: value, previous: undefined },
              { source: value, previous: 0 },
              { source: value, previous: 1 },
            ]);
            const privatePaths = new Set(privateStates.map(({ path: location }) => location));
            expect(privatePaths.size).toBe(1);
            for (const location of privatePaths) {
              expect(location).not.toBe(source.path);
              expect(previousPaths.has(location)).toBe(false);
              expect(fs.existsSync(location)).toBe(false);
              previousPaths.add(location);
            }
            expect(privateStates.every(({ db }) => !db.isOpen)).toBe(true);
            expect(source.db.isOpen).toBe(mode === "live WAL");
            expect(snapshotDoctorLintSqliteFamily(source.path)).toEqual(before);
          }
          const beforeUnused = snapshotDoctorLintSqliteFamily(source.path);
          prepare.mockClear();
          fork.mockClear();
          const exitCode = await runDoctorLintCli(runtime, {
            json: true,
            onlyIds: ["core/doctor/no-private-state"],
          });
          const report = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
          expect(report).toMatchObject({ checksRun: 1, findings: [] });
          expect(exitCode).toBe(0);
          expect(prepare).not.toHaveBeenCalled();
          expect(fork).not.toHaveBeenCalled();
          expect(snapshotDoctorLintSqliteFamily(source.path)).toEqual(beforeUnused);
        } finally {
          stdout.mockRestore();
          prepare.mockRestore();
          fork.mockRestore();
        }
      });
    },
  );

  it.each(["advisory", "selected"] as const)(
    "shares private bytes within each %s report and refreshes the next report",
    async (mode) => {
      await withOpenClawTestState({ prefix: "openclaw-doctor-lint-source-wal-" }, async (state) => {
        await state.writeConfig({ memory: { search: { enabled: false } } });
        const databasePath = resolveOpenClawStateSqlitePath(state.env);
        fs.mkdirSync(path.dirname(databasePath), { recursive: true });
        const writer = new DatabaseSync(databasePath);
        const locations: string[] = [];
        const observed: unknown[] = [];
        let fixtureValue = "committed";
        mocks.resolveDoctorContributionHealthChecks.mockResolvedValue([
          {
            id: "core/doctor/source-state-read",
            kind: "core",
            description: "reads source state through the shared read-only owner",
            async detect(ctx: HealthCheckContext) {
              for (let read = 0; read < 3; read++) {
                observed.push(
                  withExistingOpenClawStateDatabaseReadOnly(
                    ({ db }) => {
                      locations.push(requireNativeSqliteDatabase(db).location()!);
                      return db.prepare("SELECT value FROM marker").all();
                    },
                    { env: ctx.env },
                  ),
                );
                await Promise.resolve();
              }
              return [];
            },
          },
          {
            id: "core/doctor/async-source-state-read",
            kind: "core",
            description: "shares the source view with asynchronous checks",
            async detect(ctx: HealthCheckContext) {
              const options = { env: ctx.env };
              const snapshot = getActiveOpenClawStateDatabaseReadSnapshot(options);
              expect(snapshot).toBeDefined();
              locations.push(snapshot!.location);
              observed.push(
                await withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync(({ db }) => {
                  locations.push(requireNativeSqliteDatabase(db).location()!);
                  return db.prepare("SELECT value FROM marker").all();
                }, options),
              );
              await expect(
                executeExistingOpenClawStateRead(options, {
                  type: "tui.lastSession.read",
                  stateKey: "doctor.snapshot-reuse",
                }),
              ).resolves.toMatchObject({
                type: "tui.lastSession.read",
                row: { value_json: JSON.stringify(fixtureValue), updated_at_ms: 1 },
              });
              return [];
            },
          },
        ]);
        const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        try {
          writer.exec(
            "PRAGMA journal_mode = WAL; CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES ('committed'); CREATE TABLE config_machine_state (state_key TEXT NOT NULL PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL) STRICT;",
          );
          const previousLocations = new Set<string>();
          for (const value of ["committed", "updated"]) {
            fixtureValue = value;
            writer.prepare("UPDATE marker SET value = ?").run(value);
            writer
              .prepare("INSERT OR REPLACE INTO config_machine_state VALUES (?, ?, 1)")
              .run("doctor.snapshot-reuse", JSON.stringify(value));
            const before = snapshotDoctorLintSqliteFamily(databasePath);
            locations.length = 0;
            observed.length = 0;
            if (mode === "selected") {
              const exitCode = await runDoctorLintCli(runtime, {
                json: true,
                onlyIds: ["core/doctor/source-state-read", "core/doctor/async-source-state-read"],
              });
              const report = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
              expect(report).toMatchObject({
                checksRun: 2,
                findings: [],
              });
              expect(exitCode).toBe(0);
            } else {
              await collectDoctorFindings(runtime);
            }
            expect(observed).toEqual(Array.from({ length: 4 }, () => [{ value }]));
            // SQLite adds the Windows namespace prefix; compare one spelling of each file.
            const uniqueLocations = new Set(
              locations.map((location) => path.toNamespacedPath(location)),
            );
            expect(uniqueLocations.size).toBe(1);
            for (const location of uniqueLocations) {
              expect(location).not.toBe(path.toNamespacedPath(databasePath));
              expect(previousLocations.has(location)).toBe(false);
              expect(fs.existsSync(location)).toBe(false);
              previousLocations.add(location);
            }
            expect(snapshotDoctorLintSqliteFamily(databasePath)).toEqual(before);
          }
        } finally {
          stdout.mockRestore();
          writer.close();
        }
      });
    },
  );

  it("does not create shared state for a selected check", async () => {
    await withOpenClawTestState({ prefix: "openclaw-doctor-lint-no-state-" }, async (state) => {
      await state.writeConfig({ plugins: { enabled: false } });
      const databasePath = resolveOpenClawStateSqlitePath(state.env);
      expect(fs.existsSync(databasePath)).toBe(false);
      mocks.resolveDoctorContributionHealthChecks.mockResolvedValue([
        {
          id: "core/doctor/no-state-read",
          kind: "core",
          description: "does not require database state",
          async detect() {
            return [];
          },
        },
      ]);
      const before = snapshotDoctorLintSqliteFamily(databasePath);
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      mocks.sqliteOpen.mockClear();
      try {
        const exitCode = await runDoctorLintCli(runtime, {
          json: true,
          onlyIds: ["core/doctor/no-state-read"],
        });
        const report = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
        expect(report).toMatchObject({
          checksRun: 1,
          findings: [],
        });
        expect(exitCode).toBe(0);
        expect(mocks.sqliteOpen).not.toHaveBeenCalled();
        expect(snapshotDoctorLintSqliteFamily(databasePath)).toEqual(before);
      } finally {
        stdout.mockRestore();
      }
    });
  });

  it("keeps runtime schema OAuth inspection off the writable source state", async () => {
    await verifyDoctorLintOAuthStateIsolation(runtime, (checks) => {
      mocks.resolveDoctorContributionHealthChecks.mockResolvedValue(checks);
    });
  });

  it("records cancelled OAuth inspection without using a token or writing source state", async () => {
    await withOpenClawTestState({ prefix: "openclaw-doctor-lint-oauth-" }, async (state) => {
      await state.writeConfig({});
      const identity = operatorMcpOAuthIdentity("oauth-proof", "https://mcp.example.test/rpc");
      await seedDoctorLintMcpToken(identity);
      const databasePath = resolveOpenClawStateSqlitePath(state.env);
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
      const lock = new DatabaseSync(databasePath);
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        // Initialize WAL artifacts before hashing; Windows rejects raw reads under a write lock.
        lock.exec("BEGIN IMMEDIATE; ROLLBACK");
        const before = snapshotDoctorLintSqliteFamily(databasePath);
        let resolvedToken: string | undefined;
        mocks.resolveDoctorContributionHealthChecks.mockResolvedValue([
          {
            id: "core/doctor/runtime-tool-schemas",
            kind: "core",
            description: "checks OAuth state ownership",
            async detect() {
              const privateDatabasePath = resolveOpenClawStateSqlitePath(process.env);
              expect(privateDatabasePath).not.toBe(databasePath);
              const controller = new AbortController();
              return await withOpenClawStateLease(
                {
                  scope: "core:mcp-oauth",
                  key: identity.storeKey,
                  database: { scope: "shared", options: { path: privateDatabasePath } },
                  leaseMs: 60_000,
                  waitMs: 0,
                },
                async () => {
                  const acquire = leaseAcquisition.acquireOpenClawStateLease;
                  let acquisitionOutcome:
                    | Awaited<ReturnType<Parameters<typeof acquire>[0]["acquire"]>>
                    | undefined;
                  const acquisition = vi
                    .spyOn(leaseAcquisition, "acquireOpenClawStateLease")
                    .mockImplementation((params) =>
                      acquire({
                        ...params,
                        async acquire(...args) {
                          const outcome = await params.acquire(...args);
                          acquisitionOutcome = outcome;
                          // Observe real native or worker contention before its owner consumes it.
                          // A raw SQLite write lock can fail before an unrelated abort timer runs.
                          controller.abort(new Error("cancel pending OAuth inspection"));
                          return outcome;
                        },
                      }),
                    );
                  try {
                    resolvedToken = await resolveMcpOAuthAccessToken({
                      identity,
                      acceptUnknownExpiry: true,
                      signal: controller.signal,
                    });
                    return [];
                  } finally {
                    acquisition.mockRestore();
                    expect(acquisitionOutcome).toMatchObject({ kind: "held" });
                  }
                },
              );
            },
          },
        ]);

        lock.exec("BEGIN IMMEDIATE");
        const exitCode = await runDoctorLintCli(runtime, {
          json: true,
          onlyIds: ["core/doctor/runtime-tool-schemas"],
        });
        expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toMatchObject({
          ok: true,
          checksRun: 1,
          findings: [],
          warnings: [
            {
              checkId: "core/doctor/runtime-tool-schemas",
              severity: "info",
              errorCode: "OPENCLAW_STATE_LEASE_ABORTED",
              message: expect.stringMatching(
                /^state lease inspection not performed: aborted after \d+ ms by the caller's signal$/,
              ),
            },
          ],
        });
        lock.exec("ROLLBACK");
        expect(exitCode).toBe(0);
        expect(resolvedToken).toBeUndefined();
        expect(snapshotDoctorLintSqliteFamily(databasePath)).toEqual(before);
      } finally {
        stdout.mockRestore();
        if (lock.isTransaction) {
          lock.exec("ROLLBACK");
        }
        lock.close();
        await closeOpenClawStateDatabaseByPathAsync(databasePath);
      }
    });
  });
});
