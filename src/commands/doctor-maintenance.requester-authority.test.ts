import fs from "node:fs/promises";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { ensureCliPluginRegistryLoaded } from "../cli/plugin-registry-loader.js";
import { readConfigFileSnapshot, writeConfigFile } from "../config/config.js";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";

vi.mock("../cli/plugin-registry-loader.js", () => ({
  ensureCliPluginRegistryLoaded: vi.fn(),
}));

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
        const files = [resolveOpenClawStateSqlitePath(state.env)];
        const generation = readUpdateDatabaseGenerations(files);
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
        expect(readUpdateDatabaseGenerations(files)).toEqual(generation);
        const assertCurrent = () => {
          if (!requester.isCurrent()) {
            throw new UpdateRequesterRevokedError();
          }
        };
        assertCurrent();
        await closeOpenClawStateDatabaseAsync();
        const maintenance = await beginDoctorMaintenance({
          root: null,
          options: { repair: true, nonInteractive: true },
          runtime: { log() {}, error() {}, exit() {} },
          assertCurrent,
        });
        expect(maintenance).toBeDefined();
        try {
          // The live owner grants storage access only inside its retained closure.
          expect(assertCurrent).toThrow("undergoing offline maintenance");
          await maintenance!.run(async () => {
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
      }),
    );
  },
);
