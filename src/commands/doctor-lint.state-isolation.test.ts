import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
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
import { clearHealthChecksForTest } from "../flows/health-check-registry.js";
import type { HealthCheck, HealthCheckContext } from "../flows/health-checks.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import { cleanupSnapshotOperations } from "../infra/sqlite-readonly-location-cleanup.js";
import * as temporaryState from "../infra/tmp-openclaw-dir.js";
import { resolveManagedUpdateLeaseDatabasePath } from "../infra/update-managed-service-handoff-lease.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as leaseAcquisition from "../state/openclaw-state-lease-acquisition.js";
import { withOpenClawStateLease } from "../state/openclaw-state-lease.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { DoctorLintCliOptions } from "./doctor-lint-options.js";
import { collectDoctorFindings } from "./doctor-lint-runner.js";
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
const schemaId = "core/doctor/runtime-tool-schemas";
const authId = "core/doctor/auth-profiles";
const privateWriteKey = "doctorLint.synthetic.privateWrite";
const lint = (opts: DoctorLintCliOptions) => runDoctorLintCli(runtime, { json: true, ...opts });
const installChecks = (...checks: HealthCheck[]) =>
  mocks.resolveDoctorContributionHealthChecks.mockResolvedValue(checks);
const runtimeCheck = (detect: HealthCheck["detect"], id = schemaId): HealthCheck => ({
  id,
  kind: "core",
  description: "inspects isolated state",
  detect,
});
const handoffDirs = useAutoCleanupTempDirTracker(afterEach);
let handoffResolver: MockInstance<typeof temporaryState.resolvePreferredOpenClawTmpDir> | undefined;
let stdout: MockInstance<typeof process.stdout.write>;
const report = () => JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
async function coreChecks() {
  const actual = await vi.importActual<typeof import("../flows/doctor-health-contributions.js")>(
    "../flows/doctor-health-contributions.js",
  );
  return actual.resolveDoctorContributionHealthChecks();
}
async function coreCheck(id: string) {
  const check = (await coreChecks()).find((entry) => entry.id === `core/doctor/${id}`);
  if (!check) {
    throw new Error(`${id} contribution is missing`);
  }
  return check;
}

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
  stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() =>
  closeOpenClawStateDatabaseAsync()
    .finally(closeOpenClawStateDatabaseForTest)
    .finally(cleanupSnapshotOperations)
    .finally(() => {
      handoffResolver?.mockRestore();
      stdout.mockRestore();
    }),
);

it("keeps retired device-auth detection scoped for --all", () =>
  withOpenClawTestState(
    { env: { OPENCLAW_TEST_FAST: "1", OPENCLAW_PROFILE: undefined } },
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
      const pairingCheck = await coreCheck("device-pairing");
      // Keep the real contribution and lint state-mode selection; unrelated core
      // checks must not turn this local state-boundary test into a service audit.
      installChecks(pairingCheck);
      mocks.pairingReadState.mockClear();
      mocks.sqliteOpen.mockClear();
      const exitCode = await lint({ includeAllChecks: true });
      expect(exitCode).toBe(1);
      expect(report().findings).toEqual(
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
      expect(mocks.sqliteOpen.mock.calls.map(([file]) => file)).not.toContain(
        path.toNamespacedPath(databasePath),
      );
      expect(fs.readFileSync(sourcePath, "utf8")).toBe("legacy-file-marker");
      expect(snapshotDoctorLintSqliteFamily(databasePath)).toEqual(before);
      expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
      expect(process.env.OPENCLAW_PROFILE).toBeUndefined();
    },
  ));

it("retains auth findings and source paths when mixed lint uses legacy-main shared auth", () =>
  withOpenClawTestState({}, async (state) => {
    const customDir = state.path("custom-agent");
    await state.writeConfig({
      gateway: { mode: "local" },
      agents: {
        ownership: "explicit",
        entries: { alpha: {}, healthy: {}, custom: { agentDir: customDir }, empty: {} },
      },
      plugins: { enabled: false },
    });
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
    for (const [id, dir] of [
      ["shared", state.agentDir("main")],
      ["alpha", state.agentDir("alpha")],
      ["custom", customDir],
      ["healthy", state.agentDir("healthy")],
    ] as const) {
      writePersistedAuthProfileStoreRaw(store(`diagnostic-provider:${id}`, id !== "healthy"), dir);
    }
    const ownerDirs = [undefined, state.agentDir("alpha"), customDir, state.agentDir("healthy")];
    const before = ownerDirs.map((dir) => inspectPersistedAuthProfileStoreRaw(dir));
    const expected = [
      ["diagnostic-provider:alpha", path.join(state.agentDir("alpha"), "openclaw-agent.sqlite")],
      ["diagnostic-provider:custom", path.join(customDir, "openclaw-agent.sqlite")],
      ["diagnostic-provider:shared", resolveSharedAuthStorePath()],
    ];
    const checks = await coreChecks();
    const sourceDatabase = openOpenClawStateDatabase();
    let privateDatabase: ReturnType<typeof openOpenClawStateDatabase> | undefined;
    const privateInspection = vi.fn(async () => {
      expect(process.env.OPENCLAW_STATE_DIR).not.toBe(state.stateDir);
      // Runtime inspectors can refresh OAuth state; that write must stay private.
      writeConfigMachineState(privateWriteKey, true);
      privateDatabase = openOpenClawStateDatabase();
      return [];
    });
    installChecks(
      ...checks.map((check) =>
        check.id === schemaId ? Object.assign({}, check, { detect: privateInspection }) : check,
      ),
    );
    try {
      for (const onlyIds of [
        [authId],
        [authId, "memory-core/managed-local-embedding-setup", schemaId],
      ]) {
        await expect(lint({ onlyIds })).resolves.toBe(1);
        const payload = report();
        expect(
          payload.findings
            .filter((finding: { checkId: string }) => finding.checkId === authId)
            .map((finding: { target: string; path: string }) => [finding.target, finding.path])
            .toSorted(),
        ).toEqual(expected);
        expect(payload.findings).toHaveLength(3);
        expect(ownerDirs.map((dir) => inspectPersistedAuthProfileStoreRaw(dir))).toEqual(before);
      }
      expect(privateInspection).toHaveBeenCalledOnce();
      expect(privateDatabase).toMatchObject({ db: { isOpen: false } });
      expect(fs.existsSync(privateDatabase!.path)).toBe(false);
      expect(sourceDatabase.db.isOpen).toBe(true);
      expect(readConfigMachineState(privateWriteKey)).toBeUndefined();
    } finally {
      closeAuthProfileReadPool({ kind: "root", rootPath: state.root });
    }
  }));

it.each([
  "reader-close-finding",
  "reader-close-full-finding",
  "writer-close",
  "cleanup-detector",
] as const)("retires only private runtime-schema handles before snapshot removal (%s)", (mode) =>
  verifyDoctorLintPrivateAuthRetirement(
    runtime,
    mode,
    (checks) => installChecks(...checks),
    mocks.sqliteOpen,
  ),
);

it.each(["home", "state-only"] as const)(
  "keeps personal skill discovery scoped to the source profile (%s)",
  (layout) =>
    withOpenClawTestState({ layout }, async (state) => {
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
      const check = await coreCheck("skills-readiness");
      installChecks(check);
      await lint({ onlyIds: [check.id] });
      const { findings } = report();
      const unavailable = expect.objectContaining({
        severity: "warning",
        message: "personal-probe is allowed but unavailable: bins: missing-personal-probe-bin.",
      });
      expect(
        findings.filter(
          (finding: { path?: string }) => finding.path === "skills.entries.personal-probe.enabled",
        ),
      ).toEqual(layout === "home" ? [unavailable] : []);
      expect(fs.existsSync(path.join(state.stateDir, "plugin-skills"))).toBe(false);
      expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
    }),
);

it.each([true, false])("checks source credentials during isolated lint (exists=%s)", (exists) =>
  withOpenClawTestState({ env: { OPENCLAW_TEST_FAST: "1" } }, async (state) => {
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
    const check = await coreCheck("state-integrity");
    let isolated = false;
    installChecks(
      check,
      runtimeCheck(async (ctx: HealthCheckContext) => {
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
        for (const dryRun of [true, false]) {
          await expect(check.repair({ ...ctx, mode: "fix", dryRun }, [])).resolves.toEqual({
            status: dryRun ? "repaired" : "skipped",
            ...(dryRun
              ? {}
              : { reason: "legacy doctor state integrity contribution owns state repairs" }),
            changes: [],
            effects,
          });
        }
        return [];
      }),
    );
    const readFileSync = fs.readFileSync;
    using mountInfo = vi.spyOn(fs, "readFileSync");
    // Source isolation is independent of the temporary directory's backing filesystem.
    mountInfo.mockImplementation(
      (target, options?: fs.ReadFileSyncOptions | BufferEncoding | null) => {
        if (target === "/proc/self/mountinfo" && options === "utf8") {
          return "22 1 0:21 / / rw,relatime - ext4 /dev/sda1 rw";
        }
        return readFileSync(target, options);
      },
    );
    await lint({ includeAllChecks: true });
    const { findings } = report();
    expect(isolated).toBe(true);
    expect(findings).toEqual(
      exists ? [] : [expect.objectContaining({ severity: "error", path: credentials })],
    );
    expect(fs.existsSync(credentials)).toBe(exists);
  }),
);

it("shares private bytes within each advisory report and refreshes the next report", () =>
  withOpenClawTestState({}, async (state) => {
    await state.writeConfig({ memory: { search: { enabled: false } } });
    const databasePath = resolveOpenClawStateSqlitePath(state.env);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    using writer = new DatabaseSync(databasePath);
    const locations: string[] = [];
    const observed: unknown[] = [];
    installChecks(
      runtimeCheck(async (ctx: HealthCheckContext) => {
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
      }, "core/doctor/source-state-read"),
    );
    writer.exec(
      "PRAGMA journal_mode = WAL; CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES ('committed');",
    );
    const previousLocations = new Set<string>();
    for (const value of ["committed", "updated"]) {
      writer.prepare("UPDATE marker SET value = ?").run(value);
      const before = snapshotDoctorLintSqliteFamily(databasePath);
      locations.length = 0;
      observed.length = 0;
      await collectDoctorFindings(runtime);
      expect(observed).toEqual(Array.from({ length: 3 }, () => [{ value }]));
      expect(new Set(locations).size).toBe(1);
      const location = locations[0]!;
      expect(location).not.toBe(databasePath);
      expect(previousLocations.has(location)).toBe(false);
      expect(fs.existsSync(location)).toBe(false);
      previousLocations.add(location);
      expect(snapshotDoctorLintSqliteFamily(databasePath)).toEqual(before);
    }
  }));

it("keeps runtime schema OAuth inspection off the writable source state", () =>
  verifyDoctorLintOAuthStateIsolation(runtime, (checks) => installChecks(...checks)));

it("records cancelled OAuth inspection without using a token or writing source state", () =>
  withOpenClawTestState({}, async (state) => {
    await state.writeConfig({});
    const identity = operatorMcpOAuthIdentity("oauth-proof", "https://mcp.example.test/rpc");
    await seedDoctorLintMcpToken(identity);
    const databasePath = resolveOpenClawStateSqlitePath(state.env);
    await closeOpenClawStateDatabaseByPathAsync(databasePath);
    const lock = new DatabaseSync(databasePath);
    try {
      // Initialize WAL artifacts before hashing; Windows rejects raw reads under a write lock.
      lock.exec("BEGIN IMMEDIATE; ROLLBACK");
      const before = snapshotDoctorLintSqliteFamily(databasePath);
      let resolvedToken: string | undefined;
      installChecks(
        runtimeCheck(async () => {
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
              let acquisitionOutcome: unknown;
              using acquisition = vi
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
              resolvedToken = await resolveMcpOAuthAccessToken({
                identity,
                acceptUnknownExpiry: true,
                signal: controller.signal,
              });
              expect(acquisition).toHaveBeenCalled();
              expect(acquisitionOutcome).toMatchObject({ kind: "held" });
              return [];
            },
          );
        }),
      );

      lock.exec("BEGIN IMMEDIATE");
      const exitCode = await lint({ onlyIds: [schemaId] });
      expect(report()).toMatchObject({
        ok: true,
        checksRun: 1,
        findings: [],
        warnings: [
          {
            checkId: schemaId,
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
      if (lock.isTransaction) {
        lock.exec("ROLLBACK");
      }
      lock.close();
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
    }
  }));
