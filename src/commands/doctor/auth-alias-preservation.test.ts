import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createApiKeyCredential as apiKey,
  createAuthProfileStoreFixture as authStore,
} from "../../agents/auth-profiles/credential-fixtures.test-support.js";
import { resolveSharedAuthStorePath } from "../../agents/auth-profiles/path-resolve.js";
import { loadPersistedSharedAuthProfileStore } from "../../agents/auth-profiles/persisted.js";
import * as authProfileSqlite from "../../agents/auth-profiles/sqlite.js";
import {
  readPersistedAuthProfileStateRaw,
  readPersistedAuthProfileStoreRaw,
  readPersistedSharedAuthProfileStoreRaw,
  resolveAuthProfileDatabasePath,
  runAuthProfileWriteTransaction,
  writePersistedAuthProfileStateRaw,
  writePersistedAuthProfileStoreRaw,
} from "../../agents/auth-profiles/sqlite.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  detectSharedAuthStoreMigration,
  migrateSharedAuthStore,
} from "../../infra/state-migrations.shared-auth-store.js";
import {
  listUserProfileAuthLinks,
  setUserProfileAuthLink,
} from "../../state/user-model-accounts.js";
import { ensureGatewayOwnerProfile } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  collectOpenAICodexAuthProfileStoreIdMap,
  maybeMigrateAuthProfileJsonStoresToSqlite,
  maybeRepairLegacyAuthProfileStores,
  maybeRepairOpenAICodexAuthConfig,
} from "../doctor-auth-flat-profiles.js";
import { withPersistedAuthProfileStoreRead } from "../doctor-auth-flat-profiles.test-support.js";
import { recordAuthAliasMigration } from "./auth-alias-receipt.js";
import { repairAuthProfileMigration } from "./auth-profile-repair.js";
import { runDoctorRepairSequence } from "./repair-sequencing.js";
import { maybeRepairCodexSessionRoutes } from "./shared/codex-route-session-repair.js";

function withFixture(run: Parameters<typeof withOpenClawTestState>[1]) {
  return withOpenClawTestState({ label: "auth-alias", layout: "home" }, run);
}

function writeAuthFixture(
  env: NodeJS.ProcessEnv,
  agentDir: string | undefined,
  value: unknown,
  writer = writePersistedAuthProfileStoreRaw,
) {
  return runAuthProfileWriteTransaction(agentDir, (database) => writer(value, agentDir, database), {
    env,
  });
}

function authSelection(provider: string, id: string) {
  return {
    profiles: { [id]: { provider, mode: "api_key" as const } },
    order: { [provider]: [id] },
  };
}

function authConfig(
  auth?: OpenClawConfig["auth"],
  agents?: OpenClawConfig["agents"],
): OpenClawConfig {
  return { plugins: { enabled: false }, ...(auth ? { auth } : {}), ...(agents ? { agents } : {}) };
}

function runDoctor(cfg: OpenClawConfig, env: NodeJS.ProcessEnv) {
  return runDoctorRepairSequence({
    state: { cfg, candidate: structuredClone(cfg), pendingChanges: false, fixHints: [] },
    doctorFixCommand: "openclaw doctor --fix",
    env,
  });
}

describe("Doctor auth alias preservation", () => {
  it.each([
    "rotation state",
    "sibling profile",
    "inherited rotation reference",
    "opaque inherited rotation state",
    "uninspectable sibling owner",
    "opaque state-only owner",
  ])("defers dependent aliases when %s cannot be renamed", async (invalid) => {
    await withFixture(async (fixture) => {
      const legacyId = "claude-cli:work";
      const canonicalId = "anthropic:work";
      const inherited = invalid.includes("inherited");
      const separateOwner =
        inherited ||
        invalid === "uninspectable sibling owner" ||
        invalid === "opaque state-only owner";
      const agentDir = fixture.agentDir("worker");
      const cfg: OpenClawConfig = {
        plugins: { enabled: false },
        ...(separateOwner ? { agents: { entries: { main: {}, worker: { agentDir } } } } : {}),
        auth: { profiles: { [legacyId]: { provider: "claude-cli", mode: "api_key" } } },
      };
      runAuthProfileWriteTransaction(
        undefined,
        (database) => {
          writePersistedAuthProfileStoreRaw(
            authStore({
              [legacyId]: {
                mode: "api_key",
                provider: "claude-cli",
                apiKey: "synthetic-key",
              },
              ...(invalid === "sibling profile" ? { "unknown:future": 17 } : {}),
            }),
            undefined,
            database,
          );
          if (invalid === "rotation state") {
            database.db
              .prepare(
                "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT(state_key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms",
              )
              .run("authProfiles.state", "{malformed-state", 1234);
          }
        },
        { env: fixture.env },
      );
      if (separateOwner) {
        runAuthProfileWriteTransaction(
          agentDir,
          (database) => {
            if (invalid !== "opaque state-only owner") {
              writePersistedAuthProfileStoreRaw(
                invalid === "uninspectable sibling owner"
                  ? "unreadable-store-shape"
                  : authStore({ "unknown:future": 17 }),
                agentDir,
                database,
              );
            }
            writePersistedAuthProfileStateRaw(
              { order: { "claude-cli": [legacyId] } },
              agentDir,
              database,
            );
            if (
              invalid === "opaque inherited rotation state" ||
              invalid === "opaque state-only owner"
            ) {
              database.db
                .prepare("UPDATE auth_profile_state SET state_json = ? WHERE state_key = ?")
                .run("{opaque-rotation-state", "primary");
            }
          },
          { env: fixture.env },
        );
      }
      const owner = ensureGatewayOwnerProfile(null, { env: fixture.env });
      setUserProfileAuthLink(
        { profileId: owner.id, provider: "anthropic", authProfileId: legacyId },
        { env: fixture.env },
      );
      const repaired = await maybeRepairLegacyAuthProfileStores({
        cfg,
        env: fixture.env,
        profileIdMap: new Map([[legacyId, canonicalId]]),
      });
      expect(repaired.profileIdMap.size).toBe(0);
      expect(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toEqual(
        authStore({
          [legacyId]: apiKey("claude-cli", "synthetic-key"),
          ...(invalid === "sibling profile" ? { "unknown:future": 17 } : {}),
        }),
      );
      expect(
        maybeRepairOpenAICodexAuthConfig(cfg, { profileIdMap: repaired.profileIdMap }).config.auth,
      ).toEqual(cfg.auth);
      expect(listUserProfileAuthLinks(owner.id, { env: fixture.env })).toMatchObject([
        { provider: "anthropic", authProfileId: legacyId },
      ]);
      if (invalid === "inherited rotation reference") {
        await fixture.writeJson(
          "agents/main/agent/auth-profiles.json",
          authStore({
            [legacyId]: {
              mode: "api_key",
              provider: "claude-cli",
              apiKey: "synthetic-key",
            },
          }),
        );
        const imported = await maybeMigrateAuthProfileJsonStoresToSqlite({
          cfg,
          env: fixture.env,
          prompter: { confirmAutoFix: async () => true },
          openAICodexAuthProfileIdMap: new Map([[legacyId, canonicalId]]),
        });
        expect(imported.blockedProfileIds.has(legacyId)).toBe(true);
        expect(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toMatchObject({
          profiles: {
            [legacyId]: apiKey("claude-cli", "synthetic-key"),
          },
        });
        expect(readPersistedSharedAuthProfileStoreRaw(fixture.env)).not.toHaveProperty([
          "profiles",
          canonicalId,
        ]);
      }
    });
  });

  it("recovers an old rename receipt across normalized and rolled-back credential owners", async () => {
    await withFixture(async (fixture) => {
      const agentDir = fixture.agentDir("worker");
      const cfg = authConfig(undefined, {
        entries: { main: {}, worker: { agentDir } },
      });
      const legacyId = "claude-cli:work";
      const canonicalId = "anthropic:work";
      const repair = (profileIdMap = new Map<string, string>()) =>
        maybeRepairLegacyAuthProfileStores({ cfg, env: fixture.env, profileIdMap });
      const collect = () => collectOpenAICodexAuthProfileStoreIdMap({ cfg, env: fixture.env });
      const source = authStore({
        [legacyId]: {
          mode: "api_key",
          provider: "claude-cli",
          apiKey: "synthetic-original",
        },
      });
      const renamed = authStore({
        [canonicalId]: {
          mode: "api_key",
          provider: "anthropic",
          apiKey: "synthetic-original",
        },
      });
      const write = (owner: string | undefined, store: unknown) =>
        writeAuthFixture(fixture.env, owner, store);
      write(undefined, renamed);
      write(agentDir, source);
      const paths = [
        resolveSharedAuthStorePath(fixture.env),
        resolveAuthProfileDatabasePath(agentDir),
      ];
      // Reproduce a shipped rename receipt that predates field normalization.
      recordAuthAliasMigration({
        profileIdMap: new Map([[legacyId, canonicalId]]),
        stores: paths.map((databasePath) => ({
          databasePath,
          store: source,
          migratedStore: renamed,
        })),
        env: fixture.env,
      });
      const failedWrite = vi
        .spyOn(authProfileSqlite, "writePersistedAuthProfileStoreRaw")
        .mockImplementationOnce(() => {
          throw new Error("synthetic persistence failure");
        });
      try {
        await expect(repair(new Map([[legacyId, canonicalId]]))).rejects.toThrow(
          "synthetic persistence failure",
        );
      } finally {
        failedWrite.mockRestore();
      }
      expect(readPersistedAuthProfileStoreRaw(agentDir)).toEqual(source);
      expect(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toEqual(renamed);
      // Model the partial commit left by independent database owners. Its
      // normalization fingerprint must survive the failed write transaction.
      // Keep Doctor's property order because the receipt hashes exact JSON.
      write(
        agentDir,
        authStore({
          [canonicalId]: {
            provider: "anthropic",
            type: "api_key",
            key: "synthetic-original",
          },
        }),
      );
      expect(collect().get(legacyId)).toBe(canonicalId);
      await repair();
      expect(readPersistedAuthProfileStoreRaw(agentDir)).toEqual(
        authStore({ [canonicalId]: apiKey("anthropic", "synthetic-original") }),
      );
      expect(collect().get(legacyId)).toBe(canonicalId);
      // A rollback or interrupted multi-owner commit can leave the other owner on its exact preimage.
      write(agentDir, renamed);
      expect(collect().get(legacyId)).toBe(canonicalId);
      await repair();
      expect((await repair()).changes).toEqual([]);
      const owner = ensureGatewayOwnerProfile(null, { env: fixture.env });
      setUserProfileAuthLink(
        { profileId: owner.id, provider: "anthropic", authProfileId: legacyId },
        { env: fixture.env },
      );
      const recovered = collect();
      await repair(recovered);
      expect(listUserProfileAuthLinks(owner.id, { env: fixture.env })).toMatchObject([
        { provider: "anthropic", authProfileId: canonicalId },
      ]);
      const receiptTimes = () =>
        runAuthProfileWriteTransaction(
          undefined,
          ({ db }) =>
            db
              .prepare(
                "SELECT s.imported_at, r.finished_at FROM migration_sources s JOIN migration_runs r ON r.id = s.last_run_id WHERE s.source_key = ?",
              )
              .get("auth-profile-sqlite-alias-map:v1"),
          { env: fixture.env },
        );
      const previousTimes = receiptTimes();
      const futureNow = Date.now() + 1000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(futureNow);
      try {
        expect((await repair(recovered)).changes).toEqual([]);
      } finally {
        clock.mockRestore();
      }
      expect(receiptTimes()).toEqual(previousTimes);
      write(
        agentDir,
        authStore({ [canonicalId]: apiKey("anthropic", "synthetic-different-account") }),
      );
      expect(collect().has(legacyId)).toBe(false);
    });
  });

  it.each([false, true])(
    "recovers a failed config write without adopting a changed account (%s)",
    async (replaceAccount) => {
      await withFixture(async (fixture) => {
        const agentDir = fixture.agentDir("worker");
        const cfg = authConfig(authSelection("openai-codex", "openai-codex:work"), {
          entries: { main: {}, worker: { agentDir } },
        });
        writeAuthFixture(
          fixture.env,
          undefined,
          authStore({
            "openai-codex:work": apiKey("openai-codex", "synthetic-original-account"),
          }),
        );
        const workerStore = authStore({
          "openai-codex:work": apiKey("openai-codex", "synthetic-worker-account"),
        });
        writeAuthFixture(fixture.env, agentDir, workerStore);
        const run = () => runDoctor(cfg, fixture.env);
        // The durable store commit survives even when the caller cannot save this candidate.
        await run();
        expect(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toMatchObject({
          profiles: { "openai:work": { provider: "openai", key: "synthetic-original-account" } },
        });
        if (replaceAccount) {
          writeAuthFixture(
            fixture.env,
            undefined,
            authStore({ "openai:work": apiKey("openai", "synthetic-replacement-account") }),
          );
        } else {
          // A stopped multi-store pass can leave one owner at its recorded pre-migration state.
          writeAuthFixture(fixture.env, agentDir, workerStore);
        }
        const resumed = await run();
        if (replaceAccount) {
          expect(resumed.state.candidate.auth).toEqual(cfg.auth);
          expect(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toMatchObject({
            profiles: { "openai:work": { key: "synthetic-replacement-account" } },
          });
        } else {
          expect(resumed.state.candidate.auth).toEqual({
            profiles: { "openai:work": { provider: "openai", mode: "api_key" } },
            order: { openai: ["openai:work"] },
          });
          expect(resumed.openAICodexAuthProfileIdMap?.get("openai-codex:work")).toBe("openai:work");
          expect(readPersistedAuthProfileStoreRaw(agentDir)).toMatchObject({
            profiles: { "openai:work": { provider: "openai", key: "synthetic-worker-account" } },
          });
        }
      });
    },
  );
  it.each([
    ["claude-cli:work", "claude-cli", "anthropic:work", "shared"],
    ["google-gemini-cli:work", "google-gemini-cli", "google:work", "agent"],
  ])(
    "keeps the selected session account when migrating %s",
    async (id, provider, canonical, owner) => {
      await withFixture(async (fixture) => {
        const agentDir = fixture.agentDir("worker");
        const cfg = authConfig(
          { profiles: { [id]: { provider, mode: "api_key" } } },
          { entries: { main: {}, worker: { agentDir } } },
        );
        writeAuthFixture(
          fixture.env,
          owner === "shared" ? undefined : agentDir,
          authStore({ [id]: apiKey(provider, "synthetic-session-key") }),
        );
        const storePath = path.join(fixture.stateDir, "agents/worker/sessions/sessions.json");
        const sessionKey = "agent:worker:main";
        await replaceSessionEntry(
          { storePath, sessionKey, env: fixture.env },
          {
            sessionId: "selected-account",
            updatedAt: 1234,
            authProfileOverride: id,
            authProfileOverrideSource: "user",
          },
        );
        const repaired = await runDoctor(cfg, fixture.env);
        await maybeRepairCodexSessionRoutes({
          cfg: repaired.state.candidate,
          env: fixture.env,
          shouldRepair: true,
          authProfileIdMap: repaired.openAICodexAuthProfileIdMap,
        });
        expect(loadSessionEntry({ storePath, sessionKey, env: fixture.env })).toMatchObject({
          sessionId: "selected-account",
          authProfileOverride: canonical,
          authProfileOverrideSource: "user",
        });
      });
    },
  );

  it("rejects newly occupied inherited rotation state before changing any store", async () => {
    await withFixture(async (fixture) => {
      const agentDir = fixture.agentDir("worker");
      const cfg = authConfig();
      const shared = authStore({
        "openai-codex:work": apiKey("openai-codex", "synthetic-shared-key"),
      });
      writeAuthFixture(fixture.env, undefined, shared);
      writeAuthFixture(
        fixture.env,
        agentDir,
        { version: 1, usageStats: { "openai-codex:work": { errorCount: 2 } } },
        writePersistedAuthProfileStateRaw,
      );
      const profileIdMap = collectOpenAICodexAuthProfileStoreIdMap({ cfg, env: fixture.env });
      expect(profileIdMap.get("openai-codex:work")).toBe("openai:work");
      const currentState = {
        version: 1,
        usageStats: {
          "openai-codex:work": { errorCount: 2 },
          "openai:work": { errorCount: 99 },
        },
      };
      writeAuthFixture(fixture.env, agentDir, currentState, writePersistedAuthProfileStateRaw);
      const result = await maybeRepairLegacyAuthProfileStores({
        cfg,
        env: fixture.env,
        profileIdMap,
      });
      expect(result.changes).toEqual([]);
      expect(result.profileIdMap.size).toBe(0);
      expect(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toEqual(shared);
      expect(readPersistedAuthProfileStateRaw(agentDir)).toEqual(currentState);
    });
  });

  it("preserves a blocked custom account order while an independent account migrates", async () => {
    await withFixture(async (fixture) => {
      const blocked = {
        type: "api_key",
        provider: "claude-cli",
        key: "synthetic-realm-key",
        issuer: "https://fixture.invalid/issuer",
      };
      const cfg = authConfig({
        profiles: {
          "work-account": { provider: "claude-cli", mode: "api_key" },
          "codex:ready": { provider: "codex", mode: "api_key" },
        },
        order: { "claude-cli": ["work-account"], codex: ["codex:ready"] },
      });
      writeAuthFixture(fixture.env, undefined, {
        version: 1,
        profiles: {
          "work-account": blocked,
          "codex:ready": apiKey("codex", "synthetic-ready-key"),
        },
        order: cfg.auth?.order,
      });
      const result = await runDoctor(cfg, fixture.env);
      expect(result.state.candidate.auth?.order).toEqual({
        "claude-cli": ["work-account"],
        openai: ["openai:ready"],
      });
      expect(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toMatchObject({
        profiles: {
          "work-account": blocked,
          "openai:ready": { provider: "openai", key: "synthetic-ready-key" },
        },
        order: { "claude-cli": ["work-account"], openai: ["openai:ready"] },
      });
    });
  });
});

it("repairs credential fields while deferring an occupied JSON alias destination", async () => {
  await withFixture(async (fixture) => {
    const from = "claude-cli:work";
    const to = "anthropic:work";
    const cfg = authConfig({
      profiles: { [from]: { provider: "claude-cli", mode: "api_key" } },
    });
    writeAuthFixture(
      fixture.env,
      undefined,
      authStore({
        [to]: {
          mode: "api_key",
          provider: "anthropic",
          apiKey: "synthetic-existing-account",
        },
        "example:legacy": {
          type: "api_key",
          provider: "example",
          api_key: "synthetic-independent-account",
        },
      }),
    );
    await fixture.writeJson(
      "agents/main/agent/auth-profiles.json",
      authStore({ [from]: apiKey("claude-cli", "synthetic-imported-account") }),
    );
    const repaired = await repairAuthProfileMigration({
      cfg,
      env: fixture.env,
      prompter: { shouldRepair: false, confirmAutoFix: async () => true },
      profileIdMap: new Map([[from, to]]),
    });
    expect(repaired.profileIdMap.size).toBe(0);
    expect(repaired.config.auth).toEqual(cfg.auth);
    expect(loadPersistedSharedAuthProfileStore(fixture.env)?.profiles).toEqual({
      [from]: apiKey("claude-cli", "synthetic-imported-account"),
      [to]: apiKey("anthropic", "synthetic-existing-account"),
      "example:legacy": apiKey("example", "synthetic-independent-account"),
    });
    expect(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toMatchObject({
      profiles: {
        [from]: { key: "synthetic-imported-account" },
        [to]: { key: "synthetic-existing-account" },
      },
    });
    expect(repaired.warnings.join("\n")).toContain("Deferred stale auth profile alias");
    expect(repaired).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({
          category: "fix-now",
          fixHint: expect.stringContaining("preserve both"),
          docsUrl: "https://docs.openclaw.ai/cli/doctor/running#auth-migration-recovery",
        }),
      ]),
    });
  });
});

it("keeps an old selection unresolved when its source ID is recreated", async () => {
  await withFixture(async (fixture) => {
    const cfg = authConfig(authSelection("claude-cli", "claude-cli:work"));
    writeAuthFixture(
      fixture.env,
      undefined,
      authStore({ "claude-cli:work": apiKey("claude-cli", "original-account") }),
    );
    const run = () => runDoctor(cfg, fixture.env);
    await run();
    const replaced = authStore({
      "anthropic:work": apiKey("anthropic", "original-account"),
      "claude-cli:work": apiKey("claude-cli", "recreated-account"),
    });
    writeAuthFixture(fixture.env, undefined, replaced);
    const result = await run();
    expect(result.state.candidate.auth).toEqual(cfg.auth);
    expect(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toEqual(replaced);
    expect(result.warningNotes.join("\n")).toContain("identity is unresolved");
    expect(result.displayWarningNotes.join("\n")).not.toContain("identity is unresolved");
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "fix-now",
          fixHint: expect.stringContaining("models status"),
        }),
      ]),
    );
  });
});

it.each([
  {
    file: "auth.json",
    id: "claude-cli:default",
    provider: "claude-cli",
    canonical: "anthropic:default",
    flat: true,
  },
  {
    file: "auth-profiles.json",
    id: "google-gemini-cli:work",
    provider: "google-gemini-cli",
    canonical: "google:work",
    flat: false,
  },
])(
  "recovers $file imports when config was not saved",
  async ({ file, id, provider, canonical, flat }) => {
    await withFixture(async (fixture) => {
      const cfg = authConfig(authSelection(provider, id));
      const credential = apiKey(provider, "imported-account");
      await fixture.writeJson(
        "agents/main/agent/" + file,
        flat ? { [provider]: credential } : authStore({ [id]: credential }),
      );
      const run = () => runDoctor(cfg, fixture.env);
      await run();
      const saved = loadPersistedSharedAuthProfileStore(fixture.env);
      expect(saved?.profiles[canonical]?.type).toBe("api_key");
      const resumed = await run();
      expect(resumed.state.candidate.auth?.profiles).toEqual({
        [canonical]: { provider: flat ? "anthropic" : "google", mode: "api_key" },
      });
      expect(loadPersistedSharedAuthProfileStore(fixture.env)).toEqual(saved);
    });
  },
);

it("keeps the recorded target when import verification rolls back", async () => {
  await withFixture(async (fixture) => {
    const cfg = authConfig();
    await fixture.writeJson(
      "agents/main/agent/auth-profiles.json",
      authStore({ "claude-cli:work": apiKey("claude-cli", "retry-account") }),
    );
    const map = collectOpenAICodexAuthProfileStoreIdMap({ cfg, env: fixture.env });
    const result = await withPersistedAuthProfileStoreRead(
      () => null,
      () =>
        maybeMigrateAuthProfileJsonStoresToSqlite({
          cfg,
          env: fixture.env,
          prompter: { confirmAutoFix: async () => true },
          openAICodexAuthProfileIdMap: map,
        }),
    );
    expect(result.warnings.join("\n")).toContain("SQLite verification failed");
    const retryMap = collectOpenAICodexAuthProfileStoreIdMap({ cfg, env: fixture.env });
    expect(retryMap.get("claude-cli:work")).toBe("anthropic:work");
    await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg,
      env: fixture.env,
      prompter: { confirmAutoFix: async () => true },
      openAICodexAuthProfileIdMap: retryMap,
    });
    expect(loadPersistedSharedAuthProfileStore(fixture.env)?.profiles).toEqual({
      "anthropic:work": apiKey("anthropic", "retry-account"),
    });
  });
});

it.each(["main", "worker"])(
  "preserves a recovered shared selection when %s has a different local account",
  async (agentId) => {
    await withFixture(async (fixture) => {
      const agentDir = fixture.agentDir(agentId);
      const cfg = authConfig(authSelection("claude-cli", "claude-cli:default"), {
        entries: { main: {}, worker: { agentDir: fixture.agentDir("worker") } },
      });
      await fixture.writeJson("agents/main/agent/auth.json", {
        "claude-cli": apiKey("claude-cli", "original-shared-account"),
      });
      const run = (config: OpenClawConfig) => runDoctor(config, fixture.env);
      await run(cfg);
      const detected = detectSharedAuthStoreMigration({
        stateDir: fixture.stateDir,
        doctorOnlyStateMigrations: true,
      });
      await migrateSharedAuthStore({ detected, stateDir: fixture.stateDir, env: fixture.env });
      const local = authStore({
        "anthropic:default": apiKey("anthropic", "different-local-account"),
      });
      writeAuthFixture(fixture.env, agentDir, local);
      writeAuthFixture(
        fixture.env,
        undefined,
        authStore({
          "anthropic:default": apiKey("anthropic", "original-shared-account"),
          "codex:ready": apiKey("codex", "independent-account"),
        }),
      );
      const next: OpenClawConfig = {
        ...cfg,
        auth: {
          profiles: {
            "claude-cli:default": { provider: "claude-cli", mode: "api_key" },
            "codex:ready": { provider: "codex", mode: "api_key" },
          },
          order: { "claude-cli": ["claude-cli:default"], codex: ["codex:ready"] },
        },
      };
      const result = await run(next);
      expect(result.state.candidate.auth).toEqual({
        profiles: {
          "claude-cli:default": { provider: "claude-cli", mode: "api_key" },
          "openai:ready": { provider: "openai", mode: "api_key" },
        },
        order: { "claude-cli": ["claude-cli:default"], openai: ["openai:ready"] },
      });
      expect(readPersistedAuthProfileStoreRaw(agentDir)).toEqual(local);
      expect(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toMatchObject({
        profiles: {
          "anthropic:default": { key: "original-shared-account" },
          "openai:ready": { key: "independent-account" },
        },
      });
      expect(result.warningNotes.join("\n")).toContain("identity is unresolved");
    });
  },
);

it("recovers independently verified imports of the same alias across two stores", async () => {
  await withFixture(async (fixture) => {
    const workerDir = fixture.agentDir("worker");
    const cfg = authConfig(authSelection("claude-cli", "claude-cli:work"), {
      entries: { main: {}, worker: { agentDir: workerDir } },
    });
    for (const [agent, key] of [
      ["main", "shared-account"],
      ["worker", "local-account"],
    ] as const) {
      await fixture.writeJson(
        `agents/${agent}/agent/auth-profiles.json`,
        authStore({ "claude-cli:work": apiKey("claude-cli", key) }),
      );
    }
    const run = () => runDoctor(cfg, fixture.env);
    const first = await run();
    expect(first.findings).toEqual([]);
    expect(first.state.candidate.auth).toEqual({
      profiles: { "anthropic:work": { provider: "anthropic", mode: "api_key" } },
      order: { anthropic: ["anthropic:work"] },
    });
    const detected = detectSharedAuthStoreMigration({
      stateDir: fixture.stateDir,
      doctorOnlyStateMigrations: true,
    });
    await migrateSharedAuthStore({ detected, stateDir: fixture.stateDir, env: fixture.env });
    const retry = await run();
    expect(retry.findings).toEqual([]);
    expect(retry.state.candidate.auth).toEqual(first.state.candidate.auth);
    expect(loadPersistedSharedAuthProfileStore(fixture.env)?.profiles["anthropic:work"]).toEqual(
      apiKey("anthropic", "shared-account"),
    );
    expect(readPersistedAuthProfileStoreRaw(workerDir)).toMatchObject({
      profiles: {
        "anthropic:work": apiKey("anthropic", "local-account"),
      },
    });
  });
});
