import { describe, expect, it } from "vitest";
import {
  loadPersistedAuthProfileStore,
  loadPersistedSharedAuthProfileStore,
} from "../../agents/auth-profiles/persisted.js";
import {
  closeAuthProfileReadPool,
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
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import {
  collectOpenAICodexAuthProfileStoreIdMap,
  maybeRepairLegacyAuthProfileStores,
  maybeRepairOpenAICodexAuthConfig,
} from "../doctor-auth-flat-profiles.js";
import { runDoctorRepairSequence } from "./repair-sequencing.js";

describe("Doctor stored auth alias migration", () => {
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
        runAuthProfileWriteTransaction(
          agentDir,
          (database) => {
            writePersistedAuthProfileStoreRaw(original, agentDir, database);
          },
          { env: fixture.env },
        );

        const profileIdMap = collectOpenAICodexAuthProfileStoreIdMap({ cfg, env: fixture.env });
        const result = maybeRepairLegacyAuthProfileStores({ cfg, env: fixture.env, profileIdMap });
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
          maybeRepairLegacyAuthProfileStores({
            cfg: config,
            env: fixture.env,
            profileIdMap: repeatMap,
          }).changes,
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
      runAuthProfileWriteTransaction(
        undefined,
        (database) => {
          writePersistedAuthProfileStoreRaw("unreadable-store-shape", undefined, database);
        },
        { env: fixture.env },
      );
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
      runAuthProfileWriteTransaction(
        fixture.agentDir("broken"),
        (database) => {
          writePersistedAuthProfileStoreRaw(invalid, fixture.agentDir("broken"), database);
        },
        { env: fixture.env },
      );
      const profileIdMap = collectOpenAICodexAuthProfileStoreIdMap({ cfg, env: fixture.env });
      const result = maybeRepairLegacyAuthProfileStores({ cfg, env: fixture.env, profileIdMap });
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
        runAuthProfileWriteTransaction(
          undefined,
          (database) => {
            writePersistedAuthProfileStoreRaw(original, undefined, database);
          },
          { env: fixture.env },
        );
        const profileIdMap = collectOpenAICodexAuthProfileStoreIdMap({ cfg, env: fixture.env });
        const result = maybeRepairLegacyAuthProfileStores({ cfg, env: fixture.env, profileIdMap });
        expect(result.changes).toEqual([]);
        expect(result.warnings.join("\n")).toContain("realm or identity is unresolved");
        expect(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toEqual(original);
      });
    },
  );

  it("rejects a stale collision map before changing stored credentials", async () => {
    await withOpenClawTestState({ label: "alias-stale-map", layout: "home" }, async (fixture) => {
      const cfg: OpenClawConfig = { plugins: { enabled: false } };
      const original = {
        version: 1,
        profiles: {
          "openai-codex:work": { type: "api_key", provider: "openai-codex", key: "old-key" },
        },
      };
      runAuthProfileWriteTransaction(
        undefined,
        (database) => {
          writePersistedAuthProfileStoreRaw(original, undefined, database);
        },
        { env: fixture.env },
      );
      const profileIdMap = collectOpenAICodexAuthProfileStoreIdMap({ cfg, env: fixture.env });
      const current = {
        ...original,
        profiles: {
          ...original.profiles,
          "openai:work": { type: "api_key", provider: "openai", key: "new-account-key" },
        },
      };
      runAuthProfileWriteTransaction(
        undefined,
        (database) => {
          writePersistedAuthProfileStoreRaw(current, undefined, database);
        },
        { env: fixture.env },
      );
      const result = maybeRepairLegacyAuthProfileStores({ cfg, env: fixture.env, profileIdMap });
      expect(result.changes).toEqual([]);
      expect(result.profileIdMap.size).toBe(0);
      expect(result.warnings.join("\n")).toContain("target is occupied");
      expect(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toEqual(current);
    });
  });

  it("rejects a stale rotation-state map before replacing newer metadata", async () => {
    await withOpenClawTestState({ label: "alias-stale-state", layout: "home" }, async (fixture) => {
      const cfg: OpenClawConfig = { plugins: { enabled: false } };
      const original = {
        version: 1,
        profiles: {
          "openai-codex:work": { type: "api_key", provider: "openai-codex", key: "old-key" },
        },
      };
      runAuthProfileWriteTransaction(
        undefined,
        (database) => {
          writePersistedAuthProfileStoreRaw(original, undefined, database);
        },
        { env: fixture.env },
      );
      const profileIdMap = collectOpenAICodexAuthProfileStoreIdMap({ cfg, env: fixture.env });
      const currentState = {
        version: 1,
        usageStats: {
          "openai-codex:work": { errorCount: 2 },
          "openai:work": { errorCount: 99 },
        },
      };
      runAuthProfileWriteTransaction(
        undefined,
        (database) => {
          writePersistedAuthProfileStateRaw(currentState, undefined, database);
        },
        { env: fixture.env },
      );
      const result = maybeRepairLegacyAuthProfileStores({ cfg, env: fixture.env, profileIdMap });
      expect.soft(result.changes).toEqual([]);
      expect.soft(result.profileIdMap.size).toBe(0);
      expect.soft(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toEqual(original);
      expect.soft(readPersistedSharedAuthProfileStateRaw(fixture.env)).toEqual(currentState);
    });
  });

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
