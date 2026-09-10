import { expect, it } from "vitest";
import { loadPersistedSharedAuthProfileStore } from "../../agents/auth-profiles/persisted.js";
import {
  readPersistedSharedAuthProfileStoreRaw,
  runAuthProfileWriteTransaction,
  writePersistedAuthProfileStoreRaw,
} from "../../agents/auth-profiles/sqlite.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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
