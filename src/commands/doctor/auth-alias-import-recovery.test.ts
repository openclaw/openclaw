import { expect, it } from "vitest";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "../../agents/auth-profiles/credential-fixtures.test-support.js";
import { loadPersistedSharedAuthProfileStore } from "../../agents/auth-profiles/persisted.js";
import {
  readPersistedAuthProfileStoreRaw,
  readPersistedSharedAuthProfileStoreRaw,
  runAuthProfileWriteTransaction,
  writePersistedAuthProfileStoreRaw,
} from "../../agents/auth-profiles/sqlite.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  detectSharedAuthStoreMigration,
  migrateSharedAuthStore,
} from "../../infra/state-migrations.shared-auth-store.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  collectOpenAICodexAuthProfileStoreIdMap,
  maybeMigrateAuthProfileJsonStoresToSqlite,
} from "../doctor-auth-flat-profiles.js";
import { runDoctorRepairSequence } from "./repair-sequencing.js";

it("keeps an old selection unresolved when its source ID is recreated", async () => {
  await withOpenClawTestState({ label: "alias-recreated", layout: "home" }, async (fixture) => {
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      auth: {
        profiles: { "claude-cli:work": { provider: "claude-cli", mode: "api_key" } },
        order: { "claude-cli": ["claude-cli:work"] },
      },
    };
    runAuthProfileWriteTransaction(
      undefined,
      (database) => {
        writePersistedAuthProfileStoreRaw(
          {
            version: 1,
            profiles: {
              "claude-cli:work": {
                type: "api_key",
                provider: "claude-cli",
                key: "original-account",
              },
            },
          },
          undefined,
          database,
        );
      },
      { env: fixture.env },
    );
    const run = () =>
      runDoctorRepairSequence({
        state: { cfg, candidate: structuredClone(cfg), pendingChanges: false, fixHints: [] },
        doctorFixCommand: "openclaw doctor --fix",
        env: fixture.env,
      });
    await run();
    const replaced = {
      version: 1,
      profiles: {
        "anthropic:work": { type: "api_key", provider: "anthropic", key: "original-account" },
        "claude-cli:work": { type: "api_key", provider: "claude-cli", key: "recreated-account" },
      },
    };
    runAuthProfileWriteTransaction(
      undefined,
      (database) => {
        writePersistedAuthProfileStoreRaw(replaced, undefined, database);
      },
      { env: fixture.env },
    );
    const result = await run();
    expect(result.state.candidate.auth).toEqual(cfg.auth);
    expect(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toEqual(replaced);
    expect(result.warningNotes.join("\n")).toContain("identity is unresolved");
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
    await withOpenClawTestState(
      { label: "alias-import-retry", layout: "home" },
      async (fixture) => {
        const cfg: OpenClawConfig = {
          plugins: { enabled: false },
          auth: {
            profiles: { [id]: { provider, mode: "api_key" } },
            order: { [provider]: [id] },
          },
        };
        const credential = { type: "api_key", provider, key: "imported-account" };
        await fixture.writeJson(
          "agents/main/agent/" + file,
          flat ? { [provider]: credential } : { version: 1, profiles: { [id]: credential } },
        );
        const run = () =>
          runDoctorRepairSequence({
            state: { cfg, candidate: structuredClone(cfg), pendingChanges: false, fixHints: [] },
            doctorFixCommand: "openclaw doctor --fix",
            env: fixture.env,
          });
        await run();
        const saved = loadPersistedSharedAuthProfileStore(fixture.env);
        expect(saved?.profiles[canonical]?.type).toBe("api_key");
        const resumed = await run();
        expect(resumed.state.candidate.auth?.profiles).toEqual({
          [canonical]: { provider: flat ? "anthropic" : "google", mode: "api_key" },
        });
        expect(loadPersistedSharedAuthProfileStore(fixture.env)).toEqual(saved);
      },
    );
  },
);

it("keeps the recorded target when import verification rolls back", async () => {
  await withOpenClawTestState(
    { label: "alias-import-rollback", layout: "home" },
    async (fixture) => {
      const cfg: OpenClawConfig = { plugins: { enabled: false } };
      await fixture.writeJson("agents/main/agent/auth-profiles.json", {
        version: 1,
        profiles: {
          "claude-cli:work": { type: "api_key", provider: "claude-cli", key: "retry-account" },
        },
      });
      const map = collectOpenAICodexAuthProfileStoreIdMap({ cfg, env: fixture.env });
      const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
        cfg,
        env: fixture.env,
        prompter: { confirmAutoFix: async () => true },
        openAICodexAuthProfileIdMap: map,
        deps: { loadPersistedAuthProfileStore: () => null },
      });
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
        "anthropic:work": { type: "api_key", provider: "anthropic", key: "retry-account" },
      });
    },
  );
});

it.each(["main", "worker"])(
  "preserves a recovered shared selection when %s has a different local account",
  async (agentId) => {
    await withOpenClawTestState(
      { label: "alias-archive-local-collision", layout: "home" },
      async (fixture) => {
        const agentDir = fixture.agentDir(agentId);
        const cfg: OpenClawConfig = {
          plugins: { enabled: false },
          agents: { entries: { main: {}, worker: { agentDir: fixture.agentDir("worker") } } },
          auth: {
            profiles: { "claude-cli:default": { provider: "claude-cli", mode: "api_key" } },
            order: { "claude-cli": ["claude-cli:default"] },
          },
        };
        await fixture.writeJson("agents/main/agent/auth.json", {
          "claude-cli": { type: "api_key", provider: "claude-cli", key: "original-shared-account" },
        });
        const run = (config: OpenClawConfig) =>
          runDoctorRepairSequence({
            state: {
              cfg: config,
              candidate: structuredClone(config),
              pendingChanges: false,
              fixHints: [],
            },
            doctorFixCommand: "openclaw doctor --fix",
            env: fixture.env,
          });
        await run(cfg);
        const detected = detectSharedAuthStoreMigration({
          stateDir: fixture.stateDir,
          doctorOnlyStateMigrations: true,
        });
        await migrateSharedAuthStore({ detected, stateDir: fixture.stateDir, env: fixture.env });
        const local = createAuthProfileStoreFixture({
          "anthropic:default": createApiKeyCredential("anthropic", "different-local-account"),
        });
        runAuthProfileWriteTransaction(
          agentDir,
          (database) => {
            writePersistedAuthProfileStoreRaw(local, agentDir, database);
          },
          { env: fixture.env },
        );
        runAuthProfileWriteTransaction(
          undefined,
          (database) => {
            writePersistedAuthProfileStoreRaw(
              {
                version: 1,
                profiles: {
                  "anthropic:default": {
                    type: "api_key",
                    provider: "anthropic",
                    key: "original-shared-account",
                  },
                  "codex:ready": { type: "api_key", provider: "codex", key: "independent-account" },
                },
              },
              undefined,
              database,
            );
          },
          { env: fixture.env },
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
      },
    );
  },
);

it("recovers independently verified imports of the same alias across two stores", async () => {
  await withOpenClawTestState({ label: "alias-two-imports", layout: "home" }, async (fixture) => {
    const workerDir = fixture.agentDir("worker");
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      agents: { entries: { main: {}, worker: { agentDir: workerDir } } },
      auth: {
        profiles: { "claude-cli:work": { provider: "claude-cli", mode: "api_key" } },
        order: { "claude-cli": ["claude-cli:work"] },
      },
    };
    for (const [agent, key] of [
      ["main", "shared-account"],
      ["worker", "local-account"],
    ]) {
      await fixture.writeJson(`agents/${agent}/agent/auth-profiles.json`, {
        version: 1,
        profiles: { "claude-cli:work": { type: "api_key", provider: "claude-cli", key } },
      });
    }
    const run = () =>
      runDoctorRepairSequence({
        state: { cfg, candidate: structuredClone(cfg), pendingChanges: false, fixHints: [] },
        doctorFixCommand: "openclaw doctor --fix",
        env: fixture.env,
      });
    const first = await run();
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
    expect(retry.state.candidate.auth).toEqual(first.state.candidate.auth);
    expect(loadPersistedSharedAuthProfileStore(fixture.env)?.profiles["anthropic:work"]).toEqual({
      type: "api_key",
      provider: "anthropic",
      key: "shared-account",
    });
    expect(readPersistedAuthProfileStoreRaw(workerDir)).toMatchObject({
      profiles: {
        "anthropic:work": { type: "api_key", provider: "anthropic", key: "local-account" },
      },
    });
  });
});
