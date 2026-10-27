// Doctor flat auth-profile tests cover legacy flat profile repair and persisted auth-profile loading.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "../agents/auth-profiles/credential-fixtures.test-support.js";
import { resolveAuthProfileOrder } from "../agents/auth-profiles/order.js";
import {
  loadPersistedAuthProfileStore,
  loadPersistedSharedAuthProfileStore,
} from "../agents/auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import {
  loadPersistedAuthProfileStoreFromRows,
  prepareAgentAuthProfileRowsRead,
} from "../agents/auth-profiles/sqlite-read.js";
import {
  readPersistedSharedAuthProfileStoreRaw,
  resolveAuthProfileDatabasePath,
  writePersistedAuthProfileStoreRaw,
} from "../agents/auth-profiles/sqlite.js";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { clearAgentHarnesses, registerAgentHarness } from "../agents/harness/registry.js";
import type { OpenClawConfigWithLegacyRoster } from "../config/legacy.roster.js";
import {
  listSessionEntriesReadOnly,
  loadSessionEntry,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { markCanonicalSessionValidationPending } from "../config/sessions/session-canonical-key.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDoctorPrompterFixture as makePrompter } from "../flows/doctor-health-context.test-support.js";
import {
  detectSharedAuthStoreMigration,
  migrateSharedAuthStore,
} from "../infra/state-migrations.shared-auth-store.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { authProfileCredentialPublication } from "../state/user-model-account-authority.js";
import { buildStatusText } from "../status/status-text.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  collectOpenAICodexAuthProfileStoreIdMap,
  maybeMigrateAuthProfileJsonStoresToSqlite,
  maybeRepairOpenAICodexAuthConfig,
} from "./doctor-auth-flat-profiles.js";
import { withPersistedAuthProfileStoreRead } from "./doctor-auth-flat-profiles.test-support.js";
import {
  prepareAuthProfileSourceReceipt,
  type AuthProfileMigrationSourceReceipt,
} from "./doctor-auth-migration-receipts.js";
import { maybeRepairCodexSessionRoutes } from "./doctor/shared/codex-route-session-repair.js";

type MigrationReceiptTestApi = {
  recordAuthProfileMigrationImported: (receipt: AuthProfileMigrationSourceReceipt) => void;
};

const { recordAuthProfileMigrationImported } = (globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("openclaw.authProfileMigrationReceiptsTestApi")
] as MigrationReceiptTestApi;

const states: OpenClawTestState[] = [];

function migrateAuthProfiles(
  params: Partial<Parameters<typeof maybeMigrateAuthProfileJsonStoresToSqlite>[0]> = {},
) {
  return maybeMigrateAuthProfileJsonStoresToSqlite({
    cfg: {},
    prompter: makePrompter(true, true),
    ...params,
  });
}

async function makeTestState(): Promise<OpenClawTestState> {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-doctor-flat-auth-",
    env: {
      OPENCLAW_AGENT_DIR: undefined,
    },
  });
  states.push(state);
  return state;
}

async function expectSelectedCodexAccountStatus(params: {
  cfg: OpenClawConfig;
  state: OpenClawTestState;
  sessionKey: string;
  storePath: string;
}): Promise<void> {
  const usageProfileIds: Array<string | undefined> = [];
  registerAgentHarness(
    {
      id: "codex",
      label: "Codex",
      autoSelection: { providerIds: ["openai"] },
      supports: () => ({ supported: true, priority: 100 }),
      runAttempt: async () => {
        throw new Error("not used in doctor migration status proof");
      },
      fetchUsageSnapshot: async (context) => {
        usageProfileIds.push(context.authProfileId);
        const selectedProfile = context.authProfileId ?? "openai:peter";
        const credential =
          loadPersistedAuthProfileStore(params.state.agentDir())?.profiles[selectedProfile] ??
          loadPersistedSharedAuthProfileStore(params.state.env)?.profiles[selectedProfile];
        return {
          provider: "openai",
          displayName: "OpenAI",
          windows: [
            {
              label: "Week",
              usedPercent:
                credential?.type === "oauth" && credential.accountId === "kate-account" ? 25 : 80,
            },
          ],
        };
      },
    },
    { ownerPluginId: "codex" },
  );
  try {
    const status = await buildStatusText({
      cfg: params.cfg,
      sessionEntry: loadSessionEntry({
        storePath: params.storePath,
        sessionKey: params.sessionKey,
        env: params.state.env,
      }),
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      statusChannel: "telegram",
      provider: "openai",
      model: "gpt-5.5",
      resolvedHarness: "codex",
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolveDefaultThinkingLevel: async () => undefined,
      isGroup: false,
      defaultGroupActivation: () => "mention",
      modelAuthOverride: "oauth",
      activeModelAuthOverride: "oauth",
    });
    expect(usageProfileIds).toEqual(["openai:chatgpt-default"]);
    expect(status).toContain("Week 75% left");
    expect(status).not.toContain("Week 20% left");
  } finally {
    clearAgentHarnesses();
  }
}

async function writeLegacyAuthProfilesJson(
  state: OpenClawTestState,
  value: unknown,
  agentId = "main",
): Promise<string> {
  return await state.writeText(
    `agents/${agentId}/agent/auth-profiles.json`,
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function writeLegacyProfiles(
  state: OpenClawTestState,
  profiles: Record<string, unknown>,
  agentId = "main",
) {
  return writeLegacyAuthProfilesJson(state, createAuthProfileStoreFixture(profiles), agentId);
}

function legacyOAuth(
  name: string,
  options: { provider?: string; expires?: number; accountId?: string; email?: string } = {},
) {
  return {
    type: "oauth" as const,
    provider: "openai-codex",
    access: `${name}-access`,
    refresh: `${name}-refresh`,
    expires: 9_999_999_999_999,
    ...options,
  };
}

function modelAuthConfig(authProfileId: string) {
  return {
    agents: {
      defaults: {
        models: { "openai/gpt-5.5": { agentRuntime: { authProfileId } } },
      },
    },
  };
}

function expectModelAuthProfile(config: OpenClawConfig, authProfileId: string) {
  expect(config).toMatchObject(modelAuthConfig(authProfileId));
}

function configProfiles(profiles: Record<string, unknown>): OpenClawConfig {
  return { auth: { profiles } } as unknown as OpenClawConfig;
}

async function expectConfigImport(
  state: OpenClawTestState,
  cfg: OpenClawConfig,
  profileId: string,
  credential: Record<string, unknown>,
  now: number,
) {
  const result = await migrateAuthProfiles({ cfg, now: () => now });
  expect(result.configChanged).toBe(true);
  expect(result.warnings).toStrictEqual([]);
  expect(cfg.auth?.profiles?.[profileId]).toEqual({ provider: "openai", mode: "api_key" });
  expect(loadPersistedAuthProfileStore(state.agentDir())?.profiles[profileId]).toEqual({
    type: "api_key",
    provider: "openai",
    ...credential,
  });
  return result;
}

function sessionFixture(state: OpenClawTestState, agentId = "main") {
  const context = {
    storePath: path.join(state.sessionsDir(agentId), "sessions.json"),
    sessionKey: `agent:${agentId}:main`,
    env: state.env,
  };
  return {
    ...context,
    read: (sessionKey = context.sessionKey) => loadSessionEntry({ ...context, sessionKey }),
    write: (entry: Parameters<typeof replaceSessionEntry>[1], sessionKey = context.sessionKey) =>
      replaceSessionEntry({ ...context, sessionKey }, entry),
  };
}

function writeJson(state: OpenClawTestState, pathname: string, value: unknown) {
  return state.writeText(pathname, `${JSON.stringify(value)}\n`);
}

function rotationState(profileId: string) {
  return {
    version: 1,
    order: { "openai-codex": [profileId] },
    lastGood: { "openai-codex": profileId },
    usageStats: { [profileId]: { lastUsed: 123 } },
  };
}

function listMigratedArchives(sourcePath: string): string[] {
  const prefix = `${path.basename(sourcePath)}.migrated-`;
  return fs
    .readdirSync(path.dirname(sourcePath))
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => path.join(path.dirname(sourcePath), entry));
}

function expectMigratedArchive(sourcePath: string): void {
  expect(fs.existsSync(sourcePath)).toBe(false);
  expect(listMigratedArchives(sourcePath)).toHaveLength(1);
}

function expectNoMigratedArchive(sourcePath: string): void {
  expect(listMigratedArchives(sourcePath)).toHaveLength(0);
}

afterEach(async () => {
  clearRuntimeAuthProfileStoreSnapshots();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  for (const state of states.splice(0)) {
    await state.cleanup();
  }
});

describe("maybeMigrateAuthProfileJsonStoresToSqlite", () => {
  it.each([
    "interrupted-recovery",
    "partial-row",
    "declined",
    "tampered-archive",
    "legacy-id",
  ] as const)("completed receipt recovery: state-db / %s", async (scenario) => {
    const state = await makeTestState();
    writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env: state.env });
    const credential = { type: "api_key", provider: "openai", key: "synthetic-archive-key" };
    const profileId = scenario === "legacy-id" ? "openai-codex:default" : "openai:default";
    const authPath = await writeLegacyProfiles(state, { [profileId]: credential });
    const migrate = (repair = true) =>
      migrateAuthProfiles({ prompter: makePrompter(repair, true), env: state.env });
    await migrate();
    const db = openOpenClawStateDatabase({ env: state.env }).db;
    const receipt = db
      .prepare("SELECT report_json FROM migration_sources WHERE source_path = ?")
      .get(authPath) as { report_json: string };
    const report = JSON.parse(receipt.report_json);
    delete report.expectedProfileSha256;
    db.prepare("UPDATE migration_sources SET report_json = ? WHERE source_path = ?").run(
      JSON.stringify(report),
      authPath,
    );
    const profiles: Record<string, unknown> = {
      "anthropic:unrelated": createApiKeyCredential("anthropic", "synthetic-unrelated-key"),
    };
    if (scenario === "legacy-id") {
      profiles["openai:default"] = credential;
    }
    if (scenario === "partial-row") {
      profiles["openai:default"] = {
        type: "oauth",
        provider: "openai",
        refresh: "synthetic-current-refresh",
      };
    }
    const writeTarget = () =>
      writeConfigMachineState("authProfiles.store", { version: 1, profiles }, { env: state.env });
    writeTarget();
    const archiveBytes = fs.readFileSync(report.archivePath);
    if (scenario === "tampered-archive") {
      fs.appendFileSync(report.archivePath, " ");
    }
    const before = db
      .prepare("SELECT * FROM migration_sources WHERE source_path = ?")
      .get(authPath);
    if (scenario === "interrupted-recovery") {
      const link = fs.linkSync;
      const fault = vi.spyOn(fs, "linkSync").mockImplementation((...args) => {
        link(...args);
        if (args[1] === authPath) {
          throw new Error("simulated recovery interruption");
        }
      });
      try {
        expect((await migrate()).warnings).toEqual([
          expect.stringContaining("simulated recovery interruption"),
        ]);
      } finally {
        fault.mockRestore();
      }
      expect(fs.readFileSync(report.archivePath)).toEqual(archiveBytes);
    }
    const repaired = await migrate(scenario !== "declined");
    expect(repaired.warnings).toEqual([]);
    const recovers = scenario === "interrupted-recovery";
    expect(readPersistedSharedAuthProfileStoreRaw(state.env)).toMatchObject({
      profiles: recovers ? { ...profiles, "openai:default": credential } : profiles,
    });
    if (recovers) {
      expect(repaired.changes).toContain(
        "Reset an inconsistent completed auth migration receipt for retry.",
      );
      expect(fs.readFileSync(report.archivePath)).toEqual(archiveBytes);
      expect((await migrate()).changes).toEqual([]);
      // Successful recovery must itself become non-replayable after deletion.
      writeTarget();
      expect((await migrate()).changes).toEqual([]);
      expect(readPersistedSharedAuthProfileStoreRaw(state.env)).toMatchObject({ profiles });
      expect(
        loadPersistedSharedAuthProfileStore(state.env)?.profiles["openai:default"],
      ).toBeUndefined();
    } else {
      expect(
        db.prepare("SELECT * FROM migration_sources WHERE source_path = ?").get(authPath),
      ).toEqual(before);
      expect(repaired.changes).toEqual([]);
    }
    expect(fs.existsSync(authPath)).toBe(false);
  });

  it("keeps JSON-era ownership through shared writes until Doctor imports the credential", async () => {
    const state = await makeTestState();
    const authPath = await writeLegacyProfiles(state, {
      "openai:json-era": createApiKeyCredential("openai", "sk-json-era"),
    });
    const legacyDatabasePath = path.join(state.agentDir(), "openclaw-agent.sqlite");
    expect(fs.existsSync(legacyDatabasePath)).toBe(false);

    for (const key of ["sk-first-write", "sk-second-write"]) {
      writePersistedAuthProfileStoreRaw(
        createAuthProfileStoreFixture({
          "anthropic:written": createApiKeyCredential("anthropic", key),
        }),
      );
    }

    const beforeDoctor = openOpenClawStateDatabase({ env: state.env });
    expect(
      beforeDoctor.db
        .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
        .get("auth.sharedStore"),
    ).toBeUndefined();
    expect(fs.existsSync(legacyDatabasePath)).toBe(true);

    const result = await migrateAuthProfiles({ env: state.env, now: () => 123 });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toEqual([expect.stringContaining("Migrated auth profile JSON")]);
    expect(loadPersistedAuthProfileStore(state.agentDir())?.profiles).toMatchObject({
      "openai:json-era": {
        type: "api_key",
        provider: "openai",
        key: "sk-json-era",
      },
      "anthropic:written": {
        type: "api_key",
        provider: "anthropic",
        key: "sk-second-write",
      },
    });
    expectMigratedArchive(authPath);
  });

  it("retries when an absent legacy sibling appears during migration", async () => {
    const state = await makeTestState();
    const authPath = await writeLegacyProfiles(state, {
      "openai:default": createApiKeyCredential("openai", "not-a-real"),
    });
    const legacyPath = path.join(state.agentDir(), "auth.json");
    let recreated = false;

    const result = await withPersistedAuthProfileStoreRead(
      (_agentDir, options, original) => {
        if (!recreated && options?.database === undefined) {
          recreated = true;
          fs.writeFileSync(
            legacyPath,
            `${JSON.stringify({ xai: { type: "api_key", key: "not-a-real" } })}\n`,
            "utf8",
          );
        }
        return original();
      },
      () => migrateAuthProfiles({ env: state.env }),
    );

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining("legacy auth source set changed during migration"),
    ]);
    expect(fs.existsSync(authPath)).toBe(true);
    expect(fs.existsSync(legacyPath)).toBe(true);
    expectNoMigratedArchive(authPath);
    expectNoMigratedArchive(legacyPath);
    expect(loadPersistedAuthProfileStore(state.agentDir())).toBeNull();
  });

  it("surfaces the resume failure cause instead of a generic warning", async () => {
    const state = await makeTestState();
    const sourcePath = await writeJson(state, "credentials/oauth.json", {
      openai: { access: "fake", refresh: "fake", expires: 42 },
    });
    const receipt = prepareAuthProfileSourceReceipt({
      pathname: sourcePath,
      now: Date.now,
      targetDatabasePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
      // An out-of-union target table makes resumePendingAuthProfileMigrationArchives throw
      // "invalid pending auth profile migration receipt" — the cheapest way to reproduce one of
      // its 5 distinct throw causes without corrupting on-disk state.
      targetTable: "bogus_table" as AuthProfileMigrationSourceReceipt["targetTable"],
      env: state.env,
    });
    recordAuthProfileMigrationImported(receipt);

    const result = await migrateAuthProfiles({ env: state.env });

    expect(result.warnings).toContainEqual(
      expect.stringMatching(
        /^Could not finalize an interrupted auth profile archive; legacy sources were left for recovery: .*invalid pending auth profile migration receipt.*/,
      ),
    );
  });

  it("imports live per-agent JSON after shared relocation without existing shared rows", async () => {
    const state = await makeTestState();
    const credential = { type: "api_key" as const, provider: "openai", key: "synthetic-shared" };
    const localCredential = { ...credential, key: "synthetic-local" };
    const sources = await Promise.all([
      writeLegacyProfiles(state, { "openai:default": credential }),
      writeLegacyProfiles(state, { "openai:default": localCredential }, "unconfigured"),
      writeLegacyProfiles(state, {}, "empty"),
    ]);
    const detected = detectSharedAuthStoreMigration({
      stateDir: state.stateDir,
      env: state.env,
      doctorOnlyStateMigrations: true,
    });
    expect(
      await migrateSharedAuthStore({ detected, stateDir: state.stateDir, env: state.env }),
    ).toMatchObject({ warnings: [] });
    expect(loadPersistedSharedAuthProfileStore(state.env)).toBeNull();

    const result = await migrateAuthProfiles({ env: state.env });

    expect(result.detected).toEqual(expect.arrayContaining(sources));
    expect(result.warnings).toEqual([
      expect.stringContaining("Archived unparseable auth profile input without import"),
    ]);
    expect(loadPersistedSharedAuthProfileStore(state.env)?.profiles["openai:default"]).toEqual(
      credential,
    );
    expect(
      loadPersistedAuthProfileStore(state.agentDir("unconfigured"))?.profiles["openai:default"],
    ).toEqual(localCredential);
    for (const [agentId, expected] of [
      ["main", credential],
      ["unconfigured", localCredential],
      ["empty", credential],
    ] as const) {
      expect(
        loadAuthProfileStoreWithoutExternalProfiles(state.agentDir(agentId)).profiles[
          "openai:default"
        ],
      ).toEqual(expected);
    }
    for (const source of sources) {
      expectMigratedArchive(source);
    }
    expect((await migrateAuthProfiles({ env: state.env })).detected).toEqual([]);
  });

  it("canonicalizes stale openai-codex rotation state on the config-backed state-only path (#130018)", async () => {
    const state = await makeTestState();
    const profileIdMap = new Map([["openai-codex:alpha", "openai:alpha"]]);
    const statePath = await writeJson(
      state,
      "agents/main/agent/auth-state.json",
      rotationState("openai-codex:alpha"),
    );

    const result = await migrateAuthProfiles({
      env: state.env,
      openAICodexAuthProfileIdMap: profileIdMap,
      now: () => 790,
    });

    expect(result.detected).toEqual([statePath]);
    const loaded = loadPersistedAuthProfileStore(state.agentDir());
    expect(loaded).toMatchObject({
      profiles: {},
      order: { openai: ["openai:alpha"] },
      lastGood: { openai: "openai:alpha" },
      usageStats: { "openai:alpha": { lastUsed: 123 } },
    });
    expect(loaded?.order?.["openai-codex"]).toBeUndefined();
    expectMigratedArchive(statePath);
  });

  it("keeps unpaired standalone rotation state from selecting a same-suffix credential", async () => {
    const state = await makeTestState();
    await state.writeAuthProfiles(
      createAuthProfileStoreFixture({
        "openai:alpha": createApiKeyCredential("openai", "unrelated-key"),
        "openai:default": createApiKeyCredential("openai", "configured-key"),
      }),
    );
    const statePath = await writeJson(
      state,
      "agents/main/agent/auth-state.json",
      rotationState("openai-codex:alpha"),
    );
    const cfg = {
      auth: {
        profiles: {
          "openai:alpha": { provider: "openai", mode: "api_key" },
          "openai:default": { provider: "openai", mode: "api_key" },
        },
        order: { openai: ["openai:default"] },
      },
    } satisfies OpenClawConfig;

    await migrateAuthProfiles({ cfg, env: state.env });

    const loaded = loadPersistedAuthProfileStore(state.agentDir());
    expect(loaded).toMatchObject({
      order: { "openai-codex": ["openai-codex:alpha"] },
      lastGood: { "openai-codex": "openai-codex:alpha" },
      usageStats: { "openai-codex:alpha": { lastUsed: 123 } },
    });
    expect(loaded?.order?.openai).toBeUndefined();
    expect(loaded?.lastGood?.openai).toBeUndefined();
    expect(loaded?.usageStats?.["openai:alpha"]).toBeUndefined();
    expect(resolveAuthProfileOrder({ cfg, store: loaded!, provider: "openai" })).toEqual([
      "openai:default",
    ]);
    expectMigratedArchive(statePath);
  });

  it("uses config collision mappings for standalone rotation state", async () => {
    const state = await makeTestState();
    const legacyConfig = {
      auth: {
        profiles: {
          "openai:bravo": {
            provider: "openai",
            mode: "api_key",
            key: "existing-key",
          },
          "openai-codex:bravo": {
            provider: "openai-codex",
            mode: "api_key",
            key: "legacy-key",
          },
        },
      },
    } as OpenClawConfig;
    const profileIdMap = collectOpenAICodexAuthProfileStoreIdMap({
      cfg: legacyConfig,
      env: state.env,
    });
    expect(profileIdMap.get("openai-codex:bravo")).toBe("openai:chatgpt-bravo");
    const cfg = maybeRepairOpenAICodexAuthConfig(legacyConfig, { profileIdMap }).config;
    await writeLegacyProfiles(state, {
      "openai-codex:alpha": legacyOAuth("alpha", { expires: 1_900_000_000_000 }),
    });
    await writeJson(
      state,
      "agents/main/agent/auth-state.json",
      rotationState("openai-codex:bravo"),
    );

    await migrateAuthProfiles({ cfg, env: state.env, openAICodexAuthProfileIdMap: profileIdMap });

    const loaded = loadPersistedAuthProfileStore(state.agentDir());
    expect(loaded?.profiles).toMatchObject({
      "openai:bravo": { key: "existing-key" },
      "openai:chatgpt-bravo": { key: "legacy-key" },
    });
    expect(loaded?.order?.openai).toEqual(["openai:chatgpt-bravo"]);
    expect(loaded?.lastGood?.openai).toBe("openai:chatgpt-bravo");
    expect(loaded?.usageStats?.["openai:chatgpt-bravo"]).toMatchObject({ lastUsed: 123 });
  });

  it("imports a valid legacy auth sibling when auth-profiles.json is malformed", async () => {
    const state = await makeTestState();
    const authPath = await state.writeText(
      "agents/main/agent/auth-profiles.json",
      "{ malformed-json\n",
    );
    const legacyPath = await writeJson(state, "agents/main/agent/auth.json", {
      xai: { type: "api_key", provider: "xai", key: "fake-sibling-key" },
    });

    const result = await migrateAuthProfiles();

    expect(result.changes).toEqual([expect.stringContaining("Migrated auth profile JSON")]);
    expect(loadPersistedAuthProfileStore(state.agentDir())?.profiles["xai:default"]).toMatchObject({
      key: "fake-sibling-key",
    });
    expect(fs.existsSync(authPath)).toBe(false);
    expect(fs.existsSync(legacyPath)).toBe(false);
    expectMigratedArchive(authPath);
    expectMigratedArchive(legacyPath);
  });

  it("preserves secret refs and OAuth material when migrating a flat auth-profiles.json", async () => {
    const state = await makeTestState();
    const credentials = {
      chutes: {
        type: "oauth",
        provider: "chutes",
        access: "ACCESS_TOKEN",
        refresh: "REFRESH_TOKEN",
        expires: 1_900_000_000_000,
        clientId: "chutes-client-id-123",
        idToken: "ID_TOKEN_xyz",
        chatgptPlanType: "pro",
      },
      openai: {
        type: "api_key",
        provider: "openai",
        keyRef: { source: "env", id: "OPENAI_API_KEY" },
      },
    };
    const authPath = await writeLegacyAuthProfilesJson(state, credentials);

    const result = await migrateAuthProfiles({ now: () => 472 });

    expect(result.warnings).toStrictEqual([]);
    expect(loadPersistedAuthProfileStore(state.agentDir())).toMatchObject({
      profiles: {
        "chutes:default": credentials.chutes,
        "openai:default": credentials.openai,
      },
    });
    expectMigratedArchive(authPath);
  });

  it("does not commit config when its migration fails before a later agent succeeds", async () => {
    const state = await makeTestState();
    const configAuthPath = await writeLegacyProfiles(state, {
      "openai-codex:default": legacyOAuth("config", { expires: 1_900_000_000_000 }),
    });
    const laterAuthPath = await writeLegacyProfiles(
      state,
      {
        "openai-codex:later": legacyOAuth("later", { expires: 1_900_000_000_000 }),
      },
      "later",
    );
    const cfg = {
      auth: {
        profiles: {
          "openai-codex:default": { provider: "openai-codex", mode: "oauth" },
        },
      },
    } as OpenClawConfig;

    const result = await withPersistedAuthProfileStoreRead(
      (agentDir, _options, original) =>
        agentDir === undefined ? createAuthProfileStoreFixture({}) : original(),
      () => migrateAuthProfiles({ cfg, env: state.env }),
    );

    expect(result.blockedProfileIds).toEqual(new Set(["openai-codex:default"]));
    expect(result.migratedProfileIds).toContain("openai:later");
    expect(result.warnings).toEqual([expect.stringContaining("SQLite verification failed")]);
    expect(fs.existsSync(configAuthPath)).toBe(true);
    expect(fs.existsSync(laterAuthPath)).toBe(false);
    expect(loadPersistedAuthProfileStore(state.agentDir("later"))?.profiles).toHaveProperty(
      "openai:later",
    );
  });

  it("keeps legacy JSON when only SQLite auth state changes before the transaction", async () => {
    const state = await makeTestState();
    const authPath = await writeLegacyProfiles(state, {
      "openrouter:default": createApiKeyCredential("openrouter", "fake-imported-key"),
    });
    const baseline: AuthProfileStore = {
      version: 1,
      profiles: {},
      lastGood: { openai: "openai:before" },
    };
    const concurrent: AuthProfileStore = {
      version: 1,
      profiles: {},
      lastGood: { openai: "openai:after" },
    };
    let loadCount = 0;

    const result = await withPersistedAuthProfileStoreRead(
      () => {
        loadCount += 1;
        return loadCount === 1 ? baseline : concurrent;
      },
      () => migrateAuthProfiles(),
    );

    expect(result.changes).toStrictEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining("current auth profile store changed during legacy migration"),
    ]);
    expect(fs.existsSync(authPath)).toBe(true);
    expectNoMigratedArchive(authPath);
  });

  it("imports default-agent config auth profiles when only legacy state exists", async () => {
    const state = await makeTestState();
    const statePath = await writeJson(state, "agents/main/agent/auth-state.json", {
      version: 1,
      order: { openai: ["openai:default"] },
      lastGood: { openai: "openai:default" },
    });
    const cfg = {
      auth: {
        profiles: {
          "openai:default": {
            provider: "openai",
            mode: "api_key",
            key: "sk-config",
          },
        },
      },
    } as OpenClawConfig;

    const result = await migrateAuthProfiles({ cfg, now: () => 467 });

    const authPath = `${state.agentDir()}/auth-profiles.json`;
    expect(result.detected.toSorted()).toEqual([authPath, statePath].toSorted());
    expect(result.configChanged).toBe(true);
    expect(result.warnings).toStrictEqual([]);
    expect(cfg.auth?.profiles?.["openai:default"]).toEqual({
      provider: "openai",
      mode: "api_key",
    });
    expect(loadPersistedAuthProfileStore(state.agentDir())).toMatchObject({
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-config",
        },
      },
      order: { openai: ["openai:default"] },
      lastGood: { openai: "openai:default" },
    });
    expectMigratedArchive(statePath);
    expect(fs.existsSync(authPath)).toBe(false);
    expectNoMigratedArchive(authPath);
  });

  it("infers config credential provider and mode before stripping config", async () => {
    const cases = [
      ["openai:default", {}, 468],
      ["work", { agents: { defaults: { model: { primary: "openai/gpt-5.5@work" } } } }, 470],
      [
        "agent-work",
        {
          agents: {
            entries: {
              main: {},
              ops: {
                models: {
                  "openai/gpt-5.5": {
                    agentRuntime: { authProfileId: "agent-work" },
                  },
                },
              },
            },
          },
        },
        472,
      ],
      ["ordered", { auth: { order: { openai: ["ordered"] } } }, 474],
    ] as const;

    for (const [profileId, hints, now] of cases) {
      const state = await makeTestState();
      const cfg = {
        ...hints,
        auth: {
          ...("auth" in hints ? hints.auth : {}),
          profiles: { [profileId]: { key: "sk-config" } },
        },
      } as unknown as OpenClawConfig;
      const result = await expectConfigImport(state, cfg, profileId, { key: "sk-config" }, now);

      const authPath = `${state.agentDir()}/auth-profiles.json`;
      expect(result.detected).toEqual([authPath]);
      expect(fs.existsSync(authPath)).toBe(false);
      expectNoMigratedArchive(authPath);
    }
  });

  it("does not infer a credential provider from conflicting keyed-agent model hints", async () => {
    const state = await makeTestState();
    const cfg = {
      auth: { profiles: { ambiguous: { key: "sk-config" } } },
      agents: {
        entries: {
          main: {
            models: {
              "openai/gpt-5.5": {
                agentRuntime: { authProfileId: "ambiguous" },
              },
            },
          },
          ops: {
            models: {
              "anthropic/claude-sonnet-4-6": {
                agentRuntime: { authProfileId: "ambiguous" },
              },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg,
      prompter: makePrompter(true, true),
      now: () => 475,
    });

    expect(result.detected).toStrictEqual([]);
    expect(result.configChanged).toBeUndefined();
    expect(result.warnings).toStrictEqual([]);
    expect(cfg.auth?.profiles?.ambiguous).toEqual({ key: "sk-config" });
    expect(loadPersistedAuthProfileStore(state.agentDir())).toBeNull();
  });

  it("imports default-agent config api key alias SecretRefs as key refs", async () => {
    const keyRef = () => ({ source: "env", provider: "default", id: "OPENAI_API_KEY" });
    const cases = [
      ["openai:api-key-object", { apiKey: keyRef() }],
      ["openai:api-key-template", { mode: "api_key", apiKey: "${OPENAI_API_KEY}" }],
      ["openai:api-key-legacy-field", { api_key: keyRef() }],
    ] as const;

    for (const [profileId, fields] of cases) {
      const state = await makeTestState();
      const cfg = configProfiles({ [profileId]: { provider: "openai", ...fields } });
      await expectConfigImport(state, cfg, profileId, { keyRef: keyRef() }, 473);
    }
  });

  it("uses config credentials only when same-id sqlite credentials are incomplete", async () => {
    for (const key of ["sk-sqlite", undefined]) {
      const state = await makeTestState();
      saveAuthProfileStore(
        createAuthProfileStoreFixture({
          "openai:default": {
            type: "api_key" as const,
            provider: "openai",
            ...(key ? { key } : {}),
          },
        }),
        state.agentDir(),
        { syncExternalCli: false },
      );
      const cfg = configProfiles({
        "openai:default": { provider: "openai", mode: "api_key", key: "sk-config" },
      });
      await expectConfigImport(state, cfg, "openai:default", { key: key ?? "sk-config" }, 469);
    }
  });
});

describe("legacy flat profiles through the canonical auth migration owner", () => {
  it("preserves existing SQLite auth profiles when migrating a legacy flat store", async () => {
    const state = await makeTestState();
    const existing = {
      "anthropic:default": {
        type: "oauth" as const,
        provider: "anthropic",
        access: "sk-access-live",
        refresh: "sk-refresh-live",
        expires: 9999999999999,
      },
    };
    const original = structuredClone(existing);
    saveAuthProfileStore(createAuthProfileStoreFixture(existing), state.agentDir());
    const legacy = { openai: { apiKey: "sk-openai-flat" } };
    const authPath = await writeLegacyAuthProfilesJson(state, legacy);

    const databasePath = resolveAuthProfileDatabasePath(state.agentDir());
    const reader = prepareAgentAuthProfileRowsRead({
      databasePath,
      agentId: "main",
      env: state.env,
    });
    const authority = reader.captureCredentialAuthority("openai:default")!;
    authority.observe(undefined);
    const pendingDenied: boolean[] = [];
    const unsubscribe = authProfileCredentialPublication.subscribeFacts((change) => {
      if (change.kind === "pending") {
        try {
          authority.readCurrentCredential();
          pendingDenied.push(false);
        } catch {
          pendingDenied.push(true);
        }
      }
    });
    let result: Awaited<ReturnType<typeof migrateAuthProfiles>>;
    try {
      result = await migrateAuthProfiles({ now: () => 123 });
      const cold = loadPersistedAuthProfileStoreFromRows(await reader.read(), databasePath);
      expect(authority.readCurrentCredential()).toEqual(cold?.profiles["openai:default"]);
      expect(authority.readCurrentCredential()).toEqual({
        type: "api_key",
        provider: "openai",
        key: "sk-openai-flat",
      });
      expect(pendingDenied.length).toBeGreaterThan(0);
      expect(pendingDenied.every(Boolean)).toBe(true);
    } finally {
      unsubscribe();
      await reader.dispose();
    }

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toEqual([expect.stringContaining("Migrated auth profile JSON")]);
    expect(loadPersistedAuthProfileStore(state.agentDir())?.profiles).toEqual({
      ...original,
      "openai:default": {
        type: "api_key",
        provider: "openai",
        key: "sk-openai-flat",
      },
    });
    expect(fs.existsSync(authPath)).toBe(false);
    const [archive] = listMigratedArchives(authPath);
    expect(JSON.parse(fs.readFileSync(archive!, "utf8"))).toEqual(legacy);
  });

  it("moves aws-sdk auth profile markers into config metadata", async () => {
    const state = await makeTestState();
    const legacy = createAuthProfileStoreFixture({
      "amazon-bedrock:default": {
        type: "aws-sdk",
        createdAt: "2026-03-15T10:00:00.000Z",
      },
      "openrouter:default": createApiKeyCredential("openrouter", "sk-openrouter"),
    });
    const authPath = await writeLegacyAuthProfilesJson(state, legacy);
    const cfg = {};

    const result = await migrateAuthProfiles({ cfg, now: () => 456 });

    expect(result.detected).toEqual([authPath]);
    expect(result.changes).toEqual([
      expect.stringContaining("Migrated auth profile JSON"),
      expect.stringContaining("Moved aws-sdk profile metadata"),
    ]);
    expect(result.warnings).toStrictEqual([]);
    expect(cfg).toEqual({
      auth: {
        profiles: {
          "amazon-bedrock:default": {
            provider: "amazon-bedrock",
            mode: "aws-sdk",
          },
        },
      },
    });
    expect(loadPersistedAuthProfileStore(state.agentDir())?.profiles).toEqual({
      "openrouter:default": {
        type: "api_key",
        provider: "openrouter",
        key: "sk-openrouter",
      },
    });
    expect(fs.existsSync(authPath)).toBe(false);
    const [archive] = listMigratedArchives(authPath);
    expect(JSON.parse(fs.readFileSync(archive!, "utf8"))).toEqual(legacy);
  });
});

describe("maybeRepairOpenAICodexAuthConfig", () => {
  it.each(["order-only", "store-map", "collision"] as const)(
    "canonicalizes config profile references (%s)",
    (scenario) => {
      const legacyId = scenario === "order-only" ? "openai-codex:work" : "openai-codex:default";
      const profiles = {
        "openai:default": { provider: "openai", mode: "api_key" },
        "openai-codex:default": {
          provider: "openai-codex",
          mode: "oauth",
          email: "chatgpt@example.com",
        },
      };
      const cfg = {
        ...modelAuthConfig(legacyId),
        ...(scenario === "order-only" ? { auth: { order: { "openai-codex": [legacyId] } } } : {}),
        ...(scenario === "collision"
          ? {
              auth: { profiles, order: { openai: ["openai:default"], "openai-codex": [legacyId] } },
            }
          : {}),
      } as unknown as OpenClawConfig;
      const profileIdMap =
        scenario === "order-only"
          ? undefined
          : new Map([
              [legacyId, scenario === "collision" ? "openai:default" : "openai:chatgpt-default"],
            ]);
      const result = maybeRepairOpenAICodexAuthConfig(cfg, { profileIdMap });
      expect(result.changes).toEqual(["Migrated legacy auth profile config to current providers."]);
      expectModelAuthProfile(
        result.config,
        scenario === "order-only" ? "openai:work" : "openai:chatgpt-default",
      );
      if (scenario === "store-map") {
        expect(result.config.auth).toBeUndefined();
      } else {
        expect(result.config.auth?.order).toEqual({
          openai:
            scenario === "order-only"
              ? ["openai:work"]
              : ["openai:chatgpt-default", "openai:default"],
        });
      }
      if (scenario === "collision") {
        expect(result.config.auth?.profiles).toEqual({
          "openai:default": { provider: "openai", mode: "api_key" },
          "openai:chatgpt-default": {
            provider: "openai",
            mode: "oauth",
            email: "chatgpt@example.com",
          },
        });
      }
    },
  );
});

describe("legacy OpenAI auth profiles through the canonical migration owner", () => {
  it("keeps existing SQLite accounts when planning legacy Codex profile collisions", async () => {
    const state = await makeTestState();
    await state.writeAuthProfiles(
      createAuthProfileStoreFixture({
        "openai:default": legacyOAuth("peter", { provider: "openai", accountId: "peter-account" }),
      }),
    );
    await writeLegacyProfiles(state, {
      "openai-codex:default": legacyOAuth("kate", { accountId: "kate-account" }),
    });

    const profileIdMap = collectOpenAICodexAuthProfileStoreIdMap({ cfg: {}, env: state.env });
    expect(profileIdMap.get("openai-codex:default")).toBe("openai:chatgpt-default");
    await migrateAuthProfiles({ env: state.env, openAICodexAuthProfileIdMap: profileIdMap });
    expect(loadPersistedAuthProfileStore(state.agentDir())?.profiles).toMatchObject({
      "openai:default": { accountId: "peter-account" },
      "openai:chatgpt-default": { accountId: "kate-account" },
    });
  });

  it("migrates config-only legacy OAuth accounts and their selected SQLite session", async () => {
    const state = await makeTestState();
    const session = sessionFixture(state);
    const legacyConfig = {
      auth: {
        profiles: {
          "openai:default": {
            provider: "openai",
            mode: "api_key",
            key: "existing-api-key",
          },
          "openai-codex:default": {
            provider: "openai-codex",
            mode: "oauth",
            access: "kate-access",
            refresh: "kate-refresh",
            expires: 9_999_999_999_999,
            accountId: "kate-account",
          },
        },
      },
    } as OpenClawConfig;
    await session.write({
      sessionId: "config-only-selected-session",
      updatedAt: Date.now(),
      authProfileOverride: "openai-codex:default",
      authProfileOverrideSource: "user",
    });

    const profileIdMap = collectOpenAICodexAuthProfileStoreIdMap({
      cfg: legacyConfig,
      env: state.env,
    });
    expect(profileIdMap.get("openai-codex:default")).toBe("openai:chatgpt-default");
    const cfg = maybeRepairOpenAICodexAuthConfig(legacyConfig, { profileIdMap }).config;
    await migrateAuthProfiles({ cfg, env: state.env, openAICodexAuthProfileIdMap: profileIdMap });
    await maybeRepairCodexSessionRoutes({
      cfg,
      env: state.env,
      shouldRepair: true,
      authProfileIdMap: profileIdMap,
    });

    expect(loadPersistedAuthProfileStore(state.agentDir())?.profiles).toMatchObject({
      "openai:default": { type: "api_key" },
      "openai:chatgpt-default": { type: "oauth", accountId: "kate-account" },
    });
    expect(session.read()).toMatchObject({
      authProfileOverride: "openai:chatgpt-default",
      authProfileOverrideSource: "user",
    });
  });

  it("repairs an already-migrated selected account from its verified auth archive", async () => {
    const state = await makeTestState();
    const session = sessionFixture(state);
    const { storePath, sessionKey } = session;
    const authPath = await writeLegacyProfiles(state, {
      "openai:default": createApiKeyCredential("openai", "existing-api-key"),
      "openai-codex:default": legacyOAuth("kate", {
        accountId: "kate-account",
        email: "kate@example.com",
      }),
      "openai-codex:peter": legacyOAuth("peter", {
        accountId: "peter-account",
        email: "peter@example.com",
      }),
    });
    await session.write({
      sessionId: "already-migrated-selected-session",
      updatedAt: Date.now(),
      authProfileOverride: "openai-codex:default",
      authProfileOverrideSource: "user",
    });

    const originalMap = collectOpenAICodexAuthProfileStoreIdMap({ cfg: {}, env: state.env });
    await migrateAuthProfiles({ env: state.env, openAICodexAuthProfileIdMap: originalMap });
    expect(fs.existsSync(authPath)).toBe(false);
    expect(session.read()).toMatchObject({
      authProfileOverride: "openai-codex:default",
    });

    const detected = detectSharedAuthStoreMigration({
      stateDir: state.stateDir,
      doctorOnlyStateMigrations: true,
    });
    await migrateSharedAuthStore({ detected, stateDir: state.stateDir, env: state.env });

    const recoveredMap = collectOpenAICodexAuthProfileStoreIdMap({ cfg: {}, env: state.env });
    expect(recoveredMap.get("openai-codex:default")).toBe("openai:chatgpt-default");
    const repair = await maybeRepairCodexSessionRoutes({
      cfg: {},
      env: state.env,
      shouldRepair: true,
      authProfileIdMap: recoveredMap,
    });

    expect(repair.changes[0]).toContain("in 1 session across ");
    expect(session.read()).toMatchObject({
      authProfileOverride: "openai:chatgpt-default",
      authProfileOverrideSource: "user",
    });
    expect(loadPersistedSharedAuthProfileStore(state.env)?.profiles).toMatchObject({
      "openai:default": { type: "api_key" },
      "openai:chatgpt-default": { accountId: "kate-account" },
      "openai:peter": { accountId: "peter-account" },
    });
    await expectSelectedCodexAccountStatus({ cfg: {}, state, sessionKey, storePath });
  });

  it("rejects tampered auth archives instead of guessing a migrated account", async () => {
    const state = await makeTestState();
    const authPath = await writeLegacyProfiles(state, {
      "openai-codex:default": legacyOAuth("kate", { accountId: "kate-account" }),
    });
    await migrateAuthProfiles({ env: state.env });
    const [archivePath] = listMigratedArchives(authPath);
    fs.appendFileSync(archivePath!, "\n");

    expect(collectOpenAICodexAuthProfileStoreIdMap({ cfg: {}, env: state.env }).size).toBe(0);
  });

  it("leaves archived profile mapping unresolved when account identity is ambiguous", async () => {
    const state = await makeTestState();
    const sharedAccount = legacyOAuth("shared", { accountId: "shared-account" });
    await writeLegacyProfiles(state, {
      "openai-codex:default": sharedAccount,
      "openai-codex:copy": { ...sharedAccount },
    });
    await migrateAuthProfiles({ env: state.env });

    expect(collectOpenAICodexAuthProfileStoreIdMap({ cfg: {}, env: state.env }).size).toBe(0);
  });

  it("keeps failed agent accounts separate while repairing verified and inherited main accounts", async () => {
    const state = await makeTestState();
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { authInheritance: { agentId: "main" } },
        entries: {
          main: {},
          failed: {},
          inherited: {},
          dedup: {},
        },
      },
    };
    const sharedCredential = legacyOAuth("shared", { accountId: "shared-main-account" });
    await writeLegacyProfiles(state, { "openai-codex:shared": sharedCredential });
    const failedAuthPath = await writeLegacyProfiles(
      state,
      {
        "openai-codex:shared": {
          type: "oauth",
          provider: "openai-codex",
          accountId: "failed-different-account",
          oauthRef: {
            source: "openclaw-credentials",
            id: "0123456789abcdef0123456789abcdef",
            provider: "openai-codex",
          },
        },
      },
      "failed",
    );
    await writeLegacyProfiles(
      state,
      {
        "openai-codex:shared": { ...sharedCredential },
        "openai-codex:pending": {
          type: "oauth",
          provider: "openai-codex",
          accountId: "dedup-pending-account",
          oauthRef: {
            id: "fedcba9876543210fedcba9876543210",
            provider: "openai-codex",
          },
        },
      },
      "dedup",
    );
    for (const agentId of ["main", "failed", "inherited", "dedup"]) {
      await sessionFixture(state, agentId).write({
        sessionId: `${agentId}-session`,
        updatedAt: Date.now(),
        authProfileOverride: "openai-codex:shared",
        authProfileOverrideSource: "user",
      });
    }

    const failedAuthBytes = fs.readFileSync(failedAuthPath);
    const profileIdMap = collectOpenAICodexAuthProfileStoreIdMap({ cfg, env: state.env });
    const migration = await migrateAuthProfiles({
      cfg,
      env: state.env,
      openAICodexAuthProfileIdMap: profileIdMap,
    });
    expect(migration.warnings.length).toBeGreaterThan(0);
    expect(loadPersistedAuthProfileStore(state.agentDir("dedup"))?.profiles).not.toHaveProperty(
      "openai:shared",
    );

    const repair = await maybeRepairCodexSessionRoutes({
      cfg,
      env: state.env,
      shouldRepair: true,
      authProfileIdMap: profileIdMap,
    });
    expect(repair.changes[0]).toContain("in 3 sessions across ");
    for (const agentId of ["main", "inherited", "dedup"]) {
      expect(sessionFixture(state, agentId).read()).toMatchObject({
        authProfileOverride: "openai:shared",
        authProfileOverrideSource: "user",
      });
    }
    expect(sessionFixture(state, "failed").read()).toMatchObject({
      authProfileOverride: "openai-codex:shared",
    });
    expect(
      loadPersistedAuthProfileStore(state.agentDir("failed"))?.profiles ?? {},
    ).not.toHaveProperty("openai:shared");
    expect(fs.readFileSync(failedAuthPath)).toEqual(failedAuthBytes);
  });

  it("does not read a canonical session database as JSON during route preview or repair", async () => {
    const state = await makeTestState();
    const storePath = path.join(state.agentDir(), "openclaw-agent.sqlite");
    const sessionKey = "agent:main:main";
    await replaceSessionEntry(
      { storePath, sessionKey, env: state.env },
      { sessionId: "canonical-route-session", updatedAt: Date.now() },
    );
    const readFileSyncSpy = vi.spyOn(fs, "readFileSync");
    try {
      for (const shouldRepair of [false, true]) {
        const result = await maybeRepairCodexSessionRoutes({
          cfg: { session: { store: storePath } },
          env: state.env,
          shouldRepair,
        });
        expect(result).toMatchObject({
          scannedStores: 1,
          warnings: [],
          changes: [],
        });
      }
      expect(readFileSyncSpy.mock.calls.map(([file]) => file)).not.toContain(storePath);
    } finally {
      readFileSyncSpy.mockRestore();
    }
    expect(loadSessionEntry({ storePath, sessionKey, env: state.env })?.sessionId).toBe(
      "canonical-route-session",
    );
  });

  it("previews noncanonical SQLite sessions without mutating or requiring canonical migration", async () => {
    const state = await makeTestState();
    const session = sessionFixture(state);
    const { storePath, sessionKey } = session;
    await session.write({
      sessionId: "noncanonical-preview-session",
      updatedAt: Date.now(),
      modelProvider: "openai-codex",
      model: "gpt-5.5",
    });
    const sqlitePath = path.join(state.agentDir(), "openclaw-agent.sqlite");
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      env: state.env,
      path: sqlitePath,
    });
    database.db
      .prepare("UPDATE session_nodes SET entry_valid = 0 WHERE session_key = ?")
      .run(sessionKey);
    // Offline imports revoke shared readiness through the admitted owner before releasing custody.
    markCanonicalSessionValidationPending(database, [sessionKey]);
    await closeOpenClawAgentDatabasesAsync(state.root);
    closeOpenClawAgentDatabasesForTest();
    expect(() =>
      listSessionEntriesReadOnly({ storePath, agentId: "main", env: state.env }),
    ).toThrow("invalid persisted session row requires repair");

    const preview = await maybeRepairCodexSessionRoutes({
      cfg: {},
      env: state.env,
      shouldRepair: false,
    });

    expect(preview).toMatchObject({
      scannedStores: 1,
      changes: [],
    });
    expect(preview.warnings.join("\n")).toContain("Affected sessions: 1.");
    const verifier = new DatabaseSync(sqlitePath, { readOnly: true });
    try {
      expect(
        verifier
          .prepare("SELECT entry_valid FROM session_nodes WHERE session_key = ?")
          .get(sessionKey),
      ).toEqual({ entry_valid: 0 });
    } finally {
      verifier.close();
    }
  });

  it("ignores retained Codex window metadata when preview and repair both skip its tombstone", async () => {
    const state = await makeTestState();
    const session = sessionFixture(state);
    const { sessionKey } = session;
    await session.write({ sessionId: "retained-codex-window", updatedAt: 10 });
    await closeOpenClawAgentDatabasesAsync(state.root);
    closeOpenClawAgentDatabasesForTest();
    const sqlitePath = path.join(state.agentDir(), "openclaw-agent.sqlite");
    const database = new DatabaseSync(sqlitePath);
    database
      .prepare("UPDATE session_nodes SET entry_json = '{}' WHERE session_key = ?")
      .run(sessionKey);
    database
      .prepare("UPDATE session_nodes SET entry_valid = -1 WHERE session_key = ?")
      .run(sessionKey);
    database
      .prepare(
        "UPDATE session_windows SET agent_harness_id = 'codex', model_provider = 'openai-codex', model = 'gpt-5.5' WHERE session_key = ?",
      )
      .run(sessionKey);
    database.close();

    const preview = await maybeRepairCodexSessionRoutes({
      cfg: {},
      env: state.env,
      shouldRepair: false,
    });
    const repair = await maybeRepairCodexSessionRoutes({
      cfg: {},
      env: state.env,
      shouldRepair: true,
    });

    expect(preview).toMatchObject({ warnings: [], changes: [] });
    expect(repair).toMatchObject({ warnings: [], changes: [] });
    const verifier = new DatabaseSync(sqlitePath, { readOnly: true });
    try {
      expect(
        verifier
          .prepare("SELECT entry_json, entry_valid FROM session_nodes WHERE session_key = ?")
          .get(sessionKey),
      ).toEqual({ entry_json: "{}", entry_valid: -1 });
      expect(
        verifier
          .prepare(
            "SELECT agent_harness_id, model_provider, model FROM session_windows WHERE session_key = ?",
          )
          .get(sessionKey),
      ).toEqual({ agent_harness_id: "codex", model_provider: "openai-codex", model: "gpt-5.5" });
    } finally {
      verifier.close();
    }
  });

  it("preserves the selected Codex account across auth migration, SQLite sessions, and status", async () => {
    const state = await makeTestState();
    const session = sessionFixture(state);
    const { storePath, sessionKey } = session;
    const sessionUpdatedAt = Date.now();
    const legacyConfig: OpenClawConfigWithLegacyRoster = {
      auth: {
        profiles: {
          "openai:default": { provider: "openai", mode: "api_key" },
          "openai-codex:peter": {
            provider: "openai-codex",
            mode: "oauth",
            email: "peter@example.com",
          },
          "openai-codex:default": {
            provider: "openai-codex",
            mode: "oauth",
            email: "kate@example.com",
          },
        },
        order: {
          openai: ["openai:default"],
          "openai-codex": ["openai-codex:peter", "openai-codex:default"],
        },
      },
      agents: { defaults: { agentRuntime: { id: "codex" } } },
    };
    await writeLegacyAuthProfilesJson(state, {
      version: 1,
      profiles: {
        "openai:default": createApiKeyCredential("openai", "test-openai-api-key"),
        "openai-codex:peter": legacyOAuth("peter", {
          accountId: "peter-account",
          email: "peter@example.com",
        }),
        "openai-codex:default": legacyOAuth("kate", {
          accountId: "kate-account",
          email: "kate@example.com",
        }),
      },
      order: {
        openai: ["openai:default"],
        "openai-codex": ["openai-codex:peter", "openai-codex:default"],
      },
    });
    const peterSessionKey = "agent:main:telegram:default:direct:5550100999";
    const missingProfileSessionKey = "agent:main:discord:default:direct:5550100888";
    const selectedSessions = [
      [sessionKey, "selected-kate-session", "default", "user", { agentRuntimeOverride: "codex" }],
      [peterSessionKey, "selected-peter-session", "peter", "auto", {}],
      [missingProfileSessionKey, "missing-profile-session", "missing", "user", {}],
    ] as const;
    for (const [
      index,
      [key, sessionId, account, source, overrides],
    ] of selectedSessions.entries()) {
      await session.write(
        {
          sessionId,
          updatedAt: sessionUpdatedAt + index,
          modelProvider: "openai",
          model: "gpt-5.5",
          authProfileOverride: `openai-codex:${account}`,
          authProfileOverrideSource: source,
          ...overrides,
        },
        key,
      );
    }
    expect(session.read(peterSessionKey)).toMatchObject({
      authProfileOverride: "openai-codex:peter",
    });
    expect(fs.existsSync(storePath)).toBe(false);

    const profileIdMap = collectOpenAICodexAuthProfileStoreIdMap({
      cfg: legacyConfig,
      env: state.env,
    });
    expect(profileIdMap.get("openai-codex:default")).toBe("openai:chatgpt-default");
    expect(profileIdMap.get("openai-codex:peter")).toBe("openai:peter");
    const cfg = maybeRepairOpenAICodexAuthConfig(legacyConfig, { profileIdMap }).config;
    const migration = await migrateAuthProfiles({
      cfg,
      env: state.env,
      openAICodexAuthProfileIdMap: profileIdMap,
    });
    expect(migration.warnings).toEqual([]);
    expect(loadPersistedAuthProfileStore(state.agentDir())?.order?.openai).toEqual([
      "openai:peter",
      "openai:chatgpt-default",
      "openai:default",
    ]);

    const repairParams = {
      cfg,
      env: state.env,
      authProfileIdMap: profileIdMap,
    };
    expect(
      listSessionEntriesReadOnly({ storePath, agentId: "main", env: state.env }).map(
        ({ entry }) => entry.authProfileOverride,
      ),
    ).toEqual(expect.arrayContaining(["openai-codex:default", "openai-codex:peter"]));
    const preview = await maybeRepairCodexSessionRoutes({ ...repairParams, shouldRepair: false });
    expect(preview.changes).toEqual([]);
    expect(preview.warnings.join("\n")).toContain("Affected sessions: 2.");

    const sessionRepair = await maybeRepairCodexSessionRoutes({
      ...repairParams,
      shouldRepair: true,
    });
    expect(sessionRepair.changes[0]).toContain("in 2 sessions across ");
    const selectedSession = session.read();
    expect(selectedSession).toMatchObject({
      authProfileOverride: "openai:chatgpt-default",
      authProfileOverrideSource: "user",
    });
    expect(session.read(peterSessionKey)).toMatchObject({
      authProfileOverride: "openai:peter",
      authProfileOverrideSource: "auto",
    });
    expect(session.read(missingProfileSessionKey)).toMatchObject({
      authProfileOverride: "openai-codex:missing",
      authProfileOverrideSource: "user",
      updatedAt: sessionUpdatedAt + 2,
    });
    await expect(
      maybeRepairCodexSessionRoutes({ ...repairParams, shouldRepair: true }),
    ).resolves.toMatchObject({ changes: [] });

    await expectSelectedCodexAccountStatus({ cfg, state, sessionKey, storePath });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
