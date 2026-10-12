import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveSharedAuthStorePath } from "../../agents/auth-profiles/path-resolve.js";
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
import { recordAuthAliasMigration } from "./auth-alias-receipt.js";
import { runDoctorRepairSequence } from "./repair-sequencing.js";
import { maybeRepairCodexSessionRoutes } from "./shared/codex-route-session-repair.js";

describe("Doctor auth alias preservation", () => {
  it.each([
    "rotation state",
    "sibling profile",
    "inherited rotation reference",
    "opaque inherited rotation state",
    "uninspectable sibling owner",
    "opaque state-only owner",
  ])("defers dependent aliases when %s cannot be renamed", async (invalid) => {
    await withOpenClawTestState(
      { label: "alias-deferred-owner", layout: "home" },
      async (fixture) => {
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
              {
                version: 1,
                profiles: {
                  [legacyId]: {
                    mode: "api_key",
                    provider: "claude-cli",
                    apiKey: "synthetic-key",
                  },
                  ...(invalid === "sibling profile" ? { "unknown:future": 17 } : {}),
                },
              },
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
                    : { version: 1, profiles: { "unknown:future": 17 } },
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
        expect(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toEqual({
          version: 1,
          profiles: {
            [legacyId]: { type: "api_key", provider: "claude-cli", key: "synthetic-key" },
            ...(invalid === "sibling profile" ? { "unknown:future": 17 } : {}),
          },
        });
        expect(
          maybeRepairOpenAICodexAuthConfig(cfg, { profileIdMap: repaired.profileIdMap }).config
            .auth,
        ).toEqual(cfg.auth);
        expect(listUserProfileAuthLinks(owner.id, { env: fixture.env })).toMatchObject([
          { provider: "anthropic", authProfileId: legacyId },
        ]);
        if (invalid === "inherited rotation reference") {
          await fixture.writeJson("agents/main/agent/auth-profiles.json", {
            version: 1,
            profiles: {
              [legacyId]: { mode: "api_key", provider: "claude-cli", apiKey: "synthetic-key" },
            },
          });
          const imported = await maybeMigrateAuthProfileJsonStoresToSqlite({
            cfg,
            env: fixture.env,
            prompter: { confirmAutoFix: async () => true },
            openAICodexAuthProfileIdMap: new Map([[legacyId, canonicalId]]),
          });
          expect(imported.blockedProfileIds.has(legacyId)).toBe(true);
          expect(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toMatchObject({
            profiles: {
              [legacyId]: { type: "api_key", provider: "claude-cli", key: "synthetic-key" },
            },
          });
          expect(readPersistedSharedAuthProfileStoreRaw(fixture.env)).not.toHaveProperty([
            "profiles",
            canonicalId,
          ]);
        }
      },
    );
  });

  it("recovers an old rename receipt across normalized and rolled-back credential owners", async () => {
    await withOpenClawTestState(
      { label: "alias-field-recovery", layout: "home" },
      async (fixture) => {
        const agentDir = fixture.agentDir("worker");
        const cfg: OpenClawConfig = {
          plugins: { enabled: false },
          agents: { entries: { main: {}, worker: { agentDir } } },
        };
        const legacyId = "claude-cli:work";
        const canonicalId = "anthropic:work";
        const source = {
          version: 1,
          profiles: {
            [legacyId]: { mode: "api_key", provider: "claude-cli", apiKey: "synthetic-original" },
          },
        };
        const renamed = {
          version: 1,
          profiles: {
            [canonicalId]: { mode: "api_key", provider: "anthropic", apiKey: "synthetic-original" },
          },
        };
        const write = (owner: string | undefined, store: unknown) =>
          runAuthProfileWriteTransaction(
            owner,
            (database) => {
              writePersistedAuthProfileStoreRaw(store, owner, database);
            },
            { env: fixture.env },
          );
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
          await expect(
            maybeRepairLegacyAuthProfileStores({
              cfg,
              env: fixture.env,
              profileIdMap: new Map([[legacyId, canonicalId]]),
            }),
          ).rejects.toThrow("synthetic persistence failure");
        } finally {
          failedWrite.mockRestore();
        }
        expect(readPersistedAuthProfileStoreRaw(agentDir)).toEqual(source);
        expect(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toEqual(renamed);
        // Model the partial commit left by independent database owners. Its
        // normalization fingerprint must survive the failed write transaction.
        // Keep Doctor's property order because the receipt hashes exact JSON.
        write(agentDir, {
          version: 1,
          profiles: {
            [canonicalId]: { provider: "anthropic", type: "api_key", key: "synthetic-original" },
          },
        });
        expect(
          collectOpenAICodexAuthProfileStoreIdMap({ cfg, env: fixture.env }).get(legacyId),
        ).toBe(canonicalId);
        await maybeRepairLegacyAuthProfileStores({
          cfg,
          env: fixture.env,
          profileIdMap: new Map(),
        });
        expect(readPersistedAuthProfileStoreRaw(agentDir)).toEqual({
          version: 1,
          profiles: {
            [canonicalId]: { type: "api_key", provider: "anthropic", key: "synthetic-original" },
          },
        });
        expect(
          collectOpenAICodexAuthProfileStoreIdMap({ cfg, env: fixture.env }).get(legacyId),
        ).toBe(canonicalId);
        // A rollback or interrupted multi-owner commit can leave the other owner on its exact preimage.
        write(agentDir, renamed);
        expect(
          collectOpenAICodexAuthProfileStoreIdMap({ cfg, env: fixture.env }).get(legacyId),
        ).toBe(canonicalId);
        await maybeRepairLegacyAuthProfileStores({
          cfg,
          env: fixture.env,
          profileIdMap: new Map(),
        });
        expect(
          (
            await maybeRepairLegacyAuthProfileStores({
              cfg,
              env: fixture.env,
              profileIdMap: new Map(),
            })
          ).changes,
        ).toEqual([]);
        const owner = ensureGatewayOwnerProfile(null, { env: fixture.env });
        setUserProfileAuthLink(
          { profileId: owner.id, provider: "anthropic", authProfileId: legacyId },
          { env: fixture.env },
        );
        const recovered = collectOpenAICodexAuthProfileStoreIdMap({ cfg, env: fixture.env });
        await maybeRepairLegacyAuthProfileStores({
          cfg,
          env: fixture.env,
          profileIdMap: recovered,
        });
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
          expect(
            (
              await maybeRepairLegacyAuthProfileStores({
                cfg,
                env: fixture.env,
                profileIdMap: recovered,
              })
            ).changes,
          ).toEqual([]);
        } finally {
          clock.mockRestore();
        }
        expect(receiptTimes()).toEqual(previousTimes);
        write(agentDir, {
          version: 1,
          profiles: {
            [canonicalId]: {
              type: "api_key",
              provider: "anthropic",
              key: "synthetic-different-account",
            },
          },
        });
        expect(
          collectOpenAICodexAuthProfileStoreIdMap({ cfg, env: fixture.env }).has(legacyId),
        ).toBe(false);
      },
    );
  });

  it.each([false, true])(
    "recovers a failed config write without adopting a changed account (%s)",
    async (replaceAccount) => {
      await withOpenClawTestState(
        { label: "alias-config-recovery", layout: "home" },
        async (fixture) => {
          const agentDir = fixture.agentDir("worker");
          const cfg: OpenClawConfig = {
            plugins: { enabled: false },
            agents: { entries: { main: {}, worker: { agentDir } } },
            auth: {
              profiles: { "openai-codex:work": { provider: "openai-codex", mode: "api_key" } },
              order: { "openai-codex": ["openai-codex:work"] },
            },
          };
          runAuthProfileWriteTransaction(
            undefined,
            (database) => {
              writePersistedAuthProfileStoreRaw(
                {
                  version: 1,
                  profiles: {
                    "openai-codex:work": {
                      type: "api_key",
                      provider: "openai-codex",
                      key: "synthetic-original-account",
                    },
                  },
                },
                undefined,
                database,
              );
            },
            { env: fixture.env },
          );
          const workerStore = {
            version: 1,
            profiles: {
              "openai-codex:work": {
                type: "api_key",
                provider: "openai-codex",
                key: "synthetic-worker-account",
              },
            },
          };
          runAuthProfileWriteTransaction(
            agentDir,
            (database) => {
              writePersistedAuthProfileStoreRaw(workerStore, agentDir, database);
            },
            { env: fixture.env },
          );
          const run = () =>
            runDoctorRepairSequence({
              state: { cfg, candidate: structuredClone(cfg), pendingChanges: false, fixHints: [] },
              doctorFixCommand: "openclaw doctor --fix",
              env: fixture.env,
            });
          // The durable store commit survives even when the caller cannot save this candidate.
          await run();
          expect(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toMatchObject({
            profiles: { "openai:work": { provider: "openai", key: "synthetic-original-account" } },
          });
          if (replaceAccount) {
            runAuthProfileWriteTransaction(
              undefined,
              (database) => {
                writePersistedAuthProfileStoreRaw(
                  {
                    version: 1,
                    profiles: {
                      "openai:work": {
                        type: "api_key",
                        provider: "openai",
                        key: "synthetic-replacement-account",
                      },
                    },
                  },
                  undefined,
                  database,
                );
              },
              { env: fixture.env },
            );
          } else {
            // A stopped multi-store pass can leave one owner at its recorded pre-migration state.
            runAuthProfileWriteTransaction(
              agentDir,
              (database) => {
                writePersistedAuthProfileStoreRaw(workerStore, agentDir, database);
              },
              { env: fixture.env },
            );
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
            expect(resumed.openAICodexAuthProfileIdMap?.get("openai-codex:work")).toBe(
              "openai:work",
            );
            expect(readPersistedAuthProfileStoreRaw(agentDir)).toMatchObject({
              profiles: { "openai:work": { provider: "openai", key: "synthetic-worker-account" } },
            });
          }
        },
      );
    },
  );
  it.each([
    ["claude-cli:work", "claude-cli", "anthropic:work", "shared"],
    ["google-gemini-cli:work", "google-gemini-cli", "google:work", "agent"],
  ])(
    "keeps the selected session account when migrating %s",
    async (id, provider, canonical, owner) => {
      await withOpenClawTestState({ label: "alias-session", layout: "home" }, async (fixture) => {
        const agentDir = fixture.agentDir("worker");
        const cfg: OpenClawConfig = {
          plugins: { enabled: false },
          agents: { entries: { main: {}, worker: { agentDir } } },
          auth: { profiles: { [id]: { provider, mode: "api_key" } } },
        };
        runAuthProfileWriteTransaction(
          owner === "shared" ? undefined : agentDir,
          (database) => {
            writePersistedAuthProfileStoreRaw(
              {
                version: 1,
                profiles: { [id]: { type: "api_key", provider, key: "synthetic-session-key" } },
              },
              owner === "shared" ? undefined : agentDir,
              database,
            );
          },
          { env: fixture.env },
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
        const repaired = await runDoctorRepairSequence({
          state: { cfg, candidate: structuredClone(cfg), pendingChanges: false, fixHints: [] },
          doctorFixCommand: "openclaw doctor --fix",
          env: fixture.env,
        });
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
    await withOpenClawTestState(
      { label: "alias-inherited-state", layout: "home" },
      async (fixture) => {
        const agentDir = fixture.agentDir("worker");
        const cfg: OpenClawConfig = { plugins: { enabled: false } };
        const shared = {
          version: 1,
          profiles: {
            "openai-codex:work": {
              type: "api_key",
              provider: "openai-codex",
              key: "synthetic-shared-key",
            },
          },
        };
        runAuthProfileWriteTransaction(
          undefined,
          (database) => {
            writePersistedAuthProfileStoreRaw(shared, undefined, database);
          },
          { env: fixture.env },
        );
        runAuthProfileWriteTransaction(
          agentDir,
          (database) => {
            writePersistedAuthProfileStateRaw(
              { version: 1, usageStats: { "openai-codex:work": { errorCount: 2 } } },
              agentDir,
              database,
            );
          },
          { env: fixture.env },
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
        runAuthProfileWriteTransaction(
          agentDir,
          (database) => {
            writePersistedAuthProfileStateRaw(currentState, agentDir, database);
          },
          { env: fixture.env },
        );
        const result = await maybeRepairLegacyAuthProfileStores({
          cfg,
          env: fixture.env,
          profileIdMap,
        });
        expect(result.changes).toEqual([]);
        expect(result.profileIdMap.size).toBe(0);
        expect(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toEqual(shared);
        expect(readPersistedAuthProfileStateRaw(agentDir)).toEqual(currentState);
      },
    );
  });

  it("preserves a blocked custom account order while an independent account migrates", async () => {
    await withOpenClawTestState(
      { label: "alias-custom-order", layout: "home" },
      async (fixture) => {
        const blocked = {
          type: "api_key",
          provider: "claude-cli",
          key: "synthetic-realm-key",
          issuer: "https://fixture.invalid/issuer",
        };
        const cfg: OpenClawConfig = {
          plugins: { enabled: false },
          auth: {
            profiles: {
              "work-account": { provider: "claude-cli", mode: "api_key" },
              "codex:ready": { provider: "codex", mode: "api_key" },
            },
            order: { "claude-cli": ["work-account"], codex: ["codex:ready"] },
          },
        };
        runAuthProfileWriteTransaction(
          undefined,
          (database) => {
            writePersistedAuthProfileStoreRaw(
              {
                version: 1,
                profiles: {
                  "work-account": blocked,
                  "codex:ready": { type: "api_key", provider: "codex", key: "synthetic-ready-key" },
                },
                order: cfg.auth?.order,
              },
              undefined,
              database,
            );
          },
          { env: fixture.env },
        );
        const result = await runDoctorRepairSequence({
          state: { cfg, candidate: structuredClone(cfg), pendingChanges: false, fixHints: [] },
          doctorFixCommand: "openclaw doctor --fix",
          env: fixture.env,
        });
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
      },
    );
  });
});
