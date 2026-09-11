import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "@lydell/node-pty";
import { afterEach, describe, expect, it } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { loadPersistedSharedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import {
  runAuthProfileWriteTransaction,
  writePersistedAuthProfileStoreRaw,
} from "../agents/auth-profiles/sqlite.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadCronJobsStore, resolveCronJobsStorePath, saveCronJobsStore } from "../cron/store.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
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
  closeOpenClawAgentDatabasesForTest();
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

async function runInteractiveDoctor(env: NodeJS.ProcessEnv, expectImport: boolean) {
  closeOpenClawAgentDatabasesForTest();
  const child = spawn(process.execPath, ["openclaw.mjs", "doctor"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    cols: 240,
    rows: 40,
    name: "xterm-256color",
    env: {
      ...env,
      NODE_ENV: undefined,
      VITEST: undefined,
      OPENCLAW_NO_RESPAWN: "1",
      TERM: "xterm-256color",
      NO_COLOR: "1",
    },
  });
  let output = "";
  let answeredThrough = 0;
  let importsAccepted = 0;
  let failure: string | undefined;
  const exitCode = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      failure = "Interactive Doctor did not exit";
      child.kill();
    }, 60_000);
    child.onData((data) => {
      output += data;
      if (failure) {
        return;
      }
      const pending = stripAnsi(output).slice(answeredThrough);
      const prompt = /◆\s+([^\r\n]+)\r?\n[│\s]*[●○]\s+Yes\s*\/\s*[●○]\s+No/.exec(pending);
      if (!prompt) {
        return;
      }
      answeredThrough += prompt.index + prompt[0].length;
      const question = prompt[1]!.trim();
      if (
        question === "Migrate auth profile JSON files into SQLite now?" ||
        question === "Apply recommended config repairs now?"
      ) {
        if (question.startsWith("Migrate auth")) {
          importsAccepted++;
        }
        child.write("y");
      } else if (
        /^(?:Rebuild stale Control UI assets now|Build Control UI assets now|Update OpenClaw from git before running doctor|Migrate generated provider model catalogs into agent SQLite now|Repair model credentials in agent SQLite now|Tighten permissions on .+ to (?:700|600)|Disable \d+ unavailable skills in config|Enable \w+ shell completion for openclaw|Create .+ at .+)\?$/.test(
          question,
        )
      ) {
        child.write("n");
      } else {
        failure = `Unexpected Doctor prompt: ${question}`;
        child.kill();
      }
    });
    child.onExit((event) => {
      clearTimeout(timeout);
      if (failure) {
        reject(new Error(`${failure}\n${stripAnsi(output)}`));
      } else {
        resolve(event.exitCode);
      }
    });
  });
  expect(exitCode, stripAnsi(output)).toBe(0);
  expect(importsAccepted, stripAnsi(output)).toBe(expectImport ? 1 : 0);
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
    {
      name: "unoccupied destination and padded references",
      interactive: false,
      occupied: false,
      renamed: "anthropic:work",
      reference: " claude-cli:work ",
    },
    {
      name: "occupied destination",
      interactive: false,
      occupied: true,
      renamed: "anthropic:cli-work",
      reference: "claude-cli:work",
    },
    {
      name: "interactive Doctor command",
      interactive: true,
      occupied: false,
      renamed: "anthropic:work",
      reference: "claude-cli:work",
    },
  ])(
    "preserves selected accounts with an $name, an older installed plugin, and on repeat",
    async ({ interactive, occupied, renamed, reference }) => {
      await withOpenClawTestState(
        {
          prefix: "openclaw-doctor-auth-consumers-",
          scenario: "external-service",
          env: {
            OPENCLAW_BUNDLED_PLUGINS_DIR: fileURLToPath(
              new URL("../../extensions", import.meta.url),
            ),
          },
        },
        async (state) => {
          const manifest = await state.writeJson("old-llm-task/openclaw.plugin.json", {
            id: "llm-task",
            doctorContract: { configRepair: true },
            configSchema: {
              type: "object",
              additionalProperties: false,
              properties: {
                authProfileId: { type: "string" },
                defaultAuthProfileId: { type: "string" },
                selectedContract: { type: "string" },
              },
            },
          });
          await state.writeText(
            "old-llm-task/index.ts",
            'export default { id: "llm-task", register() {} };',
          );
          await state.writeText(
            "old-llm-task/doctor-contract-api.ts",
            `
          export function normalizeCompatibilityConfig({ cfg }) {
            if (cfg.plugins.entries["llm-task"].config.selectedContract === "installed") {
              return { config: cfg, changes: [] };
            }
            const config = structuredClone(cfg);
            config.plugins.entries["llm-task"].config.selectedContract = "installed";
            return { config, changes: ["Selected the older installed contract."] };
          }
        `,
          );
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
                  apiKey: reference,
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
                  oauth: { authProfileId: reference },
                },
              },
            },
            plugins: {
              allow: ["anthropic", "llm-task"],
              load: { paths: [path.dirname(manifest)] },
              slots: { memory: "none" },
              entries: {
                "llm-task": {
                  enabled: true,
                  llm: { allowModelOverride: true, allowAuthProfileOverride: true },
                  config: {
                    defaultAuthProfileId: reference,
                    authProfileId: reference,
                  },
                },
              },
            },
            messages: { responsePrefix: "literal anthropic/test-model@claude-cli:work" },
          };
          await state.writeConfig(config);
          const cronStorePath = resolveCronJobsStorePath();
          await saveCronJobsStore(cronStorePath, {
            version: 1,
            jobs: [
              {
                id: "profile-consumer",
                agentId: "main",
                name: "Synthetic reminder",
                enabled: false,
                createdAtMs: 1,
                updatedAtMs: 1,
                schedule: { kind: "every", everyMs: 60000 },
                sessionTarget: "isolated",
                wakeMode: "now",
                state: {},
                payload: {
                  kind: "agentTurn",
                  message: "Synthetic reminder",
                  model: "anthropic/test-model@claude-cli:work",
                  fallbacks: ["anthropic/test-model@20260101@claude-cli:work"],
                },
              },
            ],
          });
          if (interactive) {
            await state.writeJson("agents/main/agent/auth-profiles.json", {
              version: 1,
              profiles: {
                "claude-cli:work": {
                  type: "api_key",
                  provider: "anthropic",
                  key: "synthetic-work-key",
                },
              },
            });
          }
          runAuthProfileWriteTransaction(
            undefined,
            (database) =>
              writePersistedAuthProfileStoreRaw(
                {
                  version: 1,
                  profiles: {
                    [interactive ? "anthropic:control" : "claude-cli:work"]: {
                      type: "api_key",
                      provider: "anthropic",
                      key: interactive ? "synthetic-control-key" : "synthetic-work-key",
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
          const sessionEntry = {
            updatedAt: 1,
            modelProvider: "anthropic",
            model: "test-model",
            authProfileOverride: reference,
            authProfileOverrideSource: "user" as const,
            modelFallback: {
              prevModel: "test-model",
              prevProvider: "anthropic",
              prevAuthProfileOverride: reference,
              prevAuthProfileOverrideSource: "user-link" as const,
              prevAuthProfileOverrideCompactionCount: 3,
              prevThinkingLevel: "low",
              lastValidatedPatchTs: 1,
              ts: 2,
              source: "agent-patch" as const,
            },
          };
          const unmapped = " unrelated:account ";
          const sessionEntries = {
            pins: sessionEntry,
            rollback: { ...sessionEntry, authProfileOverride: unmapped },
            unmapped: {
              ...sessionEntry,
              authProfileOverride: unmapped,
              modelFallback: { ...sessionEntry.modelFallback, prevAuthProfileOverride: unmapped },
            },
            protected: { ...sessionEntry, agentHarnessId: "openclaw", modelSelectionLocked: true },
          };
          const sessionScope = (name: string) => ({
            agentId: "main",
            sessionKey: `agent:main:${name}`,
            env: state.env,
          });
          for (const [name, entry] of Object.entries(sessionEntries)) {
            await replaceSessionEntry(sessionScope(name), { ...entry, sessionId: name });
          }
          const readSessions = () =>
            Object.fromEntries(
              Object.keys(sessionEntries).map((name) => [
                name,
                loadSessionEntry(sessionScope(name)),
              ]),
            );
          const savedSessions = readSessions();
          await (interactive ? runInteractiveDoctor(state.env, true) : runDoctor(state.env));

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
            authProfileId: renamed,
            selectedContract: "installed",
          });
          expect(repaired.messages?.responsePrefix).toBe(
            "literal anthropic/test-model@claude-cli:work",
          );
          expect(
            resolveUserProfileAuthLink({ profileId: person.id, providers: ["anthropic"] }),
          ).toBe(renamed);
          const links = readStoredLinks(person.id);
          expect(links).toEqual({
            version: 1,
            links: { anthropic: { authProfileId: renamed, updatedAt: linkedAt }, openai: null },
          });
          const savedPayload = (await loadCronJobsStore(cronStorePath)).jobs[0]?.payload;
          expect(savedPayload).toEqual({
            kind: "agentTurn",
            message: "Synthetic reminder",
            model: `anthropic/test-model@${renamed}`,
            fallbacks: [`anthropic/test-model@20260101@${renamed}`],
          });
          const repairedSessions = readSessions();
          for (const name of ["pins", "rollback"]) {
            expect(repairedSessions[name]).toEqual({
              ...savedSessions[name],
              updatedAt: expect.any(Number),
              authProfileOverride: name === "pins" ? renamed : unmapped,
              modelFallback: { ...sessionEntry.modelFallback, prevAuthProfileOverride: renamed },
            });
          }
          for (const name of ["unmapped", "protected"]) {
            expect(repairedSessions[name]).toEqual(savedSessions[name]);
          }

          await (interactive ? runInteractiveDoctor(state.env, false) : runDoctor(state.env));

          expect((await loadCronJobsStore(cronStorePath)).jobs[0]?.payload).toEqual(savedPayload);
          expect(readSessions()).toEqual(repairedSessions);
          expect(loadPersistedSharedAuthProfileStore(state.env)?.profiles).toEqual(profiles);
          expect(readStoredLinks(person.id)).toEqual(links);
          const repeated = (await readConfigFileSnapshot()).config;
          expect(repeated.agents?.defaults?.utilityModel).toEqual(
            repaired.agents?.defaults?.utilityModel,
          );
          expect(repeated.models?.providers?.anthropic?.apiKey).toBe(renamed);
        },
      );
    },
  );
});
