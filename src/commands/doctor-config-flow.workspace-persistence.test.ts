import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { listConfiguredOwnerInputs } from "../agents/prepared-model-runtime.configured.js";
import { setConfigValueAtPath } from "../config/config-paths.js";
import { promoteConfigSnapshotToLastKnownGood, readConfigFileSnapshot } from "../config/config.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import {
  loadCronJobsStore,
  resolveCronJobsStorePathFromConfig,
  saveCronJobsStore,
} from "../cron/store.js";
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
import {
  useDoctorConfigPreflightHome,
  withDoctorConfigPreflightHome,
} from "./doctor-config-preflight.test-support.js";

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

const withQueueDefaultHome = useDoctorConfigPreflightHome();

afterEach(closeOpenClawStateDatabaseForTest);

it(
  "keeps a valid Kubernetes reseed without metadata and still recovers a later invalid config",
  withHome(async (home) => {
    const configPath = await writeConfig(home, { gateway: { mode: "local", port: 19091 } });
    await writeInitial(configPath);
    const baseline = await readConfigFileSnapshot();
    expect(await promoteConfigSnapshotToLastKnownGood(baseline)).toBe(true);
    for (const suffix of [".bak", ".bak.1"]) {
      await fs.copyFile(configPath, `${configPath}${suffix}`);
    }
    const { meta: _meta, ...reseeded } = await readJson(configPath);
    reseeded.gateway.port = 19092;
    const reseededRaw = JSON.stringify(reseeded, null, 2);
    await fs.unlink(configPath);
    await fs.writeFile(configPath, reseededRaw);

    await using ctx = await prepareDoctorContext(configPath);
    expect(ctx.cfg.gateway?.port).toBe(19092);
    expect(await readText(configPath)).toBe(reseededRaw);
    expect(await fs.readdir(path.dirname(configPath))).not.toEqual(
      expect.arrayContaining([expect.stringContaining(".clobbered.")]),
    );
    // Gateway startup promotes the accepted config; the meta-less reseed must qualify.
    expect(await promoteConfigSnapshotToLastKnownGood(await readConfigFileSnapshot())).toBe(true);

    const invalidRaw = '{ "gateway": { "mode": 123 } }';
    await fs.writeFile(configPath, invalidRaw);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await using recovered = await prepareDoctorContext(configPath);
      expect(recovered.cfg.gateway?.port).toBe(19092);
      const clobbered = (await fs.readdir(path.dirname(configPath))).filter((name) =>
        name.includes(".clobbered."),
      );
      expect(clobbered).toHaveLength(1);
      const originalPath = path.join(path.dirname(configPath), clobbered[0]!);
      expect(await readText(originalPath)).toBe(invalidRaw);
      const warnings = warn.mock.calls.flat().join("\n");
      expect(warnings).toContain(originalPath);
      expect(warnings).toContain("to undo, stop the Gateway and copy it back");
    } finally {
      warn.mockRestore();
    }
  }),
);

it.each([
  { included: true, otherRepair: false, value: undefined },
  { included: false, otherRepair: true, value: undefined },
  { included: true, otherRepair: false, value: false },
  { included: true, otherRepair: false, value: true },
])(
  "keeps steering defaults runtime-only and preserves authored config (included=$included, other repair=$otherRepair, value=$value)",
  async ({ included, otherRepair, value }) => {
    await withQueueDefaultHome(async (home) => {
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const messages = {
          responsePrefix: "keep-prefix",
          ...(value === undefined ? {} : { queue: { allowCollaborativeSteering: value } }),
        };
        const configPath = await writeOpenClawConfig(home, {
          agents: {
            entries: { main: otherRepair ? { $include: "./agent.json" } : {} },
          },
          gateway: { mode: "local" },
          plugins: { enabled: false },
          ...(included ? { messages: { $include: "./messages.json" } } : {}),
        });
        const includePath = path.join(path.dirname(configPath), "messages.json");
        const includeRaw = JSON.stringify(messages);
        if (included) {
          await fs.writeFile(includePath, includeRaw);
        }
        const agentPath = path.join(path.dirname(configPath), "agent.json");
        const agentRaw = '{"sandbox":{"browser":{"enableNoVnc":true}}}';
        if (otherRepair) {
          await fs.writeFile(agentPath, agentRaw);
        }
        const before = await fs.readFile(configPath, "utf8");
        expect(
          (await readConfigFileSnapshot()).sourceConfig.messages?.queue?.allowCollaborativeSteering,
        ).toBe(value);
        await using ctx = await prepareDoctorContext(configPath);
        expect(await fs.readFile(configPath, "utf8")).toBe(before);
        if (included) {
          expect(await fs.readFile(includePath, "utf8")).toBe(includeRaw);
        }
        // A later root-owned repair must leave included steering policy untouched.
        if (!otherRepair) {
          ctx.cfg = { ...ctx.cfg, gateway: { ...ctx.cfg.gateway, port: 18880 } };
        }
        expect(await runWriteConfigHealth(ctx, { runPostWriteRepairs: false })).toBe(true);
        expect(ctx.configWriteRefusal).toBeUndefined();
        const saved = await readConfigFileSnapshot();
        expect(saved.valid).toBe(true);
        expect(saved.sourceConfig.messages?.queue?.allowCollaborativeSteering).toBe(value);
        expect(saved.runtimeConfig.messages?.queue?.allowCollaborativeSteering).toBe(value ?? true);
        expect(saved.sourceConfig.gateway?.port).toBe(otherRepair ? undefined : 18880);
        expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(before);
        if (included) {
          expect(saved.parsed).toHaveProperty("messages", { $include: "./messages.json" });
          expect(saved.sourceConfig.messages?.responsePrefix).toBe("keep-prefix");
          expect(await fs.readFile(includePath, "utf8")).toBe(includeRaw);
        }
        if (otherRepair) {
          expect(saved.parsed).toHaveProperty("agents.entries.main", {
            $include: "./agent.json",
          });
          expect(saved.sourceConfig.agents?.entries?.main?.sandbox?.browser?.noVncEnabled).toBe(
            true,
          );
          expect(await fs.readFile(`${agentPath}.bak`, "utf8")).toBe(agentRaw);
        }
        const bytes = await fs.readFile(configPath, "utf8");
        await using repeated = await prepareDoctorContext(configPath);
        expect(repeated.configResult.shouldWriteConfig).toBe(false);
        await runInitialConfigWriteHealth(repeated);
        expect(await fs.readFile(configPath, "utf8")).toBe(bytes);
      });
    });
  },
);

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
      expect(saved.messages?.queue?.allowCollaborativeSteering).toBeUndefined();
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
      expect(saved.config.agents?.defaults).not.toHaveProperty("heartbeat");
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

it.each(["agent", "defaults"] as const)(
  "retains invalid %s heartbeat hours until corrected through persistence",
  (scope) =>
    withHome(async (home) => {
      const perAgent = scope === "agent";
      const invalid = perAgent ? "6:00" : "9:00";
      const corrected = perAgent ? "06:00" : "09:00";
      const expectedHours = perAgent
        ? { start: "22:00", end: "06:00", timezone: "user" }
        : { start: "09:00", end: "17:00", timezone: "user" };
      const night = {
        id: "night",
        workspace: null,
        heartbeat: { activeHours: { start: "22:00", end: invalid } },
      };
      const configPath = await writeConfig(home, {
        agents: {
          defaults: {
            heartbeat: {
              every: perAgent ? "30m" : undefined,
              target: "none",
              activeHours: perAgent
                ? { start: "08:00", end: "20:00" }
                : { start: invalid, end: "17:00" },
            },
          },
          list: [{ id: "main", default: true }, ...(perAgent ? [night] : [])],
        },
      });
      const original = await readText(configPath);
      const storePath = resolveCronJobsStorePathFromConfig({});
      {
        await using ctx = await prepareDoctorContext(configPath);
        await runInitialConfigWriteHealth(ctx);
        expect(ctx.configWriteRefusal).toBe("validation");
        expect(await readText(configPath)).toBe(original);
        expect((await loadCronJobsStore(storePath)).jobs).toEqual([]);
        const diagnostic = ctx.configResult.warnings?.join("\n") ?? "";
        expect(diagnostic).toContain(
          perAgent
            ? "agents.entries.night.heartbeat.activeHours.end"
            : "agents.defaults.heartbeat.activeHours.start",
        );
        expect(diagnostic).toContain(JSON.stringify(invalid));
        expect(diagnostic).toContain("openclaw doctor --fix");
      }
      await fs.writeFile(
        configPath,
        original.replace(JSON.stringify(invalid), JSON.stringify(corrected)),
      );
      await writeInitial(configPath);
      const saved = await readConfigFileSnapshot();
      expect(saved.valid).toBe(true);
      expect(saved.config.agents?.defaults).not.toHaveProperty("heartbeat");
      expect(saved.config.agents?.entries?.[perAgent ? "night" : "main"]).not.toHaveProperty(
        "heartbeat",
      );
      const migrated = await loadCronJobsStore(storePath);
      expect(migrated.jobs).toHaveLength(1);
      expect(migrated.jobs[0]).toMatchObject({
        agentId: perAgent ? "night" : "main",
        enabled: true,
        schedule: { kind: "every", everyMs: 30 * 60 * 1000 },
        payload: { kind: "agentTurn", skipIfScratchEmpty: true },
        idleOnly: true,
        activeHours: expectedHours,
      });
      await expectSettled(configPath);
      expect(await loadCronJobsStore(storePath)).toEqual(migrated);
    })(),
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

const convergedRoster = (workspace: string) => ({
  agents: {
    ownership: "explicit",
    defaults: { workspace, systemAgent: { agentId: "main" } },
    entries: { main: {}, dev: {} },
  },
});
const mainLaunchDir = (config: OpenClawConfig, workspace: string) =>
  listConfiguredOwnerInputs(config, workspace).find((input) => input.agentId === "main")
    ?.workspaceDir;

it(
  "copies shared-workspace files into a converged system agent's directory and pins it",
  withHome(async (home) => {
    const workspace = path.join(home, "shared-workspace");
    await fs.mkdir(path.join(workspace, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspace, "SOUL.md"), "root persona");
    const configPath = await writeConfig(home, convergedRoster(workspace));
    const before = (await readConfigFileSnapshot()).config;
    expect(resolveAgentWorkspaceDir(before, "main")).toBe(path.join(workspace, "main"));

    await writeInitial(configPath);

    const after = (await readConfigFileSnapshot()).config;
    expect(after.agents?.entries?.main?.workspace).toBe(path.join(workspace, "main"));
    expect(resolveAgentWorkspaceDir(after, "main")).toBe(path.join(workspace, "main"));
    expect(mainLaunchDir(after, workspace)).toBe(path.join(workspace, "main"));
    expect(await readText(path.join(workspace, "main", "SOUL.md"))).toBe("root persona");
    expect(await readText(path.join(workspace, "SOUL.md"))).toBe("root persona");
  }),
);

it(
  "copies files only once an interactive preview is accepted",
  withHome(async (home) => {
    const workspace = path.join(home, "shared-workspace");
    const agentDir = path.join(workspace, "main");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "SOUL.md"), "root persona");
    const configPath = await writeConfig(home, convergedRoster(workspace));
    const preview = { options: { nonInteractive: false, repair: false } };

    await runInitialConfigWriteHealth(
      await prepareDoctorContext(configPath, { ...preview, confirm: async () => false }),
    );

    expect((await readConfigFileSnapshot()).config.agents?.entries?.main?.workspace).toBe(
      undefined,
    );
    await expect(fs.access(path.join(agentDir, "SOUL.md"))).rejects.toThrow();

    await runInitialConfigWriteHealth(
      await prepareDoctorContext(configPath, { ...preview, confirm: async () => true }),
    );

    expect((await readConfigFileSnapshot()).config.agents?.entries?.main?.workspace).toBe(agentDir);
    expect(await readText(path.join(agentDir, "SOUL.md"))).toBe("root persona");
  }),
);
it(
  "keeps the authored env root when agents.defaults comes from an include",
  withHome(
    async (home) => {
      const workspace = path.join(home, "shared-workspace");
      const moved = path.join(home, "moved-workspace");
      await fs.mkdir(path.join(workspace, "main", "memory"), { recursive: true });
      await fs.writeFile(path.join(workspace, "main", "SOUL.md"), "agent persona");
      await fs.mkdir(path.join(home, ".openclaw"), { recursive: true });
      await fs.writeFile(
        path.join(home, ".openclaw", "defaults.json5"),
        '{ workspace: "${WORKSPACE_ROOT}", systemAgent: { agentId: "main" } }\n',
      );
      const configPath = await writeConfig(home, {
        agents: {
          ownership: "explicit",
          defaults: { $include: "./defaults.json5" },
          entries: { main: {}, dev: {} },
        },
      });

      await writeInitial(configPath);

      const written = await readJson(configPath);
      expect(written.agents.defaults).toEqual({ $include: "./defaults.json5" });
      expect(written.agents.entries.main.workspace).toBe("${WORKSPACE_ROOT}/main");
      const after = (await readConfigFileSnapshot()).config;
      expect(resolveAgentWorkspaceDir(after, "main")).toBe(path.join(workspace, "main"));
      expect(resolveAgentWorkspaceDir(after, "dev")).toBe(path.join(workspace, "dev"));

      process.env.WORKSPACE_ROOT = moved;
      const reloaded = (await readConfigFileSnapshot()).config;
      expect(resolveAgentWorkspaceDir(reloaded, "main")).toBe(path.join(moved, "main"));
      expect(resolveAgentWorkspaceDir(reloaded, "dev")).toBe(path.join(moved, "dev"));
    },
    (home) => ({ WORKSPACE_ROOT: path.join(home, "shared-workspace") }),
  ),
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
