import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
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

function writeStore(env: NodeJS.ProcessEnv, store: unknown, agentDir?: string) {
  runAuthProfileWriteTransaction(
    agentDir,
    (database) => {
      writePersistedAuthProfileStoreRaw(store, agentDir, database);
    },
    { env },
  );
}

describe("Doctor stored auth alias migration", () => {
  it.each(["import", "repair sequence"])(
    "refuses config-selected retired sidecars before direct %s mutates auth",
    async (entrypoint) => {
      await withOpenClawTestState(
        { label: "auth-retired-sidecar", layout: "home", env: { OPENCLAW_OAUTH_DIR: undefined } },
        async (fixture) => {
          const oauthDir = fixture.statePath("custom-credentials");
          const sidecar = path.join(oauthDir, "auth-profiles", `${"b".repeat(32)}.json`);
          const sourcePath = fixture.statePath("agents/main/agent/auth-profiles.json");
          await fixture.writeJson("agents/main/agent/auth-profiles.json", {
            version: 1,
            profiles: {
              "example:default": { mode: "api_key", provider: "example", apiKey: "synthetic-key" },
            },
          });
          fs.mkdirSync(path.dirname(sidecar), { recursive: true });
          fs.writeFileSync(sidecar, "unparsed historical bytes");
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
          await expect(pending).rejects.toThrow("Upgrade through OpenClaw 2026.9.7");
          expect(fs.readFileSync(sourcePath)).toEqual(sourceBytes);
          expect(fs.readFileSync(sidecar, "utf8")).toBe("unparsed historical bytes");
          expect(fs.readdirSync(path.dirname(sourcePath))).toEqual(["auth-profiles.json"]);
          expect(fixture.env.OPENCLAW_OAUTH_DIR).toBeUndefined();
        },
      );
    },
  );

  it("keeps canonical JSON import projection and archives the exact original fields", async () => {
    await withOpenClawTestState(
      { label: "auth-json-projection", layout: "home" },
      async (fixture) => {
        await fixture.writeJson("agents/main/agent/auth-profiles.json", {
          version: 1,
          profiles: {
            "example:json": {
              mode: "api_key",
              provider: "example",
              apiKey: "synthetic-json-key",
              metadata: { label: "retained", malformed: 123 },
              unknownField: { preserved: "in-archive" },
            },
            "unknown:future": 17,
          },
        });
        const agentDir = fixture.agentDir("main");
        const sourcePath = path.join(agentDir, "auth-profiles.json");
        const original = fs.readFileSync(sourcePath);
        await maybeMigrateAuthProfileJsonStoresToSqlite({
          cfg: { plugins: { enabled: false } },
          env: fixture.env,
          prompter: { confirmAutoFix: async () => true },
        });
        expect(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toMatchObject({
          profiles: {
            "example:json": {
              type: "api_key",
              provider: "example",
              key: "synthetic-json-key",
              metadata: { label: "retained" },
            },
          },
        });
        expect(loadPersistedSharedAuthProfileStore(fixture.env)?.profiles).toEqual({
          "example:json": {
            type: "api_key",
            provider: "example",
            key: "synthetic-json-key",
            metadata: { label: "retained" },
          },
        });
        const archives = fs
          .readdirSync(agentDir)
          .filter((name) => name.startsWith("auth-profiles.json.migrated-"));
        expect(archives).toHaveLength(1);
        expect(fs.readFileSync(path.join(agentDir, archives[0]!))).toEqual(original);
        expect(fs.existsSync(sourcePath)).toBe(false);
      },
    );
  });

  it("does not migrate a replacement database with identical auth rows after backup", async () => {
    await withOpenClawTestState(
      { label: "auth-backup-generation", layout: "home" },
      async (fixture) => {
        const original = {
          version: 1,
          profiles: {
            "example:work": { mode: "api_key", provider: "example", apiKey: "synthetic-key" },
          },
        };
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
            const replacement = new DatabaseSync(databasePath);
            try {
              replacement
                .prepare(
                  "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
                )
                .run("synthetic.replacement", '"new-generation"', 1234);
            } finally {
              replacement.close();
            }
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
        const replacement = new DatabaseSync(databasePath, { readOnly: true });
        try {
          expect(inspectAuthProfileJsonCell(replacement, "store", "shared-state")).toEqual({
            status: "readable",
            raw: original,
          });
          expect(
            replacement
              .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
              .get("synthetic.replacement"),
          ).toEqual({ value_json: '"new-generation"' });
        } finally {
          replacement.close();
        }
      },
    );
  });

  it.each([false, true])(
    "backs up and canonicalizes credential fields without renaming profile IDs (unreadable state: %s)",
    async (unreadableState) => {
      await withOpenClawTestState(
        { label: "auth-credential-fields", layout: "home" },
        async (fixture) => {
          const cfg: OpenClawConfig = { plugins: { enabled: false } };
          const ref = { source: "env", provider: "default", id: "SYNTHETIC_AUTH_KEY" };
          const original = {
            version: 1,
            profiles: {
              "example:malformed-oauth": {
                mode: "oauth",
                provider: "example",
                access: 17,
                refresh: { unrecognized: "synthetic" },
                expires: "unknown",
              },
              "example:token-extras": {
                type: "token",
                provider: "example",
                token: "synthetic-token",
                mode: "oauth",
                apiKey: "synthetic-extension",
                key: ref,
              },
              "example:malformed": {
                type: "api_key",
                provider: "example",
                key: "synthetic-canonical",
                apiKey: 123,
                mode: "unknown",
              },
              "example:malformed-only": {
                type: "api_key",
                provider: "example",
                apiKey: 123,
                mode: "unknown",
              },
              "example:unknown": {
                type: "unsupported",
                provider: "example",
                mode: "future",
                apiKey: "synthetic-retained",
              },
              "example:mode": {
                mode: "api_key",
                provider: "example",
                apiKey: "synthetic-api-key",
                email: "owner@example.test",
              },
              "example:type": { type: "apiKey", provider: "example", apiKey: "synthetic-type-key" },
              "example:ref": { type: "api_key", provider: "example", key: ref },
              "example:api-ref": { type: "api_key", provider: "example", key: null, apiKey: ref },
              "example:empty": {
                type: "api_key",
                provider: "example",
                key: "",
                apiKey: "synthetic-fallback",
              },
              "example:token": {
                type: "token",
                provider: "example",
                token: ref,
                expires: 1900000000000,
              },
              "example:alias": {
                type: "api_key",
                provider: "example",
                api_key: "synthetic-underscore-key",
              },
            },
          };
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
          const run = () =>
            runDoctorRepairSequence({
              state: { cfg, candidate: structuredClone(cfg), pendingChanges: false, fixHints: [] },
              doctorFixCommand: "openclaw doctor --fix",
              env: fixture.env,
            });
          await run();
          const expected = {
            version: 1,
            profiles: {
              "example:malformed-oauth": {
                type: "oauth",
                provider: "example",
                access: 17,
                refresh: { unrecognized: "synthetic" },
                expires: "unknown",
              },
              "example:token-extras": {
                type: "token",
                provider: "example",
                token: "synthetic-token",
                mode: "oauth",
                apiKey: "synthetic-extension",
                key: ref,
              },
              "example:malformed": {
                type: "api_key",
                provider: "example",
                key: "synthetic-canonical",
                apiKey: 123,
                mode: "unknown",
              },
              "example:malformed-only": {
                type: "api_key",
                provider: "example",
                apiKey: 123,
                mode: "unknown",
              },
              "example:unknown": {
                type: "unsupported",
                provider: "example",
                mode: "future",
                apiKey: "synthetic-retained",
              },
              "example:mode": {
                type: "api_key",
                provider: "example",
                key: "synthetic-api-key",
                email: "owner@example.test",
              },
              "example:type": { type: "api_key", provider: "example", key: "synthetic-type-key" },
              "example:ref": { type: "api_key", provider: "example", keyRef: ref },
              "example:api-ref": { type: "api_key", provider: "example", keyRef: ref },
              "example:empty": { type: "api_key", provider: "example", key: "synthetic-fallback" },
              "example:token": {
                type: "token",
                provider: "example",
                tokenRef: ref,
                expires: 1900000000000,
              },
              "example:alias": {
                type: "api_key",
                provider: "example",
                key: "synthetic-underscore-key",
              },
            },
          };
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
          const runtimeStore = loadPersistedSharedAuthProfileStore(fixture.env);
          expect(runtimeStore?.profiles["example:mode"]).toEqual(expected.profiles["example:mode"]);
          expect(runtimeStore?.profiles).not.toHaveProperty("example:unknown");
          expect(runtimeStore?.profiles["example:malformed"]).toEqual({
            type: "api_key",
            provider: "example",
            key: "synthetic-canonical",
          });
          expect(runtimeStore?.profiles["example:malformed-only"]).toEqual({
            type: "api_key",
            provider: "example",
          });
          expect(runtimeStore?.profiles["example:malformed-oauth"]).toEqual({
            type: "oauth",
            provider: "example",
            expires: 0,
          });
          expect(runtimeStore?.profiles["example:token-extras"]).toEqual({
            type: "token",
            provider: "example",
            token: "synthetic-token",
          });
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
          const backup = new DatabaseSync(backupPath, { readOnly: true });
          try {
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
          } finally {
            backup.close();
          }
          await run();
          expect(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toEqual(expected);
          expect(backups()).toEqual(names);
        },
      );
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
      await withOpenClawTestState({ label: "alias-family", layout: "home" }, async (fixture) => {
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
          profiles: { [legacyId]: { type: "api_key", provider: legacyProvider, key: legacyId } },
          order: { [legacyProvider]: [legacyId] },
          lastGood: { [legacyProvider]: legacyId },
          usageStats: { [legacyId]: { errorCount: 4, lastUsed: 4321 } },
        };
        writeStore(fixture.env, original, agentDir);

        const profileIdMap = collectOpenAICodexAuthProfileStoreIdMap({ cfg, env: fixture.env });
        const result = await maybeRepairLegacyAuthProfileStores({
          cfg,
          env: fixture.env,
          profileIdMap,
        });
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
          [canonicalId]: { type: "api_key", provider: canonicalProvider, key: legacyId },
        });
        expect(reopened?.order).toEqual({ [canonicalProvider]: [canonicalId] });
        expect(reopened?.lastGood).toEqual({ [canonicalProvider]: canonicalId });
        expect(reopened?.usageStats).toEqual({ [canonicalId]: { errorCount: 4, lastUsed: 4321 } });
        const repeatMap = collectOpenAICodexAuthProfileStoreIdMap({
          cfg: config,
          env: fixture.env,
        });
        expect(
          (
            await maybeRepairLegacyAuthProfileStores({
              cfg: config,
              env: fixture.env,
              profileIdMap: repeatMap,
            })
          ).changes,
        ).toEqual([]);
      });
    },
  );

  it("keeps unreadable shared state and config references unchanged", async () => {
    await withOpenClawTestState({ label: "alias-unreadable", layout: "home" }, async (fixture) => {
      const cfg: OpenClawConfig = {
        plugins: { enabled: false },
        auth: {
          profiles: { "openai-codex:work": { provider: "openai-codex", mode: "api_key" } },
          order: { "openai-codex": ["openai-codex:work"], openai: [] },
        },
      };
      writeStore(fixture.env, "unreadable-store-shape");
      const result = await runDoctorRepairSequence({
        state: { cfg, candidate: structuredClone(cfg), pendingChanges: false, fixHints: [] },
        doctorFixCommand: "openclaw doctor --fix",
        env: fixture.env,
      });
      expect(result.state.candidate.auth).toEqual(cfg.auth);
      expect(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toBe("unreadable-store-shape");
      expect(result.warningNotes.join("\n")).toContain("unreadable or invalid");
    });
  });

  it("imports a flat legacy source directly into the canonical profile", async () => {
    await withOpenClawTestState({ label: "alias-flat-import", layout: "home" }, async (fixture) => {
      const cfg: OpenClawConfig = {
        plugins: { enabled: false },
        auth: { profiles: { "claude-cli:default": { provider: "claude-cli", mode: "api_key" } } },
      };
      await fixture.writeJson("agents/main/agent/auth.json", {
        "claude-cli": { type: "api_key", provider: "claude-cli", key: "retained-flat-key" },
      });
      const result = await runDoctorRepairSequence({
        state: { cfg, candidate: structuredClone(cfg), pendingChanges: false, fixHints: [] },
        doctorFixCommand: "openclaw doctor --fix",
        env: fixture.env,
      });
      expect(result.state.candidate.auth?.profiles).toEqual({
        "anthropic:default": { provider: "anthropic", mode: "api_key" },
      });
      expect(loadPersistedSharedAuthProfileStore(fixture.env)?.profiles).toEqual({
        "anthropic:default": { type: "api_key", provider: "anthropic", key: "retained-flat-key" },
      });
    });
  });

  it("keeps an invalid agent store while an independent shared profile migrates", async () => {
    await withOpenClawTestState({ label: "alias-partial", layout: "home" }, async (fixture) => {
      const cfg: OpenClawConfig = { plugins: { enabled: false } };
      const invalid = { version: 1, profiles: { "google-gemini-cli:broken": 17 } };
      runAuthProfileWriteTransaction(
        undefined,
        (database) => {
          writePersistedAuthProfileStoreRaw(
            {
              version: 1,
              profiles: {
                "claude-cli:work": { type: "api_key", provider: "claude-cli", key: "retained-key" },
              },
            },
            undefined,
            database,
          );
        },
        { env: fixture.env },
      );
      writeStore(fixture.env, invalid, fixture.agentDir("broken"));
      const profileIdMap = collectOpenAICodexAuthProfileStoreIdMap({ cfg, env: fixture.env });
      const result = await maybeRepairLegacyAuthProfileStores({
        cfg,
        env: fixture.env,
        profileIdMap,
      });
      expect(readPersistedAuthProfileStoreRaw(fixture.agentDir("broken"))).toEqual(invalid);
      expect(loadPersistedSharedAuthProfileStore(fixture.env)?.profiles).toEqual({
        "anthropic:work": { type: "api_key", provider: "anthropic", key: "retained-key" },
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
      await withOpenClawTestState({ label: "alias-realm", layout: "home" }, async (fixture) => {
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
        const original = {
          version: 1,
          profiles: {
            "openai-codex:work": {
              type: "oauth",
              provider: "openai-codex",
              access: "retained-access",
              refresh: "retained-refresh",
              accountId: "retained-account",
              expires: 4_000_000_000_000,
              ...(issuer ? { issuer: "https://fixture.invalid/issuer" } : {}),
            },
          },
        };
        writeStore(fixture.env, original);
        const profileIdMap = collectOpenAICodexAuthProfileStoreIdMap({ cfg, env: fixture.env });
        const result = await maybeRepairLegacyAuthProfileStores({
          cfg,
          env: fixture.env,
          profileIdMap,
        });
        expect(result.changes).toEqual([]);
        expect(result.warnings.join("\n")).toContain("realm or identity is unresolved");
        expect(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toEqual(original);
      });
    },
  );

  it.each(["credentials", "rotation state"])(
    "rejects a stale map before replacing newer %s",
    async (occupied) => {
      await withOpenClawTestState({ label: "alias-stale-map", layout: "home" }, async (fixture) => {
        const cfg: OpenClawConfig = { plugins: { enabled: false } };
        const original = {
          version: 1,
          profiles: {
            "openai-codex:work": { type: "api_key", provider: "openai-codex", key: "old-key" },
          },
        };
        writeStore(fixture.env, original);
        const profileIdMap = collectOpenAICodexAuthProfileStoreIdMap({ cfg, env: fixture.env });
        const current =
          occupied === "credentials"
            ? {
                ...original,
                profiles: {
                  ...original.profiles,
                  "openai:work": { type: "api_key", provider: "openai", key: "new-account-key" },
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
        const result = await maybeRepairLegacyAuthProfileStores({
          cfg,
          env: fixture.env,
          profileIdMap,
        });
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
    await withOpenClawTestState({ label: "alias-census", layout: "home" }, async (fixture) => {
      const cfg: OpenClawConfig = { plugins: { enabled: false } };
      runAuthProfileWriteTransaction(
        undefined,
        (database) => {
          writePersistedAuthProfileStoreRaw(
            {
              version: 1,
              profiles: {
                "claude-cli:work": { type: "api_key", provider: "claude-cli", key: "retained-key" },
              },
            },
            undefined,
            database,
          );
        },
        { env: fixture.env },
      );
      await fixture.writeText("agents/unavailable/agent", "not an agent directory");
      const profileIdMap = collectOpenAICodexAuthProfileStoreIdMap({ cfg, env: fixture.env });
      expect(profileIdMap.size).toBe(0);
    });
  });

  it("migrates stored aliases without replacing credentials or widening an empty order", async () => {
    await withOpenClawTestState({ label: "auth-alias", layout: "home" }, async (fixture) => {
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
        type: "api_key" as const,
        provider: "openai",
        key: "synthetic-canonical-key",
        metadata: { accountId: "canonical-account" },
      };
      const agentCredential = {
        type: "api_key" as const,
        provider: "openai",
        key: "synthetic-agent-key",
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
      const agent: AuthProfileStore = {
        version: 1,
        profiles: { "openai:chatgpt-work": agentCredential },
      };
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
      runAuthProfileWriteTransaction(
        fixture.agentDir("worker"),
        (database) =>
          writePersistedAuthProfileStoreRaw(agent, fixture.agentDir("worker"), database),
        { env: fixture.env },
      );
      expect(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toEqual(shared);
      expect(readPersistedAuthProfileStoreRaw(fixture.agentDir("worker"))).toEqual(agent);

      const result = await runDoctorRepairSequence({
        state: { cfg, candidate: structuredClone(cfg), pendingChanges: false, fixHints: [] },
        doctorFixCommand: "openclaw doctor --fix",
        env: fixture.env,
      });

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
