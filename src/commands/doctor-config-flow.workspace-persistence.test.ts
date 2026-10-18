import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { setConfigValueAtPath } from "../config/config-paths.js";
import { promoteConfigSnapshotToLastKnownGood, readConfigFileSnapshot } from "../config/config.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import { saveCronJobsStore } from "../cron/store.js";
import { cronStoreKey } from "../cron/store/key.js";
import { loadCronRows } from "../cron/store/row-codec.js";
import {
  runInitialConfigWriteHealth,
  runWriteConfigHealth,
} from "../flows/doctor-health-contribution-runners.config.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  prepareDoctorContext,
  withDoctorConfigMaintenance,
} from "./doctor-config-flow.test-support.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";

function writeConfig(home: string, config: Record<string, unknown>) {
  return writeOpenClawConfig(home, {
    gateway: { mode: "local" },
    plugins: { enabled: false },
    ...config,
  });
}

const readText = (file: string) => fs.readFile(file, "utf8");
const readJson = async (file: string) => JSON.parse(await readText(file));
async function writeInitial(configPath: string) {
  await using ctx = await prepareDoctorContext(configPath);
  await runInitialConfigWriteHealth(ctx);
}

async function expectSettled(configPath: string, bytes?: string) {
  await using repeated = await prepareDoctorContext(configPath);
  expect(repeated.configResult.shouldWriteConfig).toBe(false);
  if (bytes !== undefined) {
    await runInitialConfigWriteHealth(repeated);
    expect(await readText(configPath)).toBe(bytes);
  }
}

function withHome(
  run: (home: string) => Promise<void>,
  environment: (home: string) => Record<string, string | undefined> = () => ({}),
) {
  return () =>
    withDoctorConfigPreflightHome((home) =>
      withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", ...environment(home) }, () =>
        run(home),
      ),
    );
}

afterEach(closeOpenClawStateDatabaseForTest);

it(
  "refuses retired config until the bridge release migrates it",
  withHome(async (home) => {
    const retired = {
      heartbeat: { every: "30m" },
      "agents.defaults.systemPromptOverride": "custom prompt",
      "agents.defaults.silentReplyRewrite": true,
      "agents.defaults.silentReply.direct": true,
      "agents.entries.ops.embeddedPi": {},
      "agents.entries.ops.embeddedHarness": {},
      "agents.entries.ops.agentRuntime": {},
      "agents.entries.ops.sandbox.perSession": true,
      "agents.entries.ops.memorySearch.store.path": "old.sqlite",
      "agents.defaults.model.timeoutMs": 20_000,
      "agents.defaults.subagents.model.timeoutMs": 10_000,
      "agents.entries.ops.model.timeoutMs": 20_000,
      "agents.entries.ops.subagents.model.timeoutMs": 10_000,
      "session.parentForkMaxTokens": 200_000,
      "browser.relayBindHost": "127.0.0.1",
      "browser.profiles.relay.cdpUrl": "http://127.0.0.1:18792",
      "models.providers.custom.api": "openai-codex-responses",
      "browser.ssrfPolicy.allowPrivateNetwork": true,
      "messages.queue.mode": "queue",
      "messages.queue.byChannel.discord": "steer-backlog",
      "messages.queue.byChannel.slack": "steer+backlog",
      "gateway.webchat": { chatHistoryMaxChars: 48_000 },
    };
    const config: Record<string, unknown> = {
      models: {
        providers: {
          custom: { models: [{ id: "legacy-model", api: "openai-codex-responses" }] },
        },
      },
      browser: { profiles: { relay: { driver: "extension" } } },
    };
    for (const [key, value] of Object.entries(retired)) {
      setConfigValueAtPath(config, key.split("."), value);
    }
    const configPath = await writeConfig(home, config);
    const original = await readText(configPath);
    expect((await readConfigFileSnapshot()).valid).toBe(false);
    const repair = writeInitial(configPath);
    for (const setting of [
      ...Object.keys(retired),
      "models.providers.custom.models.0.api",
      "2026.9.5",
      "openclaw doctor --fix",
      "latest",
    ]) {
      await expect.soft(repair).rejects.toThrow(setting);
    }
    expect.soft(await readText(configPath)).toBe(original);
    expect.soft((await readConfigFileSnapshot()).valid).toBe(false);
  }),
);

it(
  "upgrades the oldest supported July config and persists it only once",
  withHome(async (home) => {
    const preserved = [
      "discord:100000000000000002",
      "matrix:@owner:example.org",
      "slack:team:T123:user:U456",
      "unknown:user:123",
      "discord:user:user:123",
      "discord:user:",
      "discord:user:*",
      "123",
      456,
    ];
    // Unavailable channel contracts cannot prove it is safe to drop a target kind.
    const canonical = ["discord:user:100000000000000001", "telegram:user:123", "slack:user:U123"];
    const configPath = await writeConfig(home, {
      agents: { list: [{ id: "main" }] },
      // v2026.7.1-beta.1 (published July 2 UTC) admits this roster and ownerAllowFrom shape.
      meta: { lastTouchedVersion: "2026.7.1-beta.1" },
      commands: {
        ownerAllowFrom: [...canonical, ...preserved],
      },
    });
    await using ctx = await prepareDoctorContext(configPath);
    await runInitialConfigWriteHealth(ctx);
    expect(ctx.configWriteRefusal).toBeUndefined();
    const saved = await readConfigFileSnapshot();
    expect(saved.config.commands?.ownerAllowFrom).toEqual([...canonical, ...preserved]);
    const bytes = await readText(configPath);
    expect(JSON.parse(bytes).agents).toHaveProperty("entries.main");
    expect(JSON.parse(bytes).agents).not.toHaveProperty("list");
    await expectSettled(configPath, bytes);
  }),
);

it(
  "persists per-agent migrations with explicit ownership during a writable update",
  withHome(
    async (home) => {
      const defaults = {
        embeddedAgent: { projectSettingsPolicy: "trusted" },
        sandbox: { scope: "shared" },
      };
      const entries = {
        ops: {
          memorySearch: { enabled: false, extraPaths: [path.join(home, "notes")] },
          sandbox: { scope: "agent", browser: { enableNoVnc: true } },
          embeddedAgent: { executionContract: "default" },
          model: { primary: "openai/gpt-5.6-sol" },
        },
        research: { memory: { search: { provider: "auto" } } },
      };
      const configPath = await writeConfig(home, {
        meta: { migrations: { webhookListeners: true } },
        agents: {
          ownership: "explicit",
          defaults,
          list: Object.entries(entries).map(([id, entry]) => Object.assign({ id }, entry)),
        },
      });
      const original = await readText(configPath);
      expect((await readConfigFileSnapshot()).valid).toBe(false);
      await using ctx = await prepareDoctorContext(configPath);
      await runInitialConfigWriteHealth(ctx);
      expect(ctx.configWriteRefusal).toBeUndefined();
      expect(await readText(`${configPath}.bak`)).toBe(original);

      const saved = await readJson(configPath);
      expect(saved.agents).toMatchObject({ ownership: "explicit", defaults });
      expect(saved.agents.entries.ops).toEqual({
        memory: { search: entries.ops.memorySearch },
        sandbox: { scope: "agent", browser: { noVncEnabled: true } },
        embeddedAgent: entries.ops.embeddedAgent,
        model: entries.ops.model,
      });
      expect(saved.agents.entries.research).toEqual({
        memory: { search: { provider: "openai" } },
      });
      expect(saved.gateway).toEqual({ mode: "local" });
      expect((await readConfigFileSnapshot()).valid).toBe(true);
      await expectSettled(configPath);
    },
    () => ({
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
    }),
  ),
);

it(
  "preserves a markerless Main agent's shared workspace through Doctor persistence",
  withHome(
    async (home) => {
      const legacyId = " Main ";
      const workspace = path.join(home, "shared-workspace");
      await fs.mkdir(path.join(workspace, "memory"), { recursive: true });
      const originals =
        "AGENTS.md SOUL.md IDENTITY.md USER.md MEMORY.md memory/2026-07-01.md".split(" ");
      for (const name of originals) {
        await fs.writeFile(path.join(workspace, name), `Original ${name}\n`);
      }
      const configPath = await writeConfig(home, {
        agents: {
          defaults: { workspace },
          list: [{ id: legacyId }, { id: "other" }],
        },
      });
      expect((await readConfigFileSnapshot()).valid).toBe(false);
      await writeInitial(configPath);
      const saved = await readConfigFileSnapshot();
      expect(saved.valid).toBe(true);
      expect(saved.config.agents?.ownership).toBe("explicit");
      expect(saved.config.agents?.entries?.main?.workspace).toBe(workspace);
      expect(saved.config.agents?.defaults?.systemAgent).toEqual({ agentId: "main" });
      expect(saved.config.agents?.defaults?.heartbeat).toEqual({ agentId: "main" });
      expect(saved.config.bindings).toBeUndefined();
      expect(resolveAgentWorkspaceDir(saved.config, "main")).toBe(workspace);
      for (const name of originals) {
        expect(await readText(path.join(workspace, name))).toBe(`Original ${name}\n`);
      }
      await expectSettled(configPath);
    },
    () => ({ OPENCLAW_WORKSPACE_DIR: undefined }),
  ),
);

it(
  "repairs noncanonical workspace and heartbeat values through persistence",
  withHome(async (home) => {
    const configPath = await writeConfig(home, {
      agents: {
        list: [
          {
            id: " Ops ",
            workspace: null,
            heartbeat: { every: "30m", activeHours: { start: "99:99", end: "17:00" } },
          },
        ],
      },
    });
    expect((await readConfigFileSnapshot()).valid).toBe(false);
    await using ctx = await prepareDoctorContext(configPath);
    expect(ctx.configResult.shouldWriteConfig).toBe(true);
    expect(ctx.cfg.agents?.entries?.ops).toEqual({ heartbeat: { every: "30m" } });
    await runInitialConfigWriteHealth(ctx);

    const saved = await readJson(configPath);
    expect(saved.agents.entries.ops).toEqual({ heartbeat: { every: "30m" } });
    expect(saved.agents).not.toHaveProperty("list");
    expect((await readConfigFileSnapshot()).valid).toBe(true);
    await expectSettled(configPath);
  }),
);

it(
  "keeps the legacy owner on the shared workspace across later health writes",
  withHome(async (home) => {
    const workspace = path.join(home, "shared-workspace");
    const configPath = await writeConfig(home, {
      agents: {
        defaults: { workspace },
        entries: { main: { default: true }, cursor: { workspace } },
      },
    });
    await using ctx = await prepareDoctorContext(configPath);

    await runInitialConfigWriteHealth(ctx);
    expect((await readConfigFileSnapshot()).config.agents?.entries?.main?.workspace).toBe(
      workspace,
    );

    ctx.cfg = { ...ctx.cfg, gateway: { ...ctx.cfg.gateway, bind: "lan" } };
    await runWriteConfigHealth(ctx);

    const snapshot = await readConfigFileSnapshot();
    expect(snapshot).toMatchObject({
      valid: true,
      config: { agents: { ownership: "explicit", entries: { main: { workspace } } } },
    });
  }),
);

it(
  "persists cron runtime policy on the retained owner before rewriting its model",
  withHome(
    async (home) => {
      const configPath = await writeConfig(home, {
        agents: {
          defaults: { systemAgent: { agentId: "ops" } },
          entries: { main: { default: true }, ops: {} },
        },
      });
      const storePath = path.join(home, ".openclaw", "cron", "jobs.json");
      await saveCronJobsStore(storePath, {
        version: 1,
        jobs: [
          makeCronJob({
            id: "retained-owner",
            enabled: false,
            payload: {
              kind: "agentTurn",
              message: "Do not run this disabled job",
              model: "codex/gpt-5.6-sol",
            },
          }),
        ],
      });
      const seededRows = loadCronRows(openOpenClawStateDatabase().db, cronStoreKey(storePath));
      expect(seededRows).toMatchObject([{ agent_id: null }]);
      const seededJob: unknown = JSON.parse(seededRows[0]!.job_json);
      expect(seededJob).not.toHaveProperty("agentId");
      expect(seededJob).toMatchObject({ payload: { model: "codex/gpt-5.6-sol" } });

      let first: { policies: unknown; rows: unknown } | undefined;
      for (const pass of [1, 2]) {
        await withDoctorConfigMaintenance(async () => {
          await using ctx = await prepareDoctorContext(configPath);
          await runInitialConfigWriteHealth(ctx);
          await runWriteConfigHealth(ctx);
        });
        const snapshot = await readConfigFileSnapshot();
        const policies = {
          main: snapshot.config.agents?.entries?.main?.models,
          ops: snapshot.config.agents?.entries?.ops?.models,
        };
        const rows = loadCronRows(openOpenClawStateDatabase().db, cronStoreKey(storePath));
        expect.soft(snapshot.valid, `pass ${pass}`).toBe(true);
        expect.soft(snapshot.config.agents?.defaults?.systemAgent?.agentId).toBe("ops");
        expect.soft(policies, `pass ${pass}`).toEqual({
          main: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
          ops: undefined,
        });
        expect.soft(rows).toMatchObject([{ agent_id: "main" }]);
        const jobs = rows.map((row) => JSON.parse(row.job_json));
        expect
          .soft(jobs, `pass ${pass}`)
          .toMatchObject([{ agentId: "main", payload: { model: "openai/gpt-5.6-sol" } }]);
        if (pass === 2) {
          expect.soft({ policies, rows }).toEqual(first);
        }
        first = { policies, rows };
      }
    },
    (home) => ({ OPENCLAW_STATE_DIR: path.join(home, ".openclaw") }),
  ),
);

it(
  "refuses retired Talk selectors in prefixed config before recovery",
  withHome(async (home) => {
    const canonical = {
      talk: { realtime: { provider: "openai", speakerVoice: "marin" } },
      gateway: { mode: "local" },
      plugins: { enabled: false },
    };
    const configPath = await writeOpenClawConfig(home, canonical);
    expect(await promoteConfigSnapshotToLastKnownGood(await readConfigFileSnapshot())).toBe(true);
    const backup = await readText(configPath);
    await fs.writeFile(`${configPath}.bak`, backup);
    const retired = {
      ...canonical,
      talk: {
        ...canonical.talk,
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
        model: "gpt-realtime",
        voice: "alloy",
      },
    };
    const original = `Found and updated: False\n${JSON.stringify(retired)}\n`;
    await fs.writeFile(configPath, original);
    await expect
      .soft(writeInitial(configPath))
      .rejects.toThrow(
        /talk\.mode, talk\.transport, talk\.brain, talk\.model, talk\.voice[\s\S]*2026\.9\.5[\s\S]*openclaw doctor --fix/,
      );
    expect.soft(await readText(configPath)).toBe(original);
    expect.soft(await readText(`${configPath}.bak`)).toBe(backup);
    expect.soft(await readText(`${configPath}.last-good`)).toBe(backup);
  }),
);
