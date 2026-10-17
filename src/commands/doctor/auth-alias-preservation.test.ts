import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveSharedAuthStorePath } from "../../agents/auth-profiles/path-resolve.js";
import * as authProfileSqlite from "../../agents/auth-profiles/sqlite.js";
import {
  readPersistedAuthProfileStateRaw as readLocalState,
  readPersistedAuthProfileStoreRaw as readLocalStore,
  readPersistedSharedAuthProfileStoreRaw as readSharedStore,
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
import {
  collectOpenAICodexAuthProfileStoreIdMap as collectIdMap,
  maybeRepairOpenAICodexAuthConfig as repairAuthConfig,
} from "../doctor-auth-flat-profiles.js";
import { recordAuthAliasMigration } from "./auth-alias-receipt.js";
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
    await withState("alias-deferred-owner", async (fixture) => {
      const legacyId = "claude-cli:work";
      const canonicalId = "anthropic:work";
      const inherited = invalid.includes("inherited");
      const separateOwner =
        inherited ||
        invalid === "uninspectable sibling owner" ||
        invalid === "opaque state-only owner";
      const agentDir = fixture.agentDir("worker");
      const cfg: OpenClawConfig = doctorConfig({
        ...(separateOwner ? { agents: { entries: { main: {}, worker: { agentDir } } } } : {}),
        auth: { profiles: { [legacyId]: { provider: "claude-cli", mode: "api_key" } } },
      });
      runAuthProfileWriteTransaction(
        undefined,
        (database) => {
          writePersistedAuthProfileStoreRaw(
            authStore({
              [legacyId]: { mode: "api_key", provider: "claude-cli", apiKey: "synthetic-key" },
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
      const repaired = await repairAuth(cfg, fixture.env, new Map([[legacyId, canonicalId]]));
      expect(repaired.profileIdMap.size).toBe(0);
      expect(readSharedStore(fixture.env)).toEqual(
        authStore({
          [legacyId]: apiKey("claude-cli", "synthetic-key"),
          ...(invalid === "sibling profile" ? { "unknown:future": 17 } : {}),
        }),
      );
      expect(repairAuthConfig(cfg, { profileIdMap: repaired.profileIdMap }).config.auth).toEqual(
        cfg.auth,
      );
      expect(listUserProfileAuthLinks(owner.id, { env: fixture.env })).toMatchObject([
        { provider: "anthropic", authProfileId: legacyId },
      ]);
      if (invalid === "inherited rotation reference") {
        await fixture.writeJson(
          "agents/main/agent/auth-profiles.json",
          authStore({
            [legacyId]: { mode: "api_key", provider: "claude-cli", apiKey: "synthetic-key" },
          }),
        );
        const imported = await importAuth(cfg, fixture.env, new Map([[legacyId, canonicalId]]));
        expect(imported.blockedProfileIds.has(legacyId)).toBe(true);
        expect(readSharedStore(fixture.env)).toMatchObject({
          profiles: { [legacyId]: apiKey("claude-cli", "synthetic-key") },
        });
        expect(readSharedStore(fixture.env)).not.toHaveProperty(["profiles", canonicalId]);
      }
    });
  });

  it("recovers an old rename receipt across normalized and rolled-back credential owners", async () => {
    await withState("alias-field-recovery", async (fixture) => {
      const agentDir = fixture.agentDir("worker");
      const cfg: OpenClawConfig = doctorConfig({
        agents: { entries: { main: {}, worker: { agentDir } } },
      });
      const legacyId = "claude-cli:work";
      const canonicalId = "anthropic:work";
      const source = authStore({
        [legacyId]: { mode: "api_key", provider: "claude-cli", apiKey: "synthetic-original" },
      });
      const renamed = authStore({
        [canonicalId]: { mode: "api_key", provider: "anthropic", apiKey: "synthetic-original" },
      });
      const write = (owner: string | undefined, store: unknown) =>
        writeStore(fixture.env, store, owner);
      const repair = (profileIdMap = new Map<string, string>()) =>
        repairAuth(cfg, fixture.env, profileIdMap);
      const collect = () => collectIdMap({ cfg, env: fixture.env });
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
      expect(readLocalStore(agentDir)).toEqual(source);
      expect(readSharedStore(fixture.env)).toEqual(renamed);
      // Model the partial commit left by independent database owners. Its
      // normalization fingerprint must survive the failed write transaction.
      // Keep Doctor's property order because the receipt hashes exact JSON.
      write(
        agentDir,
        authStore({
          [canonicalId]: { provider: "anthropic", type: "api_key", key: "synthetic-original" },
        }),
      );
      expect(collect().get(legacyId)).toBe(canonicalId);
      await repair();
      expect(readLocalStore(agentDir)).toEqual(
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
      await withState("alias-config-recovery", async (fixture) => {
        const agentDir = fixture.agentDir("worker");
        const cfg: OpenClawConfig = doctorConfig({
          agents: { entries: { main: {}, worker: { agentDir } } },
          auth: {
            profiles: { "openai-codex:work": { provider: "openai-codex", mode: "api_key" } },
            order: { "openai-codex": ["openai-codex:work"] },
          },
        });
        writeStore(
          fixture.env,
          authStore({ "openai-codex:work": apiKey("openai-codex", "synthetic-original-account") }),
        );
        const workerStore = authStore({
          "openai-codex:work": apiKey("openai-codex", "synthetic-worker-account"),
        });
        writeStore(fixture.env, workerStore, agentDir);
        const run = () => runRepair(cfg, { env: fixture.env });
        // The durable store commit survives even when the caller cannot save this candidate.
        await run();
        expect(readSharedStore(fixture.env)).toMatchObject({
          profiles: { "openai:work": { provider: "openai", key: "synthetic-original-account" } },
        });
        if (replaceAccount) {
          writeStore(
            fixture.env,
            authStore({ "openai:work": apiKey("openai", "synthetic-replacement-account") }),
          );
        } else {
          // A stopped multi-store pass can leave one owner at its recorded pre-migration state.
          writeStore(fixture.env, workerStore, agentDir);
        }
        const resumed = await run();
        if (replaceAccount) {
          expect(resumed.state.candidate.auth).toEqual(cfg.auth);
          expect(readSharedStore(fixture.env)).toMatchObject({
            profiles: { "openai:work": { key: "synthetic-replacement-account" } },
          });
        } else {
          expect(resumed.state.candidate.auth).toEqual({
            profiles: { "openai:work": { provider: "openai", mode: "api_key" } },
            order: { openai: ["openai:work"] },
          });
          expect(resumed.openAICodexAuthProfileIdMap?.get("openai-codex:work")).toBe("openai:work");
          expect(readLocalStore(agentDir)).toMatchObject({
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
      await withState("alias-session", async (fixture) => {
        const agentDir = fixture.agentDir("worker");
        const cfg: OpenClawConfig = doctorConfig({
          agents: { entries: { main: {}, worker: { agentDir } } },
          auth: { profiles: { [id]: { provider, mode: "api_key" } } },
        });
        writeStore(
          fixture.env,
          authStore({ [id]: apiKey(provider, "synthetic-session-key") }),
          owner === "shared" ? undefined : agentDir,
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
        const repaired = await runRepair(cfg, { env: fixture.env });
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
    await withState("alias-inherited-state", async (fixture) => {
      const agentDir = fixture.agentDir("worker");
      const cfg: OpenClawConfig = doctorConfig();
      const shared = authStore({
        "openai-codex:work": apiKey("openai-codex", "synthetic-shared-key"),
      });
      writeStore(fixture.env, shared);
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
      const profileIdMap = collectIdMap({ cfg, env: fixture.env });
      expect(profileIdMap.get("openai-codex:work")).toBe("openai:work");
      const currentState = {
        version: 1,
        usageStats: { "openai-codex:work": { errorCount: 2 }, "openai:work": { errorCount: 99 } },
      };
      runAuthProfileWriteTransaction(
        agentDir,
        (database) => {
          writePersistedAuthProfileStateRaw(currentState, agentDir, database);
        },
        { env: fixture.env },
      );
      const result = await repairAuth(cfg, fixture.env, profileIdMap);
      expect(result.changes).toEqual([]);
      expect(result.profileIdMap.size).toBe(0);
      expect(readSharedStore(fixture.env)).toEqual(shared);
      expect(readLocalState(agentDir)).toEqual(currentState);
    });
  });

  it("preserves a blocked custom account order while an independent account migrates", async () => {
    await withState("alias-custom-order", async (fixture) => {
      const blocked = {
        type: "api_key",
        provider: "claude-cli",
        key: "synthetic-realm-key",
        issuer: "https://fixture.invalid/issuer",
      };
      const cfg: OpenClawConfig = doctorConfig({
        auth: {
          profiles: {
            "work-account": { provider: "claude-cli", mode: "api_key" },
            "codex:ready": { provider: "codex", mode: "api_key" },
          },
          order: { "claude-cli": ["work-account"], codex: ["codex:ready"] },
        },
      });
      writeStore(
        fixture.env,
        authStore(
          { "work-account": blocked, "codex:ready": apiKey("codex", "synthetic-ready-key") },
          { order: cfg.auth?.order },
        ),
      );
      const result = await runRepair(cfg, { env: fixture.env });
      expect(result.state.candidate.auth?.order).toEqual({
        "claude-cli": ["work-account"],
        openai: ["openai:ready"],
      });
      expect(readSharedStore(fixture.env)).toMatchObject({
        profiles: {
          "work-account": blocked,
          "openai:ready": { provider: "openai", key: "synthetic-ready-key" },
        },
        order: { "claude-cli": ["work-account"], openai: ["openai:ready"] },
      });
    });
  });
});
