import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { resolveSharedAuthStorePath } from "../../agents/auth-profiles/path-resolve.js";
import {
  loadPersistedAuthProfileStore as loadLocalStore,
  loadPersistedSharedAuthProfileStore as loadSharedStore,
} from "../../agents/auth-profiles/persisted.js";
import {
  inspectAuthProfileJsonCell,
  readAuthProfileJsonCellText,
} from "../../agents/auth-profiles/sqlite-json.js";
import {
  closeAuthProfileReadPool,
  readAuthProfileStateJsonTextReadOnly,
  readPersistedAuthProfileStoreRaw as readLocalStore,
  readPersistedSharedAuthProfileStateRaw as readSharedState,
  readPersistedSharedAuthProfileStoreRaw as readSharedStore,
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
  collectOpenAICodexAuthProfileStoreIdMap as collectIdMap,
  maybeRepairOpenAICodexAuthConfig as repairAuthConfig,
} from "../doctor-auth-flat-profiles.js";
import {
  withState,
  runRepair,
  apiKey,
  authStore,
  writeStore,
  repairAuth,
  importAuth,
  doctorConfig,
} from "./auth-alias.test-support.js";

function expectSharedCell(db: DatabaseSync, kind: "store" | "state", raw: unknown) {
  expect(inspectAuthProfileJsonCell(db, kind, "shared-state")).toEqual({ status: "readable", raw });
}

describe("Doctor stored auth alias migration", () => {
  it.each(["import", "repair sequence"])(
    "imports config-selected OAuth sidecars through %s before alias repair",
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
              "example:default": { mode: "api_key", provider: "example", apiKey: "synthetic-key" },
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
          fs.writeFileSync(
            sidecar,
            JSON.stringify({
              version: 1,
              profileId: "openai-codex:default",
              provider: "openai-codex",
              access: "synthetic-access",
              refresh: "synthetic-refresh",
            }),
          );
          const sidecarBytes = fs.readFileSync(sidecar);
          const sourceBytes = fs.readFileSync(sourcePath);
          const cfg = doctorConfig({ env: { vars: { OPENCLAW_OAUTH_DIR: oauthDir } } });
          const pending =
            entrypoint === "import"
              ? importAuth(cfg, fixture.env)
              : runRepair(cfg, { env: fixture.env, candidate: cfg });
          await pending;
          expect(loadSharedStore(fixture.env)?.profiles).toMatchObject({
            "example:default": { type: "api_key", key: "synthetic-key" },
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
            const archive = fs
              .readdirSync(path.dirname(source))
              .find((name) => name.startsWith(`${path.basename(source)}.migrated-`));
            expect(archive).toBeDefined();
            expect(fs.readFileSync(path.join(path.dirname(source), archive!))).toEqual(bytes);
          }
          expect(fixture.env.OPENCLAW_OAUTH_DIR).toBeUndefined();
        },
      );
    },
  );

  it("keeps canonical JSON import projection and archives the exact original fields", async () => {
    await withState("auth-json-projection", async (fixture) => {
      await fixture.writeJson(
        "agents/main/agent/auth-profiles.json",
        authStore({
          "example:json": {
            mode: "api_key",
            provider: "example",
            apiKey: "synthetic-json-key",
            metadata: { label: "retained", malformed: 123 },
            unknownField: { preserved: "in-archive" },
          },
          "unknown:future": 17,
        }),
      );
      const agentDir = fixture.agentDir("main");
      const sourcePath = path.join(agentDir, "auth-profiles.json");
      const original = fs.readFileSync(sourcePath);
      await importAuth(doctorConfig(), fixture.env);
      const profiles = {
        "example:json": {
          type: "api_key",
          provider: "example",
          key: "synthetic-json-key",
          metadata: { label: "retained" },
        },
      };
      expect(readSharedStore(fixture.env)).toMatchObject({ profiles });
      expect(loadSharedStore(fixture.env)?.profiles).toEqual(profiles);
      const archives = fs
        .readdirSync(agentDir)
        .filter((name) => name.startsWith("auth-profiles.json.migrated-"));
      expect(archives).toHaveLength(1);
      expect(fs.readFileSync(path.join(agentDir, archives[0]!))).toEqual(original);
      expect(fs.existsSync(sourcePath)).toBe(false);
    });
  });

  it("does not migrate a replacement database with identical auth rows after backup", async () => {
    await withState("auth-backup-generation", async (fixture) => {
      const original = authStore({
        "example:work": { mode: "api_key", provider: "example", apiKey: "synthetic-key" },
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
        await expect(repairAuth(doctorConfig(), fixture.env)).rejects.toThrow(
          "database file identity changed",
        );
      } finally {
        replacedDuringBackup.mockRestore();
      }
      const replacement = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expectSharedCell(replacement, "store", original);
        expect(
          replacement
            .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
            .get("synthetic.replacement"),
        ).toEqual({ value_json: '"new-generation"' });
      } finally {
        replacement.close();
      }
    });
  });

  it.each([false, true])(
    "backs up and canonicalizes credential fields without renaming profile IDs (unreadable state: %s)",
    async (unreadableState) => {
      await withState("auth-credential-fields", async (fixture) => {
        const cfg: OpenClawConfig = doctorConfig({
          secrets: { defaults: { env: "configured-env" } },
        });
        const ref = { source: "env", provider: "default", id: "SYNTHETIC_AUTH_KEY" };
        // An omitted output means the raw credential fields must stay unchanged.
        const api = (fields: Record<string, unknown>) => ({ type: "api_key", ...fields });
        const profiles: Record<string, [Record<string, unknown>, Record<string, unknown>?]> = {
          "malformed-oauth": [
            {
              mode: "oauth",
              access: 17,
              refresh: { unrecognized: "synthetic" },
              expires: "unknown",
            },
            {
              type: "oauth",
              access: 17,
              refresh: { unrecognized: "synthetic" },
              expires: "unknown",
            },
          ],
          "token-extras": [
            {
              type: "token",
              token: "synthetic-token",
              mode: "oauth",
              apiKey: "synthetic-extension",
              key: ref,
            },
          ],
          malformed: [api({ key: "synthetic-canonical", apiKey: 123, mode: "unknown" })],
          "malformed-only": [api({ apiKey: 123, mode: "unknown" })],
          unknown: [{ type: "unsupported", mode: "future", apiKey: "synthetic-retained" }],
          mode: [
            { mode: "api_key", apiKey: "synthetic-api-key", email: "owner@example.test" },
            api({ key: "synthetic-api-key", email: "owner@example.test" }),
          ],
          type: [
            { type: "apiKey", apiKey: "synthetic-type-key" },
            api({ key: "synthetic-type-key" }),
          ],
          ref: [api({ key: ref }), api({ keyRef: ref })],
          "providerless-key": [
            api({
              keyRef: { source: "env", id: "SYNTHETIC_AUTH_KEY", opaque: "keep-in-backup" },
              extension: "preserved",
            }),
            api({ keyRef: ref, extension: "preserved" }),
          ],
          "providerless-token": [
            {
              type: "token",
              tokenRef: {
                source: "env",
                id: "SYNTHETIC_AUTH_KEY",
                opaque: { note: "keep-in-backup" },
              },
            },
            { type: "token", tokenRef: ref },
          ],
          "api-ref": [api({ key: null, apiKey: ref }), api({ keyRef: ref })],
          empty: [
            api({ key: "", apiKey: "synthetic-fallback" }),
            api({ key: "synthetic-fallback" }),
          ],
          token: [
            { type: "token", token: ref, expires: 1900000000000 },
            { type: "token", tokenRef: ref, expires: 1900000000000 },
          ],
          alias: [
            api({ api_key: "synthetic-underscore-key" }),
            api({ key: "synthetic-underscore-key" }),
          ],
        };
        const makeStore = (expected = false) =>
          authStore(
            Object.fromEntries(
              Object.entries(profiles).map(([name, [input, output]]) => [
                `example:${name}`,
                { provider: "example", ...(expected ? (output ?? input) : input) },
              ]),
            ),
          );
        const original = makeStore();
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
        const run = () => runRepair(cfg, { env: fixture.env });
        const repaired = await run();
        expect(
          repaired.changeNotes
            .flatMap((note) => note.split("\n"))
            .filter((message) => message.startsWith("Canonicalized 2 auth SecretRef(s) in ")),
        ).toEqual([
          expect.stringContaining(
            "to source/provider/id; unsupported fields are preserved in the verified migration backup.",
          ),
        ]);
        const expected = makeStore(true);
        expect(readSharedStore(fixture.env)).toEqual(expected);
        expect(readSharedState(fixture.env)).toEqual(unreadableState ? null : state);
        if (unreadableState) {
          expect(
            readAuthProfileStateJsonTextReadOnly({
              path: databasePath,
              kind: "shared-state",
              env: fixture.env,
            }),
          ).toBe("{invalid-rotation-state");
        }
        const runtimeStore = loadSharedStore(fixture.env);
        expect(runtimeStore?.profiles["example:mode"]).toEqual(expected.profiles["example:mode"]);
        expect(runtimeStore?.profiles).not.toHaveProperty("example:unknown");
        for (const [name, credential] of Object.entries({
          malformed: apiKey("example", "synthetic-canonical"),
          "malformed-only": { type: "api_key", provider: "example" },
          "malformed-oauth": { type: "oauth", provider: "example", expires: 0 },
          "token-extras": { type: "token", provider: "example", token: "synthetic-token" },
        })) {
          expect(runtimeStore?.profiles[`example:${name}`]).toEqual(credential);
        }
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
          expectSharedCell(backup, "store", original);
          if (unreadableState) {
            expect(readAuthProfileJsonCellText(backup, "state", "shared-state")).toBe(
              "{invalid-rotation-state",
            );
          } else {
            expectSharedCell(backup, "state", state);
          }
        } finally {
          backup.close();
        }
        await run();
        expect(readSharedStore(fixture.env)).toEqual(expected);
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
      await withState("alias-family", async (fixture) => {
        const agentDir = owner === "shared" ? undefined : fixture.agentDir("worker");
        const cfg: OpenClawConfig = doctorConfig({
          auth: {
            profiles: { [legacyId]: { provider: legacyProvider, mode: "api_key" } },
            order: { [legacyProvider]: [legacyId] },
          },
        });
        const original: AuthProfileStore = authStore(
          { [legacyId]: apiKey(legacyProvider, legacyId) },
          {
            order: { [legacyProvider]: [legacyId] },
            lastGood: { [legacyProvider]: legacyId },
            usageStats: { [legacyId]: { errorCount: 4, lastUsed: 4321 } },
          },
        );
        writeStore(fixture.env, original, agentDir);

        const profileIdMap = collectIdMap({ cfg, env: fixture.env });
        const result = await repairAuth(cfg, fixture.env, profileIdMap);
        const config = repairAuthConfig(cfg, { profileIdMap: result.profileIdMap }).config;
        expect(result.warnings).toEqual([]);
        expect(config.auth?.profiles).toEqual({
          [canonicalId]: { provider: canonicalProvider, mode: "api_key" },
        });
        expect(config.auth?.order).toEqual({ [canonicalProvider]: [canonicalId] });
        await cleanupSessionStateForTest({ stateDir: fixture.stateDir });
        closeAuthProfileReadPool({ kind: "root", rootPath: fixture.stateDir });
        const reopened = agentDir ? loadLocalStore(agentDir) : loadSharedStore(fixture.env);
        expect(reopened?.profiles).toEqual({ [canonicalId]: apiKey(canonicalProvider, legacyId) });
        expect(reopened?.order).toEqual({ [canonicalProvider]: [canonicalId] });
        expect(reopened?.lastGood).toEqual({ [canonicalProvider]: canonicalId });
        expect(reopened?.usageStats).toEqual({ [canonicalId]: { errorCount: 4, lastUsed: 4321 } });
        const repeatMap = collectIdMap({ cfg: config, env: fixture.env });
        expect((await repairAuth(config, fixture.env, repeatMap)).changes).toEqual([]);
      });
    },
  );

  it("keeps unreadable shared state and config references unchanged", async () => {
    await withState("alias-unreadable", async (fixture) => {
      const cfg: OpenClawConfig = doctorConfig({
        auth: {
          profiles: { "openai-codex:work": { provider: "openai-codex", mode: "api_key" } },
          order: { "openai-codex": ["openai-codex:work"], openai: [] },
        },
      });
      writeStore(fixture.env, "unreadable-store-shape");
      const result = await runRepair(cfg, { env: fixture.env });
      expect(result.state.candidate.auth).toEqual(cfg.auth);
      expect(readSharedStore(fixture.env)).toBe("unreadable-store-shape");
      expect(result.warningNotes.join("\n")).toContain("unreadable or invalid");
    });
  });

  it("imports a flat legacy source directly into the canonical profile", async () => {
    await withState("alias-flat-import", async (fixture) => {
      const cfg: OpenClawConfig = doctorConfig({
        auth: { profiles: { "claude-cli:default": { provider: "claude-cli", mode: "api_key" } } },
      });
      await fixture.writeJson("agents/main/agent/auth.json", {
        "claude-cli": apiKey("claude-cli", "retained-flat-key"),
      });
      const result = await runRepair(cfg, { env: fixture.env });
      expect(result.state.candidate.auth?.profiles).toEqual({
        "anthropic:default": { provider: "anthropic", mode: "api_key" },
      });
      expect(loadSharedStore(fixture.env)?.profiles).toEqual({
        "anthropic:default": apiKey("anthropic", "retained-flat-key"),
      });
    });
  });

  it("keeps an invalid agent store while an independent shared profile migrates", async () => {
    await withState("alias-partial", async (fixture) => {
      const cfg: OpenClawConfig = doctorConfig();
      const invalid = authStore({ "google-gemini-cli:broken": 17 });
      writeStore(
        fixture.env,
        authStore({ "claude-cli:work": apiKey("claude-cli", "retained-key") }),
      );
      writeStore(fixture.env, invalid, fixture.agentDir("broken"));
      const profileIdMap = collectIdMap({ cfg, env: fixture.env });
      const result = await repairAuth(cfg, fixture.env, profileIdMap);
      expect(readLocalStore(fixture.agentDir("broken"))).toEqual(invalid);
      expect(loadSharedStore(fixture.env)?.profiles).toEqual({
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
      await withState("alias-realm", async (fixture) => {
        const cfg: OpenClawConfig = doctorConfig(
          providerConfig
            ? {
                models: {
                  providers: {
                    "openai-codex": { baseUrl: "https://fixture.invalid/v1", models: [] },
                  },
                },
              }
            : {},
        );
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
        const profileIdMap = collectIdMap({ cfg, env: fixture.env });
        const result = await repairAuth(cfg, fixture.env, profileIdMap);
        expect(result.changes).toEqual([]);
        expect(result.warnings.join("\n")).toContain("realm or identity is unresolved");
        expect(readSharedStore(fixture.env)).toEqual(original);
      });
    },
  );

  it.each(["credentials", "rotation state"])(
    "rejects a stale map before replacing newer %s",
    async (occupied) => {
      await withState("alias-stale-map", async (fixture) => {
        const cfg: OpenClawConfig = doctorConfig();
        const original = authStore({ "openai-codex:work": apiKey("openai-codex", "old-key") });
        writeStore(fixture.env, original);
        const profileIdMap = collectIdMap({ cfg, env: fixture.env });
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
        const result = await repairAuth(cfg, fixture.env, profileIdMap);
        expect.soft(result.changes).toEqual([]);
        expect.soft(result.profileIdMap.size).toBe(0);
        expect.soft(result.warnings.join("\n")).toContain("target is occupied");
        expect.soft(readSharedStore(fixture.env)).toEqual(current);
        if (occupied === "rotation state") {
          expect.soft(readSharedState(fixture.env)).toEqual(currentState);
        }
      });
    },
  );

  it("refuses alias planning when an agent location is not a directory", async () => {
    await withState("alias-census", async (fixture) => {
      const cfg: OpenClawConfig = doctorConfig();
      writeStore(
        fixture.env,
        authStore({ "claude-cli:work": apiKey("claude-cli", "retained-key") }),
      );
      await fixture.writeText("agents/unavailable/agent", "not an agent directory");
      const profileIdMap = collectIdMap({ cfg, env: fixture.env });
      expect(profileIdMap.size).toBe(0);
    });
  });

  it("migrates stored aliases without replacing credentials or widening an empty order", async () => {
    await withState("auth-alias", async (fixture) => {
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
      const shared: AuthProfileStore = authStore(
        { "openai-codex:work": legacyCredential, "openai:work": canonicalCredential },
        {
          lastGood: { "openai-codex": "openai-codex:work" },
          usageStats: { "openai-codex:work": { lastUsed: 1234, errorCount: 2 } },
        },
      );
      const agent: AuthProfileStore = authStore({ "openai:chatgpt-work": agentCredential });
      // Keep the retired field explicit in this migration fixture.
      const legacyRuntime: AgentRuntimePolicyConfig & { authProfileId: string } = {
        authProfileId: "openai-codex:work",
      };
      const cfg: OpenClawConfig = doctorConfig({
        agents: {
          defaults: {
            workspace: fixture.workspaceDir,
            models: { "openai/fixture-model": { agentRuntime: legacyRuntime } },
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
      });
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
      expect(readSharedStore(fixture.env)).toEqual(shared);
      expect(readLocalStore(fixture.agentDir("worker"))).toEqual(agent);

      const result = await runRepair(cfg, { env: fixture.env });

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
      expect
        .soft(migratedConfig.auth?.profiles?.[migratedId])
        .toMatchObject({ provider: "openai", mode: "oauth", email: "legacy-work@example.invalid" });
      expect.soft(migratedConfig.auth?.order?.openai).toEqual([]);

      await cleanupSessionStateForTest({ stateDir: fixture.stateDir });
      closeAuthProfileReadPool({ kind: "root", rootPath: fixture.stateDir });
      const reopened = loadSharedStore(fixture.env);
      expect
        .soft(reopened?.profiles[migratedId])
        .toEqual({ ...legacyCredential, provider: "openai" });
      expect.soft(reopened?.profiles["openai-codex:work"]).toBeUndefined();
      expect.soft(reopened?.profiles["openai:work"]).toEqual(canonicalCredential);
      expect.soft(loadLocalStore(fixture.agentDir("worker"))?.profiles).toEqual(agent.profiles);
      expect.soft(readSharedState(fixture.env)).toEqual({
        version: 1,
        order: { openai: [migratedId] },
        lastGood: { openai: migratedId },
        usageStats: { [migratedId]: { lastUsed: 5678, errorCount: 3 } },
      });
      expect.soft(readSharedStore(fixture.env)).toMatchObject({
        lastGood: { openai: migratedId },
        usageStats: { [migratedId]: { lastUsed: 1234, errorCount: 2 } },
      });
    });
  });
});
