import { expect, it } from "vitest";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "../../agents/auth-profiles/credential-fixtures.test-support.js";
import { loadPersistedSharedAuthProfileStore as loadSharedStore } from "../../agents/auth-profiles/persisted.js";
import {
  readPersistedAuthProfileStoreRaw as readLocalStore,
  readPersistedSharedAuthProfileStoreRaw as readSharedStore,
} from "../../agents/auth-profiles/sqlite.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  detectSharedAuthStoreMigration,
  migrateSharedAuthStore,
} from "../../infra/state-migrations.shared-auth-store.js";
import { collectOpenAICodexAuthProfileStoreIdMap as collectIdMap } from "../doctor-auth-flat-profiles.js";
import { withPersistedAuthProfileStoreRead } from "../doctor-auth-flat-profiles.test-support.js";
import {
  withState,
  runRepair,
  apiKey,
  authStore,
  writeStore,
  importAuth,
  doctorConfig,
} from "./auth-alias.test-support.js";
import { repairAuthProfileMigration } from "./auth-profile-repair.js";

it("repairs credential fields while deferring an occupied JSON alias destination", async () => {
  await withState("alias-stale-json-destination", async (fixture) => {
    const from = "claude-cli:work";
    const to = "anthropic:work";
    const cfg: OpenClawConfig = doctorConfig({
      auth: { profiles: { [from]: { provider: "claude-cli", mode: "api_key" } } },
    });
    writeStore(
      fixture.env,
      authStore({
        [to]: { mode: "api_key", provider: "anthropic", apiKey: "synthetic-existing-account" },
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
    expect(loadSharedStore(fixture.env)?.profiles).toEqual({
      [from]: apiKey("claude-cli", "synthetic-imported-account"),
      [to]: apiKey("anthropic", "synthetic-existing-account"),
      "example:legacy": apiKey("example", "synthetic-independent-account"),
    });
    expect(readSharedStore(fixture.env)).toMatchObject({
      profiles: {
        [from]: { key: "synthetic-imported-account" },
        [to]: { key: "synthetic-existing-account" },
      },
    });
    expect(repaired.warnings.join("\n")).toContain("Deferred stale auth profile alias");
  });
});

it("keeps an old selection unresolved when its source ID is recreated", async () => {
  await withState("alias-recreated", async (fixture) => {
    const cfg: OpenClawConfig = doctorConfig({
      auth: {
        profiles: { "claude-cli:work": { provider: "claude-cli", mode: "api_key" } },
        order: { "claude-cli": ["claude-cli:work"] },
      },
    });
    writeStore(
      fixture.env,
      authStore({ "claude-cli:work": apiKey("claude-cli", "original-account") }),
    );
    const run = () => runRepair(cfg, { env: fixture.env });
    await run();
    const replaced = authStore({
      "anthropic:work": apiKey("anthropic", "original-account"),
      "claude-cli:work": apiKey("claude-cli", "recreated-account"),
    });
    writeStore(fixture.env, replaced);
    const result = await run();
    expect(result.state.candidate.auth).toEqual(cfg.auth);
    expect(readSharedStore(fixture.env)).toEqual(replaced);
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
  await withState("alias-import-rollback", async (fixture) => {
    const cfg: OpenClawConfig = doctorConfig();
    await fixture.writeJson(
      "agents/main/agent/auth-profiles.json",
      authStore({ "claude-cli:work": apiKey("claude-cli", "retry-account") }),
    );
    const map = collectIdMap({ cfg, env: fixture.env });
    const result = await withPersistedAuthProfileStoreRead(
      () => null,
      () => importAuth(cfg, fixture.env, map),
    );
    expect(result.warnings.join("\n")).toContain("SQLite verification failed");
    const retryMap = collectIdMap({ cfg, env: fixture.env });
    expect(retryMap.get("claude-cli:work")).toBe("anthropic:work");
    await importAuth(cfg, fixture.env, retryMap);
    expect(loadSharedStore(fixture.env)?.profiles).toEqual({
      "anthropic:work": apiKey("anthropic", "retry-account"),
    });
  });
});

it.each(["main", "worker"])(
  "preserves a recovered shared selection when %s has a different local account",
  async (agentId) => {
    await withState("alias-archive-local-collision", async (fixture) => {
      const agentDir = fixture.agentDir(agentId);
      const cfg: OpenClawConfig = doctorConfig({
        agents: { entries: { main: {}, worker: { agentDir: fixture.agentDir("worker") } } },
        auth: {
          profiles: { "claude-cli:default": { provider: "claude-cli", mode: "api_key" } },
          order: { "claude-cli": ["claude-cli:default"] },
        },
      });
      await fixture.writeJson("agents/main/agent/auth.json", {
        "claude-cli": apiKey("claude-cli", "original-shared-account"),
      });
      const run = (config: OpenClawConfig) => runRepair(config, { env: fixture.env });
      await run(cfg);
      const detected = detectSharedAuthStoreMigration({
        stateDir: fixture.stateDir,
        doctorOnlyStateMigrations: true,
      });
      await migrateSharedAuthStore({ detected, stateDir: fixture.stateDir, env: fixture.env });
      const local = createAuthProfileStoreFixture({
        "anthropic:default": createApiKeyCredential("anthropic", "different-local-account"),
      });
      writeStore(fixture.env, local, agentDir);
      writeStore(
        fixture.env,
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
      expect(readLocalStore(agentDir)).toEqual(local);
      expect(readSharedStore(fixture.env)).toMatchObject({
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
  await withState("alias-two-imports", async (fixture) => {
    const workerDir = fixture.agentDir("worker");
    const cfg: OpenClawConfig = doctorConfig({
      agents: { entries: { main: {}, worker: { agentDir: workerDir } } },
      auth: {
        profiles: { "claude-cli:work": { provider: "claude-cli", mode: "api_key" } },
        order: { "claude-cli": ["claude-cli:work"] },
      },
    });
    for (const [agent, key] of [
      ["main", "shared-account"],
      ["worker", "local-account"],
    ]) {
      await fixture.writeJson(
        `agents/${agent}/agent/auth-profiles.json`,
        authStore({ "claude-cli:work": apiKey("claude-cli", key) }),
      );
    }
    const run = () => runRepair(cfg, { env: fixture.env });
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
    expect(loadSharedStore(fixture.env)?.profiles["anthropic:work"]).toEqual(
      apiKey("anthropic", "shared-account"),
    );
    expect(readLocalStore(workerDir)).toMatchObject({
      profiles: { "anthropic:work": apiKey("anthropic", "local-account") },
    });
  });
});
