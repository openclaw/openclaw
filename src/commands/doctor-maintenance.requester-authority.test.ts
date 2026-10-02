import { spawnSync } from "node:child_process";
import { renameSync } from "node:fs";
import fs from "node:fs/promises";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { ensureCliPluginRegistryLoaded } from "../cli/plugin-registry-loader.js";
import { readConfigFileSnapshot, writeConfigFile } from "../config/config.js";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { SQLITE_READONLY_CHILD_ARG } from "../infra/runtime-process-entrypoints.js";
import { createSqliteReadOnlyWorkerScope } from "../infra/sqlite-readonly-worker.js";
import { withLegacyMigrationStateLock } from "../infra/state-migrations.lock.js";
import * as temporaryState from "../infra/tmp-openclaw-dir.js";
import { readUpdateDatabaseGenerations } from "../infra/update-database-generations.js";
import { captureUpdateDoctorConfigWrites } from "../infra/update-doctor-result.js";
import {
  createManagedUpdateRequesterAuthority,
  UpdateRequesterRevokedError,
} from "../infra/update-requester-authority.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  linkUserChannelIdentity,
  unlinkUserChannelIdentity,
} from "../state/user-channel-identities.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";

vi.mock("../cli/plugin-registry-loader.js", () => ({
  ensureCliPluginRegistryLoaded: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

afterEach(() => vi.restoreAllMocks());
const workers = createSqliteReadOnlyWorkerScope();
afterAll(() => workers.close());

it.each(["configured-owner", "profile"] as const)(
  "keeps %s requester authority live through maintenance and revocation",
  async (source) => {
    await workers.run(() =>
      withOpenClawTestState({ scenario: "external-service" }, async (state) => {
        const control = state.path("control");
        await fs.mkdir(control);
        vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
        const config: OpenClawConfig = {
          plugins: { enabled: false },
          commands: { ownerAllowFrom: source === "configured-owner" ? ["owner"] : [] },
          gateway: {
            mode: "local",
            roles: {
              default: "member",
              definitions: {
                admin: { scopes: ["operator.admin"], agents: "*", sessions: { others: "write" } },
                member: { scopes: ["operator.read"], agents: [], sessions: { others: "none" } },
              },
            },
          },
        };
        await state.writeConfig(config);
        openOpenClawStateDatabase();
        const profile = ensureProfileForEmail("owner@example.test");
        setUserProfileRole(profile.id, "admin");
        const identity = { channelId: "telegram", senderId: "owner", accountId: "default" };
        linkUserChannelIdentity(profile.id, identity);
        await closeOpenClawStateDatabaseAsync();
        const databasePath = resolveOpenClawStateSqlitePath(state.env);
        const files = [databasePath];
        const generation = readUpdateDatabaseGenerations(files);
        const foreignEnv = { ...state.env, OPENCLAW_STATE_DIR: state.path("foreign-state") };
        const foreignDatabase = resolveOpenClawStateSqlitePath(foreignEnv);
        await fs.mkdir(state.path("foreign-state", "state"), { recursive: true });
        await fs.copyFile(databasePath, foreignDatabase);
        const replacement = state.path("replacement.sqlite");
        if (source === "profile") {
          await fs.copyFile(databasePath, replacement);
        }
        vi.mocked(ensureCliPluginRegistryLoaded).mockImplementation(async () => {
          await Promise.resolve();
          readConfigMachineState("plugins.bundledDiscoveryMode", { env: state.env });
        });
        const requester = await createManagedUpdateRequesterAuthority({
          channel: identity.channelId,
          senderId: identity.senderId,
          accountId: identity.accountId,
          authorizationSource: source === "profile" ? `profile:${profile.id}` : source,
        });
        const foreignRequester = await createManagedUpdateRequesterAuthority(
          requester.requester,
          foreignEnv,
        );
        expect(readUpdateDatabaseGenerations(files)).toEqual(generation);
        const authorityWorkerLaunches = new Set<object>();
        const assertCurrent = () => {
          const start = vi.mocked(spawnSync).mock.calls.length;
          try {
            if (!requester.isCurrent()) {
              throw new UpdateRequesterRevokedError();
            }
          } finally {
            for (const call of vi.mocked(spawnSync).mock.calls.slice(start)) {
              const args = call[1];
              if (Array.isArray(args) && args.includes(SQLITE_READONLY_CHILD_ARG)) {
                authorityWorkerLaunches.add(call);
              }
            }
          }
        };
        assertCurrent();
        await closeOpenClawStateDatabaseAsync();
        const maintenance = await beginDoctorMaintenance({
          root: null,
          options: { repair: true, nonInteractive: true },
          runtime: { log() {}, error() {}, exit() {} },
          assertCurrent,
          beforeStateMutation: async () => {
            for (const suffix of ["-wal", "-shm"]) {
              await expect(fs.stat(databasePath + suffix)).rejects.toMatchObject({
                code: "ENOENT",
              });
            }
          },
        });
        expect(maintenance).toBeDefined();
        const admissionWorkerLaunches = authorityWorkerLaunches.size;
        try {
          // The live owner grants storage access only inside its retained closure.
          expect(assertCurrent).toThrow("undergoing offline maintenance");
          await maintenance!.run(async () => {
            expect(foreignRequester.isCurrent()).toBe(true);
            for (const suffix of ["-wal", "-shm"]) {
              await expect(fs.stat(foreignDatabase + suffix)).rejects.toMatchObject({
                code: "ENOENT",
              });
            }
            const migration = await withLegacyMigrationStateLock({
              stateDir: state.stateDir,
              env: state.env,
              label: "requester state",
              releaseLabel: "Requester state",
              run: async () => {
                openOpenClawStateDatabase();
                return { changes: [], warnings: [] };
              },
            });
            expect(migration.warnings).toEqual([]);
            if (source === "configured-owner") {
              const before = await fs.readFile(state.configPath, "utf8");
              await captureUpdateDoctorConfigWrites(
                state.configPath,
                async (capture) => {
                  await writeConfigFile({ ...config, wizard: { lastRunCommand: "doctor" } });
                  expect(capture.hash).not.toBe("unchanged");
                  expect(capture.configWriteRefusal).toBeUndefined();
                },
                { inputHash: hashConfigRaw(before), assertCurrent },
              );
              expect((await readConfigFileSnapshot()).sourceConfig.wizard?.lastRunCommand).toBe(
                "doctor",
              );
              expect(await fs.readFile(`${state.configPath}.bak`, "utf8")).toBe(before);
            } else {
              assertCurrent();
              // Windows itself prevents replacing an open SQLite file.
              if (process.platform !== "win32") {
                const original = state.path("original.sqlite");
                renameSync(databasePath, original);
                try {
                  renameSync(replacement, databasePath);
                  expect(assertCurrent).toThrow("database file identity changed");
                } finally {
                  renameSync(original, databasePath);
                }
              }
              assertCurrent();
            }
            if (source === "profile") {
              unlinkUserChannelIdentity(profile.id, identity);
            } else {
              await state.writeConfig({ ...config, commands: { ownerAllowFrom: ["other"] } });
            }
          });
          const revoked = await fs.readFile(state.configPath, "utf8");
          await expect(
            captureUpdateDoctorConfigWrites(
              state.configPath,
              async () => maintenance!.run(() => writeConfigFile(config)),
              { inputHash: hashConfigRaw(revoked), assertCurrent },
            ),
          ).rejects.toThrow(UpdateRequesterRevokedError);
          expect(await fs.readFile(state.configPath, "utf8")).toBe(revoked);
        } finally {
          await maintenance?.release();
        }
        expect(authorityWorkerLaunches.size).toBe(admissionWorkerLaunches);
        expect(admissionWorkerLaunches).toBeLessThanOrEqual(8);
      }),
    );
  },
);
