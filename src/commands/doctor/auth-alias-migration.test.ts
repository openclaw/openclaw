import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  createApiKeyCredential as apiKey,
  createAuthProfileStoreFixture as authStore,
} from "../../agents/auth-profiles/credential-fixtures.test-support.js";
import { resolveSharedAuthStorePath } from "../../agents/auth-profiles/path-resolve.js";
import {
  loadPersistedAuthProfileStore,
  loadPersistedSharedAuthProfileStore,
} from "../../agents/auth-profiles/persisted.js";
import {
  inspectAuthProfileJsonCell,
  readAuthProfileJsonCellText,
} from "../../agents/auth-profiles/sqlite-json.js";
import {
  closeAuthProfileReadPool,
  readAuthProfileStateJsonTextReadOnly,
  readPersistedAuthProfileStoreRaw,
  readPersistedSharedAuthProfileStateRaw,
  readPersistedSharedAuthProfileStoreRaw,
  runAuthProfileWriteTransaction,
  writePersistedAuthProfileStateRaw,
  writePersistedAuthProfileStoreRaw,
} from "../../agents/auth-profiles/sqlite.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { writeFixtureJsonSync } from "../../cli/cli-fixtures.test-support.js";
import type { AgentRuntimePolicyConfig } from "../../config/types.agents-shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as sqliteSnapshot from "../../infra/sqlite-snapshot.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import {
  collectOpenAICodexAuthProfileStoreIdMap,
  maybeMigrateAuthProfileJsonStoresToSqlite,
  maybeRepairLegacyAuthProfileStores,
  maybeRepairOpenAICodexAuthConfig,
} from "../doctor-auth-flat-profiles.js";
import { runDoctorRepairSequence } from "./repair-sequencing.js";

function withFixture(run: Parameters<typeof withOpenClawTestState>[1]) {
  return withOpenClawTestState({ label: "auth-alias", layout: "home" }, run);
}
function writeStore(env: NodeJS.ProcessEnv, store: unknown, agentDir?: string) {
  runAuthProfileWriteTransaction(
    agentDir,
    (db) => writePersistedAuthProfileStoreRaw(store, agentDir, db),
    { env },
  );
}
function runDoctor(cfg: OpenClawConfig, env: NodeJS.ProcessEnv) {
  return runDoctorRepairSequence({
    state: { cfg, candidate: structuredClone(cfg), pendingChanges: false, fixHints: [] },
    doctorFixCommand: "openclaw doctor --fix",
    env,
  });
}
function withDatabase<T>(file: string, readOnly: boolean, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file, { readOnly });
  try {
    return run(db);
  } finally {
    db.close();
  }
}
function repairAliases(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  profileIdMap = collectOpenAICodexAuthProfileStoreIdMap({ cfg, env }),
) {
  return maybeRepairLegacyAuthProfileStores({ cfg, env, profileIdMap });
}
function legacyKey(provider: string, key: string) {
  return { mode: "api_key", provider, apiKey: key };
}
function exampleCredential<T extends Record<string, unknown>>(type: string, fields: T) {
  return { type, provider: "example", ...fields };
}

describe("Doctor stored auth alias migration", () => {
  it.each(["import", "repair sequence"])(
    "imports canonical JSON and config-selected OAuth sidecars through %s, archiving original bytes",
    async (entrypoint) => {
      await withOpenClawTestState(
        { label: "auth-retired-sidecar", layout: "home", env: { OPENCLAW_OAUTH_DIR: undefined } },
        async (fixture) => {
          const oauthDir = fixture.statePath("custom-credentials");
          const sidecar = path.join(oauthDir, "auth-profiles", `${"b".repeat(32)}.json`);
          const sourcePath = fixture.statePath("agents/main/agent/auth-profiles.json");
          await fixture.writeJson(
            "agents/main/agent/auth-profiles.json",
            authStore({
              "example:default": {
                ...legacyKey("example", "synthetic-key"),
                metadata: { label: "retained", malformed: 123 },
                unknownField: { preserved: "in-archive" },
              },
              "unknown:future": 17,
              "openai-codex:default": {
                type: "oauth",
                provider: "openai-codex",
                expires: 1_900_000_000_000,
                oauthRef: {
                  source: "openclaw-credentials",
                  provider: "openai-codex",
                  id: "b".repeat(32),
                },
              },
            }),
          );
          fs.mkdirSync(path.dirname(sidecar), { recursive: true });
          writeFixtureJsonSync(sidecar, {
            version: 1,
            profileId: "openai-codex:default",
            provider: "openai-codex",
            access: "synthetic-access",
            refresh: "synthetic-refresh",
          });
          const sidecarBytes = fs.readFileSync(sidecar);
          const sourceBytes = fs.readFileSync(sourcePath);
          const cfg = {
            plugins: { enabled: false },
            env: { vars: { OPENCLAW_OAUTH_DIR: oauthDir } },
          };
          const pending =
            entrypoint === "import"
              ? maybeMigrateAuthProfileJsonStoresToSqlite({
                  cfg,
                  env: fixture.env,
                  prompter: { confirmAutoFix: async () => true },
                })
              : runDoctorRepairSequence({
                  state: { cfg, candidate: cfg, pendingChanges: false, fixHints: [] },
                  env: fixture.env,
                  doctorFixCommand: "openclaw doctor --fix",
                });
          await pending;
          const projected = {
            ...apiKey("example", "synthetic-key"),
            metadata: { label: "retained" },
          };
          expect(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toMatchObject({
            profiles: { "example:default": projected },
          });
          const profiles = loadPersistedSharedAuthProfileStore(fixture.env)?.profiles;
          expect(profiles?.["example:default"]).toEqual(projected);
          expect(profiles).not.toHaveProperty("unknown:future");
          expect(profiles).toMatchObject({
            "openai:default": {
              type: "oauth",
              provider: "openai",
              access: "synthetic-access",
              refresh: "synthetic-refresh",
            },
          });
          for (const [source, bytes] of [
            [sourcePath, sourceBytes],
            [sidecar, sidecarBytes],
          ] as const) {
            expect(fs.existsSync(source)).toBe(false);
            const archives = fs
              .readdirSync(path.dirname(source))
              .filter((name) => name.startsWith(`${path.basename(source)}.migrated-`));
            expect(archives).toHaveLength(1);
            expect(fs.readFileSync(path.join(path.dirname(source), archives[0]!))).toEqual(bytes);
          }
          expect(fixture.env.OPENCLAW_OAUTH_DIR).toBeUndefined();
        },
      );
    },
  );

  it("does not migrate a replacement database with identical auth rows after backup", async () => {
    await withFixture(async (fixture) => {
      const original = authStore({
        "example:work": legacyKey("example", "synthetic-key"),
      });
      writeStore(fixture.env, original);
      const databasePath = resolveSharedAuthStorePath(fixture.env);
      const snapshot = sqliteSnapshot.createVerifiedSqliteSnapshot;
      const replacedDuringBackup = vi
        .spyOn(sqliteSnapshot, "createVerifiedSqliteSnapshot")
        .mockImplementationOnce(async (options) => {
          const backup = await snapshot(options);
          await cleanupSessionStateForTest({ stateDir: fixture.stateDir });
          closeAuthProfileReadPool({ kind: "root", rootPath: fixture.stateDir });
          fs.renameSync(databasePath, `${databasePath}.original-generation`);
          fs.copyFileSync(backup.path, databasePath);
          withDatabase(databasePath, false, (replacement) => {
            replacement
              .prepare(
                "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
              )
              .run("synthetic.replacement", '"new-generation"', 1234);
          });
          return backup;
        });
      try {
        await expect(
          maybeRepairLegacyAuthProfileStores({
            cfg: { plugins: { enabled: false } },
            env: fixture.env,
            profileIdMap: new Map(),
          }),
        ).rejects.toThrow("database file identity changed");
      } finally {
        replacedDuringBackup.mockRestore();
      }
      withDatabase(databasePath, true, (replacement) => {
        expect(inspectAuthProfileJsonCell(replacement, "store", "shared-state")).toEqual({
          status: "readable",
          raw: original,
        });
        expect(
          replacement
            .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
            .get("synthetic.replacement"),
        ).toEqual({ value_json: '"new-generation"' });
      });
    });
  });

  it.each([false, true])(
    "backs up and canonicalizes credential fields without renaming profile IDs (unreadable state: %s)",
    async (unreadableState) => {
      await withFixture(async (fixture) => {
        const cfg: OpenClawConfig = {
          plugins: { enabled: false },
          secrets: { defaults: { env: "configured-env" } },
        };
        const ref = { source: "env", provider: "default", id: "SYNTHETIC_AUTH_KEY" };
        const key = (fields: Record<string, unknown>) => exampleCredential("api_key", fields);
        const token = (fields: Record<string, unknown>) => exampleCredential("token", fields);
        const badOAuth = {
          access: 17,
          refresh: { unrecognized: "synthetic" },
          expires: "unknown",
        };
        const cases: Array<[string, Record<string, unknown>, Record<string, unknown>?]> = [
          [
            "malformed-oauth",
            { provider: "example", mode: "oauth", ...badOAuth },
            exampleCredential("oauth", badOAuth),
          ],
          [
            "token-extras",
            token({ token: "synthetic-token", mode: "oauth", apiKey: "extension", key: ref }),
          ],
          ["malformed", key({ key: "synthetic-canonical", apiKey: 123, mode: "unknown" })],
          ["malformed-only", key({ apiKey: 123, mode: "unknown" })],
          ["unknown", exampleCredential("unsupported", { mode: "future", apiKey: "retained" })],
          ["mode", legacyKey("example", "mode-key"), key({ key: "mode-key" })],
          ["type", exampleCredential("apiKey", { apiKey: "type-key" }), key({ key: "type-key" })],
          ["ref", key({ key: ref }), key({ keyRef: ref })],
          [
            "providerless-key",
            key({
              keyRef: { source: "env", id: "SYNTHETIC_AUTH_KEY", opaque: "backup" },
              extension: "preserved",
            }),
            key({ keyRef: ref, extension: "preserved" }),
          ],
          [
            "providerless-token",
            token({
              tokenRef: { source: "env", id: "SYNTHETIC_AUTH_KEY", opaque: { note: "backup" } },
            }),
            token({ tokenRef: ref }),
          ],
          ["api-ref", key({ key: null, apiKey: ref }), key({ keyRef: ref })],
          ["empty", key({ key: "", apiKey: "fallback" }), key({ key: "fallback" })],
          [
            "token",
            token({ token: ref, expires: 1900000000000 }),
            token({ tokenRef: ref, expires: 1900000000000 }),
          ],
          ["alias", key({ api_key: "underscore-key" }), key({ key: "underscore-key" })],
        ];
        const makeStore = (normalized: boolean) =>
          authStore(
            Object.fromEntries(
              cases.map(([id, before, after]) => [
                `example:${id}`,
                normalized ? (after ?? before) : before,
              ]),
            ),
          );
        const original = makeStore(false);
        const expected = makeStore(true);
        const state = {
          order: { example: ["example:mode", "example:ref"] },
          usageStats: { "example:mode": { lastUsed: 1234, errorCount: 2 } },
        };
        runAuthProfileWriteTransaction(
          undefined,
          (database) => {
            writePersistedAuthProfileStoreRaw(original, undefined, database);
            writePersistedAuthProfileStateRaw(state, undefined, database);
            if (unreadableState) {
              database.db
                .prepare("UPDATE config_machine_state SET value_json = ? WHERE state_key = ?")
                .run("{invalid-rotation-state", "authProfiles.state");
            }
          },
          { env: fixture.env },
        );
        const databasePath = resolveSharedAuthStorePath(fixture.env);
        const run = () => runDoctor(cfg, fixture.env);
        const repaired = await run();
        const notes = repaired.changeNotes.join("\n");
        expect(notes).toContain("Canonicalized 2 auth SecretRef(s) in ");
        expect(notes).toContain(
          "to source/provider/id; unsupported fields are preserved in the verified migration backup.",
        );
        expect(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toEqual(expected);
        expect(readPersistedSharedAuthProfileStateRaw(fixture.env)).toEqual(
          unreadableState ? null : state,
        );
        if (unreadableState) {
          expect(
            readAuthProfileStateJsonTextReadOnly({
              path: databasePath,
              kind: "shared-state",
              env: fixture.env,
            }),
          ).toBe("{invalid-rotation-state");
        }
        const profiles = loadPersistedSharedAuthProfileStore(fixture.env)?.profiles;
        expect(profiles?.["example:mode"]).toEqual(expected.profiles?.["example:mode"]);
        expect(profiles).not.toHaveProperty("example:unknown");
        expect(profiles?.["example:malformed"]).toEqual(apiKey("example", "synthetic-canonical"));
        expect(profiles?.["example:malformed-only"]).toEqual(exampleCredential("api_key", {}));
        expect(profiles?.["example:malformed-oauth"]).toEqual(
          exampleCredential("oauth", { expires: 0 }),
        );
        expect(profiles?.["example:token-extras"]).toEqual(
          exampleCredential("token", { token: "synthetic-token" }),
        );
        const backups = () =>
          fs
            .readdirSync(path.dirname(databasePath))
            .filter((name) =>
              name.startsWith(`${path.basename(databasePath)}.auth-profile-migration-`),
            );
        const names = backups();
        expect(names).toHaveLength(1);
        const backupPath = path.join(path.dirname(databasePath), names[0]!);
        expect(fs.statSync(backupPath).mode & 0o777).toBe(0o600);
        withDatabase(backupPath, true, (backup) => {
          expect(inspectAuthProfileJsonCell(backup, "store", "shared-state")).toEqual({
            status: "readable",
            raw: original,
          });
          if (unreadableState) {
            expect(readAuthProfileJsonCellText(backup, "state", "shared-state")).toBe(
              "{invalid-rotation-state",
            );
          } else {
            expect(inspectAuthProfileJsonCell(backup, "state", "shared-state")).toEqual({
              status: "readable",
              raw: state,
            });
          }
        });
        await run();
        expect(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toEqual(expected);
        expect(backups()).toEqual(names);
      });
    },
  );

  it.each([
    ["claude-cli:work", "claude-cli", "anthropic:work", "anthropic", "shared"],
    ["google-gemini-cli:work", "google-gemini-cli", "google:work", "google", "agent"],
    ["codex:work", "codex", "openai:work", "openai", "shared"],
    ["codex-cli:work", "codex-cli", "openai:work", "openai", "agent"],
    ["openai:codex-cli", "openai", "openai:default", "openai", "shared"],
    ["work-account", "claude-cli", "work-account", "anthropic", "agent"],
  ])(
    "migrates %s without changing credential material",
    async (legacyId, legacyProvider, canonicalId, canonicalProvider, owner) => {
      await withFixture(async (fixture) => {
        const agentDir = owner === "shared" ? undefined : fixture.agentDir("worker");
        const cfg: OpenClawConfig = {
          plugins: { enabled: false },
          auth: {
            profiles: { [legacyId]: { provider: legacyProvider, mode: "api_key" } },
            order: { [legacyProvider]: [legacyId] },
          },
        };
        const original: AuthProfileStore = {
          version: 1,
          profiles: { [legacyId]: apiKey(legacyProvider, legacyId) },
          order: { [legacyProvider]: [legacyId] },
          lastGood: { [legacyProvider]: legacyId },
          usageStats: { [legacyId]: { errorCount: 4, lastUsed: 4321 } },
        };
        writeStore(fixture.env, original, agentDir);

        const result = await repairAliases(cfg, fixture.env);
        const config = maybeRepairOpenAICodexAuthConfig(cfg, {
          profileIdMap: result.profileIdMap,
        }).config;
        expect(result.warnings).toEqual([]);
        expect(config.auth?.profiles).toEqual({
          [canonicalId]: { provider: canonicalProvider, mode: "api_key" },
        });
        expect(config.auth?.order).toEqual({ [canonicalProvider]: [canonicalId] });
        await cleanupSessionStateForTest({ stateDir: fixture.stateDir });
        closeAuthProfileReadPool({ kind: "root", rootPath: fixture.stateDir });
        const reopened = agentDir
          ? loadPersistedAuthProfileStore(agentDir)
          : loadPersistedSharedAuthProfileStore(fixture.env);
        expect(reopened?.profiles).toEqual({
          [canonicalId]: apiKey(canonicalProvider, legacyId),
        });
        expect(reopened?.order).toEqual({ [canonicalProvider]: [canonicalId] });
        expect(reopened?.lastGood).toEqual({ [canonicalProvider]: canonicalId });
        expect(reopened?.usageStats).toEqual({ [canonicalId]: { errorCount: 4, lastUsed: 4321 } });
        expect((await repairAliases(config, fixture.env)).changes).toEqual([]);
      });
    },
  );

  it("keeps unreadable shared state and config references unchanged", async () => {
    await withFixture(async (fixture) => {
      const cfg: OpenClawConfig = {
        plugins: { enabled: false },
        auth: {
          profiles: { "openai-codex:work": { provider: "openai-codex", mode: "api_key" } },
          order: { "openai-codex": ["openai-codex:work"], openai: [] },
        },
      };
      writeStore(fixture.env, "unreadable-store-shape");
      const result = await runDoctor(cfg, fixture.env);
      expect(result.state.candidate.auth).toEqual(cfg.auth);
      expect(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toBe("unreadable-store-shape");
      expect(result.warningNotes.join("\n")).toContain("unreadable or invalid");
    });
  });

  it("keeps an invalid agent store while an independent shared profile migrates", async () => {
    await withFixture(async (fixture) => {
      const cfg: OpenClawConfig = { plugins: { enabled: false } };
      const invalid = authStore({ "google-gemini-cli:broken": 17 });
      writeStore(
        fixture.env,
        authStore({
          "claude-cli:work": apiKey("claude-cli", "retained-key"),
        }),
      );
      writeStore(fixture.env, invalid, fixture.agentDir("broken"));
      const result = await repairAliases(cfg, fixture.env);
      expect(readPersistedAuthProfileStoreRaw(fixture.agentDir("broken"))).toEqual(invalid);
      expect(loadPersistedSharedAuthProfileStore(fixture.env)?.profiles).toEqual({
        "anthropic:work": apiKey("anthropic", "retained-key"),
      });
      expect(result.warnings.join("\n")).toContain("unreadable or invalid");
    });
  });

  it.each([
    { providerConfig: true, issuer: false },
    { providerConfig: false, issuer: true },
  ])(
    "preserves explicit credential realms ($providerConfig/$issuer)",
    async ({ providerConfig, issuer }) => {
      await withFixture(async (fixture) => {
        const cfg: OpenClawConfig = {
          plugins: { enabled: false },
          ...(providerConfig
            ? {
                models: {
                  providers: {
                    "openai-codex": { baseUrl: "https://fixture.invalid/v1", models: [] },
                  },
                },
              }
            : {}),
        };
        const original = authStore({
          "openai-codex:work": {
            type: "oauth",
            provider: "openai-codex",
            access: "retained-access",
            refresh: "retained-refresh",
            accountId: "retained-account",
            expires: 4_000_000_000_000,
            ...(issuer ? { issuer: "https://fixture.invalid/issuer" } : {}),
          },
        });
        writeStore(fixture.env, original);
        const result = await repairAliases(cfg, fixture.env);
        expect(result.changes).toEqual([]);
        expect(result.warnings.join("\n")).toContain("realm or identity is unresolved");
        expect(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toEqual(original);
      });
    },
  );

  it.each(["credentials", "rotation state"])(
    "rejects a stale map before replacing newer %s",
    async (occupied) => {
      await withFixture(async (fixture) => {
        const cfg: OpenClawConfig = { plugins: { enabled: false } };
        const original = authStore({
          "openai-codex:work": apiKey("openai-codex", "old-key"),
        });
        writeStore(fixture.env, original);
        const profileIdMap = collectOpenAICodexAuthProfileStoreIdMap({ cfg, env: fixture.env });
        const current =
          occupied === "credentials"
            ? {
                ...original,
                profiles: {
                  ...original.profiles,
                  "openai:work": apiKey("openai", "new-account-key"),
                },
              }
            : original;
        const currentState = {
          version: 1,
          usageStats: { "openai-codex:work": { errorCount: 2 }, "openai:work": { errorCount: 99 } },
        };
        runAuthProfileWriteTransaction(
          undefined,
          (database) => {
            if (occupied === "credentials") {
              writePersistedAuthProfileStoreRaw(current, undefined, database);
            } else {
              writePersistedAuthProfileStateRaw(currentState, undefined, database);
            }
          },
          { env: fixture.env },
        );
        const result = await repairAliases(cfg, fixture.env, profileIdMap);
        expect.soft(result.changes).toEqual([]);
        expect.soft(result.profileIdMap.size).toBe(0);
        expect.soft(result.warnings.join("\n")).toContain("target is occupied");
        expect.soft(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toEqual(current);
        if (occupied === "rotation state") {
          expect.soft(readPersistedSharedAuthProfileStateRaw(fixture.env)).toEqual(currentState);
        }
      });
    },
  );

  it("refuses alias planning when an agent location is not a directory", async () => {
    await withFixture(async (fixture) => {
      const cfg: OpenClawConfig = { plugins: { enabled: false } };
      writeStore(
        fixture.env,
        authStore({
          "claude-cli:work": apiKey("claude-cli", "retained-key"),
        }),
      );
      await fixture.writeText("agents/unavailable/agent", "not an agent directory");
      const profileIdMap = collectOpenAICodexAuthProfileStoreIdMap({ cfg, env: fixture.env });
      expect(profileIdMap.size).toBe(0);
    });
  });

  it("migrates stored aliases without replacing credentials or widening an empty order", async () => {
    await withFixture(async (fixture) => {
      const legacyCredential = {
        type: "oauth" as const,
        provider: "openai-codex",
        access: "synthetic-legacy-access",
        refresh: "synthetic-legacy-refresh",
        expires: 4_000_000_000_000,
        accountId: "legacy-work-account",
        email: "legacy-work@example.invalid",
        displayName: "Retained work account",
      };
      const canonicalCredential = {
        ...apiKey("openai", "synthetic-canonical-key"),
        metadata: { accountId: "canonical-account" },
      };
      const agentCredential = {
        ...apiKey("openai", "synthetic-agent-key"),
        metadata: { accountId: "agent-account" },
      };
      const shared: AuthProfileStore = {
        version: 1,
        profiles: {
          "openai-codex:work": legacyCredential,
          "openai:work": canonicalCredential,
        },
        lastGood: { "openai-codex": "openai-codex:work" },
        usageStats: { "openai-codex:work": { lastUsed: 1234, errorCount: 2 } },
      };
      const agent: AuthProfileStore = authStore({
        "openai:chatgpt-work": agentCredential,
      });
      // Keep the retired field explicit in this migration fixture.
      const legacyRuntime: AgentRuntimePolicyConfig & { authProfileId: string } = {
        authProfileId: "openai-codex:work",
      };
      const cfg: OpenClawConfig = {
        plugins: { enabled: false },
        agents: {
          defaults: {
            workspace: fixture.workspaceDir,
            models: {
              "openai/fixture-model": {
                agentRuntime: legacyRuntime,
              },
            },
          },
          entries: { main: {}, worker: { agentDir: fixture.agentDir("worker") } },
        },
        auth: {
          profiles: {
            "openai-codex:work": {
              provider: "openai-codex",
              mode: "oauth",
              email: "legacy-work@example.invalid",
            },
            "openai:work": { provider: "openai", mode: "api_key" },
          },
          order: { "openai-codex": ["openai-codex:work"], openai: [] },
        },
      };
      await fixture.writeConfig(cfg);
      runAuthProfileWriteTransaction(
        undefined,
        (database) => {
          writePersistedAuthProfileStoreRaw(shared, undefined, database);
          writePersistedAuthProfileStateRaw(
            {
              version: 1,
              order: { "openai-codex": ["openai-codex:work"] },
              lastGood: { "openai-codex": "openai-codex:work" },
              usageStats: { "openai-codex:work": { lastUsed: 5678, errorCount: 3 } },
            },
            undefined,
            database,
          );
        },
        { env: fixture.env },
      );
      writeStore(fixture.env, agent, fixture.agentDir("worker"));

      const result = await runDoctor(cfg, fixture.env);

      const migratedConfig = result.state.candidate;
      const migratedRuntime =
        migratedConfig.agents?.defaults?.models?.["openai/fixture-model"]?.agentRuntime;
      const migratedId =
        migratedRuntime && "authProfileId" in migratedRuntime
          ? migratedRuntime.authProfileId
          : undefined;
      expect(migratedId).toBeDefined();
      if (typeof migratedId !== "string") {
        throw new Error("Doctor removed the configured account reference");
      }
      expect.soft(migratedId).not.toBe("openai-codex:work");
      expect.soft(migratedId).not.toBe("openai:work");
      expect.soft(migratedId).not.toBe("openai:chatgpt-work");
      expect.soft(migratedConfig.auth?.profiles?.[migratedId]).toMatchObject({
        provider: "openai",
        mode: "oauth",
        email: "legacy-work@example.invalid",
      });
      expect.soft(migratedConfig.auth?.order?.openai).toEqual([]);

      await cleanupSessionStateForTest({ stateDir: fixture.stateDir });
      closeAuthProfileReadPool({ kind: "root", rootPath: fixture.stateDir });
      const reopened = loadPersistedSharedAuthProfileStore(fixture.env);
      expect.soft(reopened?.profiles[migratedId]).toEqual({
        ...legacyCredential,
        provider: "openai",
      });
      expect.soft(reopened?.profiles["openai-codex:work"]).toBeUndefined();
      expect.soft(reopened?.profiles["openai:work"]).toEqual(canonicalCredential);
      expect
        .soft(loadPersistedAuthProfileStore(fixture.agentDir("worker"))?.profiles)
        .toEqual(agent.profiles);
      expect.soft(readPersistedSharedAuthProfileStateRaw(fixture.env)).toEqual({
        version: 1,
        order: { openai: [migratedId] },
        lastGood: { openai: migratedId },
        usageStats: { [migratedId]: { lastUsed: 5678, errorCount: 3 } },
      });
      expect.soft(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toMatchObject({
        lastGood: { openai: migratedId },
        usageStats: { [migratedId]: { lastUsed: 1234, errorCount: 2 } },
      });
    });
  });
});
