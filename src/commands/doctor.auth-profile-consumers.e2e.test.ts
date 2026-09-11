import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadPersistedSharedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import {
  runAuthProfileWriteTransaction,
  writePersistedAuthProfileStoreRaw,
} from "../agents/auth-profiles/sqlite.js";
import { readConfigFileSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  clearUserProfileAuthLink,
  listUserProfileAuthLinks,
  resolveUserProfileAuthLink,
  setUserProfileAuthLink,
} from "../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

function runDoctor(env: NodeJS.ProcessEnv) {
  const result = spawnSync(
    process.execPath,
    ["openclaw.mjs", "doctor", "--fix", "--non-interactive", "--no-workspace-suggestions"],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: { ...env, VITEST: undefined },
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  expect(result.status, result.stderr || result.stdout).toBe(0);
  clearRuntimeAuthProfileStoreSnapshots();
}

function readStoredLinks(profileId: string): unknown {
  const { db } = openOpenClawStateDatabase();
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<Pick<DB, "secret_store_entries">>(db)
      .selectFrom("secret_store_entries")
      .select("value")
      .where("scope_kind", "=", "identity")
      .where("scope_id", "=", profileId)
      .where("name", "=", "model-accounts")
      .where("deleted_at_ms", "is", null),
  );
  expect(row, "the person's saved account selections must remain present").toBeDefined();
  return JSON.parse(row!.value);
}

afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
});

describe("doctor auth-profile consumers", () => {
  it.each([
    { name: "unoccupied destination", occupied: false, renamed: "anthropic:work" },
    { name: "occupied destination", occupied: true, renamed: "anthropic:cli-work" },
  ])("preserves selected accounts with an $name and on repeat", async ({ occupied, renamed }) => {
    await withOpenClawTestState(
      {
        prefix: "openclaw-doctor-auth-consumers-",
        scenario: "external-service",
        env: {
          OPENCLAW_BUNDLED_PLUGINS_DIR: fileURLToPath(new URL("../../extensions", import.meta.url)),
        },
      },
      async (state) => {
        const config: OpenClawConfig = {
          gateway: {
            mode: "local",
            port: 1,
            auth: { mode: "token", token: "synthetic-doctor-token" },
            controlUi: { enabled: false, sessionObserver: false },
          },
          agents: {
            defaults: {
              workspace: state.workspaceDir,
              model: {
                primary: "anthropic/test-model",
                fallbacks: ["anthropic/test-model@20260101@claude-cli:work"],
              },
              utilityModel: "anthropic/test-model@claude-cli:work",
              modelPolicy: { allow: ["anthropic/*"] },
              models: { "anthropic/test-model@claude-cli:work": { alias: "work-model" } },
            },
            entries: { main: { default: true } },
          },
          auth: {
            profiles: {
              "claude-cli:work": { provider: "anthropic", mode: "api_key" },
              ...(occupied
                ? { "anthropic:work": { provider: "anthropic", mode: "api_key" as const } }
                : {}),
            },
            order: { anthropic: ["claude-cli:work"] },
          },
          models: {
            providers: {
              anthropic: {
                baseUrl: "http://127.0.0.1:1",
                api: "anthropic-messages",
                apiKey: "claude-cli:work",
                models: [
                  {
                    id: "test-model",
                    name: "Fixture model",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 8192,
                    maxTokens: 1024,
                  },
                ],
              },
              "literal-fixture": {
                baseUrl: "http://127.0.0.1:1",
                api: "openai-completions",
                apiKey: "literal-claude-cli:work",
                models: [],
              },
            },
          },
          tools: {
            media: {
              models: [
                {
                  provider: "anthropic",
                  model: "test-model",
                  capabilities: ["image"],
                  profile: "claude-cli:work",
                  preferredProfile: "claude-cli:work",
                },
              ],
            },
          },
          mcp: {
            servers: {
              fixture: {
                enabled: false,
                transport: "streamable-http",
                url: "http://127.0.0.1:1/mcp",
                auth: "oauth",
                oauth: { authProfileId: "claude-cli:work" },
              },
            },
          },
          plugins: {
            allow: ["anthropic", "llm-task"],
            slots: { memory: "none" },
            entries: {
              "llm-task": {
                enabled: true,
                llm: { allowModelOverride: true, allowAuthProfileOverride: true },
                config: { defaultAuthProfileId: "claude-cli:work" },
              },
            },
          },
          messages: { responsePrefix: "literal anthropic/test-model@claude-cli:work" },
        };
        await state.writeConfig(config);
        runAuthProfileWriteTransaction(
          undefined,
          (database) =>
            writePersistedAuthProfileStoreRaw(
              {
                version: 1,
                profiles: {
                  "claude-cli:work": {
                    type: "api_key",
                    provider: "anthropic",
                    key: "synthetic-work-key",
                  },
                  ...(occupied
                    ? {
                        "anthropic:work": {
                          type: "api_key",
                          provider: "anthropic",
                          key: "synthetic-other-key",
                        },
                      }
                    : {}),
                },
              },
              undefined,
              database,
            ),
          { env: state.env },
        );
        const person = ensureProfileForEmail("account-owner@example.test");
        setUserProfileAuthLink({
          profileId: person.id,
          provider: "anthropic",
          authProfileId: "claude-cli:work",
        });
        clearUserProfileAuthLink({ profileId: person.id, provider: "openai" });
        const linkedAt = listUserProfileAuthLinks(person.id)[0]!.updatedAt;
        runDoctor(state.env);

        const snapshot = await readConfigFileSnapshot();
        expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
        const repaired = snapshot.sourceConfig ?? snapshot.config;
        const profiles = loadPersistedSharedAuthProfileStore(state.env)?.profiles;
        expect(profiles?.[renamed]).toMatchObject({
          provider: "anthropic",
          key: "synthetic-work-key",
        });
        expect(profiles).not.toHaveProperty("claude-cli:work");
        if (occupied) {
          expect(profiles?.["anthropic:work"]).toMatchObject({ key: "synthetic-other-key" });
        }
        expect(repaired.auth?.order?.anthropic).toEqual([renamed]);
        expect(repaired.models?.providers?.anthropic?.apiKey).toBe(renamed);
        expect(repaired.models?.providers?.["literal-fixture"]?.apiKey).toBe(
          "literal-claude-cli:work",
        );
        expect(repaired.agents?.defaults?.utilityModel).toBe(`anthropic/test-model@${renamed}`);
        expect(repaired.agents?.defaults?.model).toEqual({
          primary: "anthropic/test-model",
          fallbacks: [`anthropic/test-model@20260101@${renamed}`],
        });
        expect(
          repaired.agents?.defaults?.models?.[`anthropic/test-model@${renamed}`],
        ).toMatchObject({ alias: "work-model" });
        expect(repaired.tools?.media?.models?.[0]).toMatchObject({
          profile: renamed,
          preferredProfile: renamed,
        });
        expect(repaired.mcp?.servers?.fixture?.oauth?.authProfileId).toBe(renamed);
        expect(repaired.plugins?.entries?.["llm-task"]?.config).toMatchObject({
          defaultAuthProfileId: renamed,
        });
        expect(repaired.messages?.responsePrefix).toBe(
          "literal anthropic/test-model@claude-cli:work",
        );
        expect(resolveUserProfileAuthLink({ profileId: person.id, providers: ["anthropic"] })).toBe(
          renamed,
        );
        const links = readStoredLinks(person.id);
        expect(links).toEqual({
          version: 1,
          links: { anthropic: { authProfileId: renamed, updatedAt: linkedAt }, openai: null },
        });

        runDoctor(state.env);

        expect(loadPersistedSharedAuthProfileStore(state.env)?.profiles).toEqual(profiles);
        expect(readStoredLinks(person.id)).toEqual(links);
        const repeated = (await readConfigFileSnapshot()).config;
        expect(repeated.agents?.defaults?.utilityModel).toEqual(
          repaired.agents?.defaults?.utilityModel,
        );
        expect(repeated.models?.providers?.anthropic?.apiKey).toBe(renamed);
      },
    );
  });
});
