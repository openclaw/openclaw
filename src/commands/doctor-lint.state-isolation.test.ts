import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
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
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { clearHealthChecksForTest } from "../flows/health-check-registry.js";
import type { HealthCheck, HealthCheckContext } from "../flows/health-checks.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import { cleanupSnapshotOperations } from "../infra/sqlite-readonly-location-cleanup.js";
import * as temporaryState from "../infra/tmp-openclaw-dir.js";
import { resolveManagedUpdateLeaseDatabasePath } from "../infra/update-managed-service-handoff-lease.js";
import { resolveActivePluginInstallRoots } from "../plugins/install-root-context.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { OpenClawStateLeaseAcquisitionError } from "../state/openclaw-state-lease-error.js";
import { captureEnv, withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runDoctorLintCliInProcess } from "./doctor-lint-runner.js";
import { runDoctorLintCli } from "./doctor-lint.js";
import { verifyDoctorLintOAuthStateIsolation } from "./doctor-lint.oauth-isolation.test-support.js";
import { verifyDoctorLintPrivateAuthRetirement } from "./doctor-lint.private-auth-retirement.test-support.js";
import { snapshotDoctorLintSqliteFamily } from "./doctor-lint.test-support.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  resolveDoctorContributionHealthChecks: vi.fn(),
  sqliteOpen: vi.fn<(filename: string, readOnly: boolean, database: DatabaseSync) => void>(),
}));

vi.mock("../flows/doctor-health-contributions.js", () => ({
  resolveDoctorContributionHealthChecks: mocks.resolveDoctorContributionHealthChecks,
}));
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
const healthCheck = (id: string, detect: HealthCheck["detect"]): HealthCheck => ({
  id: `core/doctor/${id}`,
  kind: "core",
  description: id,
  detect,
});

function captureStdout() {
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  return Object.assign(stdout, { [Symbol.dispose]: () => stdout.mockRestore() });
}

async function realHealthCheck(id: string) {
  const actual = await vi.importActual<typeof import("../flows/doctor-health-contributions.js")>(
    "../flows/doctor-health-contributions.js",
  );
  const check = (await actual.resolveDoctorContributionHealthChecks()).find(
    (entry) => entry.id === id,
  );
  if (!check) {
    throw new Error("Missing health check: " + id);
  }
  return check;
}
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
        const pairingCheck = await realHealthCheck("core/doctor/device-pairing");
        // Keep the real contribution and lint state-mode selection; unrelated core
        // checks must not turn this local state-boundary test into a service audit.
        mocks.resolveDoctorContributionHealthChecks.mockResolvedValue([pairingCheck]);
        mocks.sqliteOpen.mockClear();
        using stdout = captureStdout();
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
            defaults: { heartbeat: { every: "15m" } },
            entries: { main: {} },
          },
          plugins: { enabled: false },
          memory: { search: { enabled: false } },
        };
        await state.writeConfig(config);
        const storePath = resolveCronJobsStorePathFromConfig(config, state.env);
        writeConfigMachineState("doctorLint.source", "unchanged");
        await closeOpenClawStateDatabaseAsync();
        const sourcePath = resolveOpenClawStateSqlitePath(state.env);
        const before = snapshotDoctorLintSqliteFamily(sourcePath);
        const heartbeat = await realHealthCheck("core/doctor/heartbeat-cadence-migration");
        let privateDatabase: ReturnType<typeof openOpenClawStateDatabase> | undefined;
        mocks.resolveDoctorContributionHealthChecks.mockResolvedValue([
          heartbeat,
          healthCheck("project-clone-shape", async (ctx) => {
            expect(ctx.cfg.agents?.defaults).not.toHaveProperty("heartbeat");
            expect(process.env.OPENCLAW_STATE_DIR).not.toBe(state.stateDir);
            writeConfigMachineState("doctorLint.private", "private only");
            privateDatabase = openOpenClawStateDatabase();
            return [];
          }),
        ]);
        using stdout = captureStdout();
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
                fixHint: expect.stringContaining("openclaw doctor --fix"),
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
      });
    },
  );

  it.each(["retired heartbeat", "syntax"])(
    "rejects malformed %s before health checks",
    async (kind) => {
      await withOpenClawTestState({ prefix: "doctor-lint-invalid-" }, async (state) => {
        if (kind === "syntax") {
          fs.writeFileSync(state.configPath, "{ malformed");
        } else {
          await state.writeConfig({
            agents: {
              ownership: "explicit",
              defaults: { heartbeat: { every: "not-a-duration" } },
              entries: { main: {} },
            },
            plugins: { enabled: false },
            memory: { search: { enabled: false } },
          });
        }
        using stdout = captureStdout();
        expect(await runDoctorLintCli(runtime, { json: true })).toBe(1);
        expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0])).findings).toEqual([
          expect.objectContaining({
            checkId: "core/doctor/final-config-validation",
            severity: "error",
            ...(kind === "retired heartbeat" ? { path: "agents.defaults" } : {}),
          }),
        ]);
        expect(mocks.resolveDoctorContributionHealthChecks).not.toHaveBeenCalled();
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
      using stdout = captureStdout();
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
          const check = await realHealthCheck("core/doctor/skills-readiness");
          mocks.resolveDoctorContributionHealthChecks.mockResolvedValue([check]);
          using stdout = captureStdout();
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
          const check = await realHealthCheck("core/doctor/state-integrity");
          let isolated = false;
          mocks.resolveDoctorContributionHealthChecks.mockResolvedValue([
            check,
            healthCheck("runtime-tool-schemas", async () => {
              isolated = process.env.OPENCLAW_STATE_DIR !== state.stateDir;
              return [];
            }),
          ]);
          using stdout = captureStdout();
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
              exists
                ? []
                : [
                    {
                      checkId: "core/doctor/state-integrity",
                      severity: "warning",
                      message: "OAuth dir is missing.",
                      path: credentials,
                      fixHint:
                        "Run `openclaw doctor --fix` to create missing runtime state directories.",
                    },
                  ],
            );
            expect(fs.existsSync(credentials)).toBe(exists);
          } finally {
            mountInfo.mockRestore();
          }
        },
      );
    },
  );

  it.each(["live WAL", "closed WAL"] as const)(
    "reuses one writable inspection image per report from %s without changing unused state",
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
          healthCheck("no-private-state", async () => []),
        ]);
        using stdout = captureStdout();
        const previousPaths = new Set<string>();
        for (const value of ["first report", "next report"]) {
          writeConfigMachineState("doctorLint.source", value, { env: state.env });
          if (mode === "closed WAL") {
            await closeOpenClawStateDatabaseAsync();
            expect(fs.existsSync(`${source.path}-wal`)).toBe(false);
          }
          const before = snapshotDoctorLintSqliteFamily(source.path);
          privateStates.length = 0;
          observed.length = 0;
          const exitCode = await runDoctorLintCli(runtime, { json: true });
          const report = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
          expect(report.findings).toEqual([]);
          expect(exitCode).toBe(0);
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
          const after = snapshotDoctorLintSqliteFamily(source.path);
          if (mode === "live WAL") {
            expect(after.map(({ path: location }) => location)).toEqual(
              before.map(({ path: location }) => location),
            );
            const sharedMemoryPath = `${source.path}-shm`;
            expect(after.filter(({ path: location }) => location !== sharedMemoryPath)).toEqual(
              before.filter(({ path: location }) => location !== sharedMemoryPath),
            );
          } else {
            expect(after).toEqual(before);
          }
        }
        const beforeUnused = snapshotDoctorLintSqliteFamily(source.path);
        const exitCode = await runDoctorLintCli(runtime, {
          json: true,
          onlyIds: ["core/doctor/no-private-state"],
        });
        const report = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
        expect(report).toMatchObject({ checksRun: 1, findings: [] });
        expect(exitCode).toBe(0);
        expect(snapshotDoctorLintSqliteFamily(source.path)).toEqual(beforeUnused);
      });
    },
  );

  it("keeps runtime schema OAuth inspection off the writable source state", async () => {
    await verifyDoctorLintOAuthStateIsolation(runtime, (checks) => {
      mocks.resolveDoctorContributionHealthChecks.mockResolvedValue(checks);
    });
  });

  it("keeps cancelled inspections informational in CLI output", async () => {
    await withOpenClawTestState({ prefix: "doctor-lint-cancelled-" }, async (state) => {
      await state.writeConfig({});
      mocks.resolveDoctorContributionHealthChecks.mockResolvedValue([
        healthCheck("runtime-tool-schemas", async () => {
          throw new OpenClawStateLeaseAcquisitionError("cancelled inspection", {
            kind: "aborted",
            reason: "caller-signal",
            elapsedMs: 1,
          });
        }),
      ]);
      using stdout = captureStdout();
      expect(
        await runDoctorLintCli(runtime, {
          json: true,
          onlyIds: ["core/doctor/runtime-tool-schemas"],
        }),
      ).toBe(0);
      expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toMatchObject({
        findings: [],
        warnings: [
          expect.objectContaining({
            checkId: "core/doctor/runtime-tool-schemas",
            severity: "info",
            errorCode: "OPENCLAW_STATE_LEASE_ABORTED",
          }),
        ],
      });
    });
  });
});
