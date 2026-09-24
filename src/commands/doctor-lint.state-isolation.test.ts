import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { resolveCronJobsStorePathFromConfig, saveCronStore } from "../cron/store.js";
import { clearHealthChecksForTest } from "../flows/health-check-registry.js";
import type { HealthCheckContext } from "../flows/health-checks.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import { createSkillProposalEvent } from "../skills/workshop/plugin-hooks.js";
import { appendSkillProposalEvent } from "../skills/workshop/store-sqlite-event.js";
import { importLegacySkillProposal } from "../skills/workshop/store.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  closeOpenClawStateDatabaseByPathAsync,
  registerOpenClawStateDatabaseAsyncResource,
} from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateReadConnection } from "../state/openclaw-state-db-read-connection.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as leaseAcquisition from "../state/openclaw-state-lease-acquisition.js";
import { withOpenClawStateLease } from "../state/openclaw-state-lease.js";
import { captureEnv } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { collectDoctorFindings, runDoctorLintCli } from "./doctor-lint.js";
import {
  seedDoctorLintMcpToken,
  snapshotDoctorLintSqliteFamily,
} from "./doctor-lint.test-support.js";
import { createAppliedLegacyProposal } from "./doctor-skill-workshop-sqlite.test-support.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  resolveDoctorContributionHealthChecks: vi.fn(),
  pairingReadState: vi.fn(),
  sqliteOpen: vi.fn(),
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
      mocks.sqliteOpen(args[0], args[1]?.readOnly === true, database);
      return database;
    },
  };
});

// Resolve the real descriptor during collection so cold module loading is not timed as behavior.
const actualContributions = await vi.importActual<
  typeof import("../flows/doctor-health-contributions.js")
>("../flows/doctor-health-contributions.js");
const workshopCheck = (await actualContributions.resolveDoctorContributionHealthChecks()).find(
  (entry) => entry.id === "core/doctor/skill-workshop-relocation",
);
const runtime = createTestRuntime();

const originalEnv = captureEnv(["HOME", "OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR"]);

describe("doctor lint state isolation", () => {
  beforeEach(() => {
    clearHealthChecksForTest();
    mocks.resolveDoctorContributionHealthChecks.mockReset();
    mocks.pairingReadState.mockClear();
    mocks.sqliteOpen.mockClear();
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    originalEnv.restore();
  });

  it.each([false, true])(
    "runDoctorLintCli --all classifies registered Workshop targets (external=%s)",
    async (external) => {
      await withOpenClawTestState({ prefix: "openclaw-doctor-lint-workshop-" }, async (state) => {
        const customDir = state.path("custom-agent");
        await state.writeConfig({
          agents: { entries: { main: { default: true }, custom: { agentDir: customDir } } },
          memory: { search: { enabled: false } },
        });
        const targets = [
          { id: "canonical-main", owner: "main", root: state.agentDir("main") },
          { id: "canonical-custom", owner: "custom", root: customDir },
          ...(external ? [{ id: "external", owner: "main", root: state.path("outside") }] : []),
        ];
        for (const { id, owner, root } of targets) {
          const skillDir = path.join(root, "workshop-skills", id);
          const content = `---\nname: ${id}\ndescription: Saved test procedure\n---\n`;
          const record = createAppliedLegacyProposal({
            id,
            title: id,
            description: "Saved test procedure",
            content,
            target: { skillKey: id, skillDir },
          });
          fs.mkdirSync(skillDir, { recursive: true });
          fs.writeFileSync(record.target.skillFile, content);
          importLegacySkillProposal({ record, ownerAgentId: owner, store: { env: state.env } });
        }
        const databasePath = resolveOpenClawStateSqlitePath(state.env);
        await closeOpenClawStateDatabaseByPathAsync(databasePath);
        const before = snapshotDoctorLintSqliteFamily(databasePath);
        const filesBefore = fs
          .readdirSync(state.stateDir, { recursive: true, encoding: "utf8" })
          .toSorted((left, right) => left.localeCompare(right));
        const skillContents = targets.map(({ id, root }) =>
          fs.readFileSync(path.join(root, "workshop-skills", id, "SKILL.md"), "utf8"),
        );
        const check = selectWorkshopCheckWithUnavailableSource(databasePath);
        mocks.sqliteOpen.mockClear();
        const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        try {
          const exitCode = await runDoctorLintCli(runtime, { json: true, includeAllChecks: true });
          const report = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
          expect(exitCode).toBe(external ? 1 : 0);
          if (external) {
            expect(report.findings).toEqual([
              expect.objectContaining({
                checkId: check.id,
                message: expect.stringContaining("1 proposal target outside agent directories"),
              }),
            ]);
            expect(report.findings[0].message).toContain(state.path("outside"));
            expect(report.findings[0].message).not.toContain("canonical-main");
            expect(report.findings[0].message).not.toContain("canonical-custom");
          } else {
            expect(report.findings).toEqual([]);
          }
          expect(mocks.sqliteOpen).toHaveBeenCalled();
          expect(mocks.sqliteOpen.mock.calls.every(([file]) => file !== databasePath)).toBe(true);
          expect(snapshotDoctorLintSqliteFamily(databasePath)).toEqual(before);
          expect(
            fs
              .readdirSync(state.stateDir, { recursive: true, encoding: "utf8" })
              .toSorted((left, right) => left.localeCompare(right)),
          ).toEqual(filesBefore);
          expect(
            targets.map(({ id, root }) =>
              fs.readFileSync(path.join(root, "workshop-skills", id, "SKILL.md"), "utf8"),
            ),
          ).toEqual(skillContents);
          expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
        } finally {
          stdout.mockRestore();
        }
      });
    },
  );

  it.each([false, true])(
    "runDoctorLintCli --all retains registered Workshop history findings (custom partition=%s)",
    async (customPartition) => {
      await withOpenClawTestState(
        { prefix: "openclaw-doctor-lint-workshop-history-" },
        async (state) => {
          const config: OpenClawConfig = {
            agents: { entries: { main: { workspace: state.workspaceDir } } },
            memory: { search: { enabled: false } },
          };
          await state.writeConfig(config);
          const legacyDir = path.join(state.workspaceDir, "skills", "relocated");
          const destination = path.join(state.agentDir("main"), "workshop-skills", "relocated");
          const record = createAppliedLegacyProposal({
            id: "relocated",
            title: "Relocated procedure",
            description: "Saved test procedure",
            content: "# Saved procedure\n",
            target: { skillKey: "relocated", skillDir: destination },
          });
          fs.mkdirSync(destination, { recursive: true });
          fs.writeFileSync(record.target.skillFile, "# Saved procedure\n");
          importLegacySkillProposal({ record, ownerAgentId: "main", store: { env: state.env } });
          appendSkillProposalEvent(
            openOpenClawStateDatabase({ env: state.env }).db,
            createSkillProposalEvent({
              record,
              type: "applied",
              payload: { targetSkillFile: path.join(legacyDir, "SKILL.md") },
            }),
          );
          if (customPartition) {
            writeConfigMachineState("cron.store", "~/custom-jobs.json");
          }
          await saveCronStore(resolveCronJobsStorePathFromConfig(config, state.env), {
            version: 1,
            jobs: [
              {
                id: "legacy-command",
                name: "Legacy command",
                agentId: "main",
                enabled: true,
                createdAtMs: 1,
                updatedAtMs: 1,
                schedule: { kind: "every", everyMs: 86400000 },
                sessionTarget: "isolated",
                wakeMode: "now",
                payload: { kind: "command", argv: ["node", "check.js"], cwd: legacyDir },
                state: {},
              },
            ],
          });
          const backup = await state.writeJson(
            "skill-workshop/collection-backups/0123456789abcdef/retained/manifest.json",
            {
              schema: "openclaw.skill-collection-backup.v1",
              id: "retained",
              createdAt: "2026-09-01T00:00:00.000Z",
              workspaceDir: state.workspaceDir,
              skillDirs: [],
              resultSkillDirs: [],
              resultSkillHashes: {},
            },
          );
          const databasePath = resolveOpenClawStateSqlitePath(state.env);
          await closeOpenClawStateDatabaseByPathAsync(databasePath);
          const before = snapshotDoctorLintSqliteFamily(databasePath);
          const backupBefore = fs.readFileSync(backup, "utf8");
          selectWorkshopCheckWithUnavailableSource(databasePath);
          mocks.sqliteOpen.mockClear();
          const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
          try {
            await expect(
              runDoctorLintCli(runtime, { json: true, includeAllChecks: true }),
            ).resolves.toBe(1);
            const report = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
            expect(report.findings).toHaveLength(2);
            expect(report.findings).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  target: "legacy-command",
                  path: "payload.cwd",
                  fixHint: expect.stringContaining(destination),
                }),
                expect.objectContaining({
                  path: "skills.workshop",
                  message: expect.stringContaining(
                    "0 proposal targets outside agent directories () and 1 legacy collection backup root",
                  ),
                }),
              ]),
            );
            expect(mocks.sqliteOpen).toHaveBeenCalled();
            expect(mocks.sqliteOpen.mock.calls.every(([file]) => file !== databasePath)).toBe(true);
            expect(snapshotDoctorLintSqliteFamily(databasePath)).toEqual(before);
            expect(fs.readFileSync(backup, "utf8")).toBe(backupBefore);
            expect(fs.readFileSync(record.target.skillFile, "utf8")).toBe("# Saved procedure\n");
          } finally {
            stdout.mockRestore();
          }
        },
      );
    },
  );

  it.each([
    { label: "--all", selection: "all", profile: undefined, isolated: true },
    { label: "mixed --only with profile", selection: "mixed", profile: "work", isolated: true },
    { label: "--only with profile", selection: "only", profile: "work", isolated: false },
    { label: "default selection", selection: "default", profile: undefined, isolated: false },
  ] as const)("keeps retired device-auth detection scoped for $label", async (entry) => {
    await withOpenClawTestState(
      {
        prefix: "openclaw-doctor-lint-device-auth-",
        env: { OPENCLAW_TEST_FAST: "1", OPENCLAW_PROFILE: entry.profile },
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
          const selection =
            entry.selection === "all"
              ? { includeAllChecks: true }
              : entry.selection === "default"
                ? {}
                : {
                    onlyIds: [
                      "core/doctor/device-pairing",
                      ...(entry.selection === "mixed"
                        ? ["memory-core/managed-local-embedding-setup"]
                        : []),
                    ],
                  };
          const exitCode = await runDoctorLintCli(runtime, { json: true, ...selection });
          const payload = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
          if (entry.selection === "default") {
            expect(exitCode).toBe(0);
            expect(payload.findings).toEqual([]);
            expect(mocks.pairingReadState).not.toHaveBeenCalled();
          } else {
            expect(exitCode).toBe(1);
            expect(payload.findings).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  requirement: "device-auth-store-legacy-file",
                  message: expect.stringContaining(sourcePath),
                  fixHint: expect.stringContaining(
                    entry.profile
                      ? "openclaw --profile work doctor --fix"
                      : "openclaw doctor --fix",
                  ),
                }),
                expect.objectContaining({
                  requirement: "first-time",
                  target: `snapshot-device:${pending.request.requestId}`,
                }),
              ]),
            );
            expect(mocks.pairingReadState).toHaveBeenCalledOnce();
            const inspectedState = mocks.pairingReadState.mock.calls[0]?.[0];
            if (entry.isolated) {
              expect(inspectedState).not.toBe(state.stateDir);
              expect(mocks.sqliteOpen).toHaveBeenCalled();
              expect(mocks.sqliteOpen.mock.calls.every(([file]) => file !== databasePath)).toBe(
                true,
              );
            } else {
              expect(inspectedState).toBe(state.stateDir);
            }
          }
          expect(fs.readFileSync(sourcePath, "utf8")).toBe("legacy-file-marker");
          const after = snapshotDoctorLintSqliteFamily(databasePath);
          if (entry.isolated) {
            expect(after).toEqual(before);
          } else {
            // Ordinary read-only metadata reads may create WAL/SHM coordination files.
            // Unchanged database bytes plus an empty WAL rule out durable row changes.
            expect(after[0]).toEqual(before[0]);
            for (const artifact of after.slice(1)) {
              if (artifact.path === `${databasePath}-wal`) {
                expect(fs.statSync(artifact.path).size).toBe(0);
              } else {
                expect(artifact.path).toBe(`${databasePath}-shm`);
              }
            }
            expect(
              mocks.sqliteOpen.mock.calls.every(
                ([file, readOnly]) => file !== databasePath || readOnly === true,
              ),
            ).toBe(true);
          }
          expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
          expect(process.env.OPENCLAW_PROFILE).toBe(entry.profile);
        } finally {
          stdout.mockRestore();
        }
      },
    );
  });

  it.each(["legacy-main", "state-db"] as const)(
    "retains auth findings and source paths when mixed lint uses %s shared auth",
    async (location) => {
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
        writeConfigMachineState("auth.sharedStore", { location });
        noteCommittedSharedAuthStoreOwnership({ location });
        writePersistedAuthProfileStoreRaw(
          store("diagnostic-provider:shared"),
          location === "legacy-main" ? state.agentDir("main") : undefined,
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
        const ownerDirs = [
          undefined,
          state.agentDir("alpha"),
          customDir,
          state.agentDir("healthy"),
        ];
        const before = ownerDirs.map((dir) => inspectPersistedAuthProfileStoreRaw(dir));
        const expected = [
          [
            "diagnostic-provider:alpha",
            path.join(state.agentDir("alpha"), "openclaw-agent.sqlite"),
          ],
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
            expect(ownerDirs.map((dir) => inspectPersistedAuthProfileStoreRaw(dir))).toEqual(
              before,
            );
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
    },
  );

  it("retires private runtime-schema handles before Windows snapshot removal", async () => {
    await withOpenClawTestState({ prefix: "openclaw-doctor-lint-retirement-" }, async (state) => {
      await state.writeConfig({ memory: { search: { enabled: false } } });
      const source = openOpenClawStateDatabase();
      const before = snapshotDoctorLintSqliteFamily(source.path);
      const opened: Array<{ filename: string; database: DatabaseSync }> = [];
      mocks.sqliteOpen.mockImplementation(
        (filename: string, _readOnly: boolean, database: DatabaseSync) => {
          opened.push({ filename, database });
        },
      );
      let privateWriter: ReturnType<typeof openOpenClawStateDatabase> | undefined;
      let privateReader: ReturnType<typeof openOpenClawStateReadConnection> | undefined;
      let unregister: (() => void) | undefined;
      let removedSnapshot = false;
      mocks.resolveDoctorContributionHealthChecks.mockResolvedValue([
        {
          id: "core/doctor/runtime-tool-schemas",
          kind: "core",
          description: "inspects private runtime state",
          async detect() {
            writeConfigMachineState("doctorLint.synthetic.privateWrite", true);
            const writer = openOpenClawStateDatabase();
            const reader = openOpenClawStateReadConnection(writer.path, writer.path);
            const admission = captureOpenClawStateDatabaseReadAdmission(writer.path);
            privateWriter = writer;
            privateReader = reader;
            unregister = registerOpenClawStateDatabaseAsyncResource({
              async close(identity) {
                if (identity !== undefined && identity.key !== admission.identity.key) {
                  return;
                }
                await Promise.resolve();
                reader.close();
              },
            });
            return [];
          },
        },
      ]);
      const remove = fs.promises.rm;
      const removal = vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
        const directory = String(target);
        const prefix = `${directory}${path.sep}`;
        // Windows refuses removal while SQLite or its coordinator retains a native handle.
        if (
          opened.some(({ filename, database }) => filename.startsWith(prefix) && database.isOpen)
        ) {
          throw Object.assign(new Error("Snapshot still has an open native handle"), {
            code: "EPERM",
          });
        }
        await remove(target, options);
        if (privateWriter?.path.startsWith(prefix)) {
          removedSnapshot = true;
        }
      });
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        await expect(
          runDoctorLintCli(runtime, {
            json: true,
            onlyIds: ["core/doctor/runtime-tool-schemas"],
          }),
        ).resolves.toBe(0);
        expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0])).findings).toEqual([]);
        expect(privateWriter?.db.isOpen).toBe(false);
        expect(privateReader?.database.db.isOpen).toBe(false);
        expect(removedSnapshot).toBe(true);
        expect(source.db.isOpen).toBe(true);
        expect(snapshotDoctorLintSqliteFamily(source.path)).toEqual(before);
        expect(readConfigMachineState("doctorLint.synthetic.privateWrite")).toBeUndefined();
      } finally {
        removal.mockRestore();
        stdout.mockRestore();
        mocks.sqliteOpen.mockReset();
        if (privateWriter) {
          await closeOpenClawStateDatabaseByPathAsync(privateWriter.path);
        }
        unregister?.();
      }
    });
  });

  it.each([
    {
      privateCheckId: "core/doctor/runtime-tool-schemas",
      extraIds: ["memory-core/managed-local-embedding-setup"],
    },
    { privateCheckId: "core/doctor/project-clone-shape", extraIds: [] },
  ])(
    "restores the private view for $privateCheckId after an auth detector throws",
    async ({ privateCheckId, extraIds }) => {
      await withOpenClawTestState({ prefix: "openclaw-doctor-lint-auth-throw-" }, async (state) => {
        await state.writeConfig({ memory: { search: { enabled: false } } });
        const sourceConfigPath = process.env.OPENCLAW_CONFIG_PATH;
        const observedStates: Array<string | undefined> = [];
        mocks.resolveDoctorContributionHealthChecks.mockResolvedValue([
          {
            id: "core/doctor/auth-profiles",
            kind: "core",
            description: "checks source auth state",
            async detect() {
              observedStates.push(process.env.OPENCLAW_STATE_DIR);
              throw new Error("synthetic auth detector failure");
            },
          },
          {
            id: privateCheckId,
            kind: "core",
            description: "checks private runtime state",
            async detect() {
              observedStates.push(process.env.OPENCLAW_STATE_DIR);
              return [];
            },
          },
        ]);
        const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        try {
          await expect(
            runDoctorLintCli(runtime, {
              json: true,
              onlyIds: ["core/doctor/auth-profiles", ...extraIds, privateCheckId],
            }),
          ).resolves.toBe(1);
          expect(observedStates[0]).toBe(state.stateDir);
          expect(observedStates[1]).toEqual(expect.any(String));
          expect(observedStates[1]).not.toBe(state.stateDir);
          expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0])).findings).toEqual([
            expect.objectContaining({
              checkId: "core/doctor/auth-profiles",
              message: "health check threw: synthetic auth detector failure",
            }),
          ]);
          expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
          expect(process.env.OPENCLAW_CONFIG_PATH).toBe(sourceConfigPath);
        } finally {
          stdout.mockRestore();
        }
      });
    },
  );

  it.each(["home", "state-only"] as const)(
    "keeps personal skill discovery scoped to the source profile (%s)",
    async (layout) => {
      await withOpenClawTestState(
        { prefix: "openclaw-doctor-personal-skills-", layout },
        async (state) => {
          await state.writeConfig({
            agents: { entries: { main: { default: true, workspace: state.workspaceDir } } },
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

  it.each(["lint", "advisory"])(
    "shares private bytes within each %s report and refreshes the next report",
    async (entrypoint) => {
      await withOpenClawTestState({ prefix: "openclaw-doctor-lint-source-wal-" }, async (state) => {
        await state.writeConfig({ memory: { search: { enabled: false } } });
        const databasePath = resolveOpenClawStateSqlitePath(state.env);
        fs.mkdirSync(path.dirname(databasePath), { recursive: true });
        const writer = new DatabaseSync(databasePath);
        writer.exec(
          "PRAGMA journal_mode = WAL; CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES ('committed');",
        );
        const locations: string[] = [];
        const observed: unknown[] = [];
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
                      locations.push(db.location()!);
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
        ]);
        const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        try {
          const previousLocations = new Set<string>();
          for (const value of ["committed", "updated"]) {
            writer.prepare("UPDATE marker SET value = ?").run(value);
            const before = snapshotDoctorLintSqliteFamily(databasePath);
            locations.length = 0;
            observed.length = 0;
            if (entrypoint === "lint") {
              await runDoctorLintCli(runtime, { json: true, includeAllChecks: true });
            } else {
              await collectDoctorFindings(runtime);
            }
            expect(observed).toEqual(Array.from({ length: 3 }, () => [{ value }]));
            const uniqueLocations = new Set(locations);
            expect(uniqueLocations.size).toBe(1);
            for (const location of uniqueLocations) {
              expect(location).not.toBe(databasePath);
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

  it("records cancelled OAuth inspection without using a token or writing source state", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-lint-oauth-"));
    const stateDir = path.join(rootDir, "operator-state");
    const configPath = path.join(stateDir, "openclaw.json");
    const serverUrl = "https://mcp.example.test/rpc";
    const identity = operatorMcpOAuthIdentity("oauth-proof", serverUrl);
    process.env.HOME = stateDir;
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(configPath, "{}\n");
    await seedDoctorLintMcpToken(identity);
    const databasePath = resolveOpenClawStateSqlitePath(process.env);
    await closeOpenClawStateDatabaseByPathAsync(databasePath);
    const lock = new DatabaseSync(databasePath);
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

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
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
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

function selectWorkshopCheckWithUnavailableSource(databasePath: string) {
  const check = workshopCheck;
  if (!check) {
    throw new Error("skill-workshop-relocation contribution is missing");
  }
  mocks.resolveDoctorContributionHealthChecks.mockResolvedValue([
    {
      ...check,
      async detect(ctx: HealthCheckContext) {
        // Lint has already copied state; findings must survive without reopening its source.
        const retainedPath = `${databasePath}.retained`;
        fs.renameSync(databasePath, retainedPath);
        try {
          return await check.detect(ctx);
        } finally {
          fs.renameSync(retainedPath, databasePath);
        }
      },
    },
  ]);
  return check;
}
