import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConfigIO, resetConfigRuntimeState } from "../../../config/io.js";
import { tryResolveLegacyCompatibilityAgentId } from "../../../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { makeCronJob } from "../../../cron/delivery.test-helpers.js";
import { cronStoreKey } from "../../../cron/store/key.js";
import { replaceCronRows } from "../../../cron/store/row-codec.js";
import { writeConfigMachineState } from "../../../state/config-machine-state-write.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { createCanonicalAgentConfigFixture } from "../../../test-utils/config-roster.js";

const roots: string[] = [];

function configIO(root: string, env: NodeJS.ProcessEnv = { HOME: root, OPENCLAW_TEST_FAST: "1" }) {
  return createConfigIO({
    configPath: path.join(root, "openclaw.json"),
    env,
    homedir: () => root,
    observe: false,
    logger: { warn: () => {}, error: () => {} },
  });
}

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  resetConfigRuntimeState();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("default role materialization authored writes", () => {
  it("preserves env references and includes and is idempotent after persistence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-default-roles-"));
    roots.push(root);
    const configPath = path.join(root, "openclaw.json");
    const channelsPath = path.join(root, "channels.json5");
    const includeRaw = `${JSON.stringify({ telegram: { enabled: true } }, null, 2)}\n`;
    await fs.writeFile(channelsPath, includeRaw, "utf-8");
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          agents: {
            defaults: { model: "${DEFAULT_MODEL}", workspace: "/srv/ops" },
            entries: {
              ops: { default: true },
              research: { model: "${RESEARCH_MODEL}" },
            },
          },
          channels: { $include: "./channels.json5" },
          talk: { provider: "test" },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const io = configIO(root, {
      HOME: root,
      OPENCLAW_TEST_FAST: "1",
      DEFAULT_MODEL: "openai/default-model",
      RESEARCH_MODEL: "openai/research-model",
    });

    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.valid).toBe(false);
    expect(snapshot.sourceConfig).toHaveProperty("agents.entries.ops.default", true);
    expect(snapshot.sourceConfig.agents?.defaults?.heartbeat?.agentId).toBeUndefined();
    const doctorCandidate = createCanonicalAgentConfigFixture(snapshot.sourceConfig, {
      env: { HOME: root },
      homedir: () => root,
    }).config;
    await io.writeConfigFile(doctorCandidate, {
      baseSnapshot: snapshot,
      explicitSetPaths: [
        ["agents", "entries"],
        ["agents", "ownership"],
      ],
      explicitSetValueSource: doctorCandidate,
    });

    const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as OpenClawConfig;
    expect(persisted.agents?.defaults?.model).toBe("${DEFAULT_MODEL}");
    expect(persisted.agents?.entries?.ops?.workspace).toBe("/srv/ops");
    expect(persisted.agents?.ownership).toBe("explicit");
    expect(persisted.agents?.entries?.research?.model).toBe("${RESEARCH_MODEL}");
    expect(persisted.agents?.entries?.ops).not.toHaveProperty("default");
    expect(persisted.channels).toEqual({ $include: "./channels.json5" });
    await expect(fs.readFile(channelsPath, "utf-8")).resolves.toBe(includeRaw);
    expect(persisted.bindings).toContainEqual({
      agentId: "ops",
      match: { channel: "telegram", accountId: "*" },
    });
    expect(persisted).not.toHaveProperty("agents.defaults.heartbeat");
    expect(persisted.agents?.defaults?.authInheritance?.agentId).toBe("ops");
    expect(persisted.talk?.agentId).toBe("ops");

    const firstPersisted = await fs.readFile(configPath, "utf-8");
    const reread = await io.readConfigFileSnapshot();
    await io.writeConfigFile(reread.config, { baseSnapshot: reread });
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(firstPersisted);

    const topology = await io.readConfigFileSnapshot();
    await io.writeConfigFile(
      {
        ...topology.config,
        agents: {
          ...topology.config.agents,
          ownership: undefined,
          entries: { ...topology.config.agents?.entries, writer: {} },
        },
      },
      { baseSnapshot: topology },
    );
    const rewritten = JSON.parse(await fs.readFile(configPath, "utf-8"));
    expect(rewritten.agents).toMatchObject({ ownership: "explicit", entries: { writer: {} } });
  });

  it.each([true, false])(
    "pins a replaced sole fixed-store owner only when the store is unchanged: %s",
    async (sameStore) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-owner-"));
      roots.push(root);
      const configPath = path.join(root, "openclaw.json");
      const sourceStore = path.join(root, "source-sessions.json");
      await fs.writeFile(
        configPath,
        JSON.stringify({ agents: { entries: { ops: {} } }, session: { store: sourceStore } }),
      );
      const io = configIO(root);
      const snapshot = await io.readConfigFileSnapshot();
      await io.writeConfigFile(
        {
          ...snapshot.config,
          agents: { ownership: "explicit", entries: { research: {} } },
          session: {
            store: sameStore ? sourceStore : path.join(root, "destination-sessions.json"),
          },
        },
        { baseSnapshot: snapshot, allowedAgentRosterRemovals: ["ops"] },
      );
      const persisted = JSON.parse(await fs.readFile(configPath, "utf8"));
      expect(persisted.agents?.defaults?.sessionStore?.agentId).toBe(sameStore ? "ops" : undefined);
    },
  );

  it.each([
    ["another fixed store", "destination-sessions.json"],
    ["a per-agent store", "sessions-{agentId}.json"],
  ])("drops a persisted fixed-store owner when switching to %s", async (_label, storeName) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-owner-switch-"));
    roots.push(root);
    const configPath = path.join(root, "openclaw.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "ops" } },
          entries: { ops: {}, research: {} },
        },
        session: { store: path.join(root, "source-sessions.json") },
      }),
    );
    const io = configIO(root);
    const snapshot = await io.readConfigFileSnapshot();

    await io.writeConfigFile(
      {
        ...snapshot.config,
        session: { ...snapshot.config.session, store: path.join(root, storeName) },
      },
      { baseSnapshot: snapshot },
    );

    const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
    expect(persisted.agents?.defaults?.sessionStore?.agentId).toBeUndefined();
  });

  it("keeps an explicitly supplied owner when switching fixed stores", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-owner-switch-"));
    roots.push(root);
    const configPath = path.join(root, "openclaw.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "ops" } },
          entries: { ops: {}, research: {} },
        },
        session: { store: path.join(root, "source-sessions.json") },
      }),
    );
    const io = configIO(root);
    const snapshot = await io.readConfigFileSnapshot();
    const nextConfig: OpenClawConfig = {
      ...snapshot.config,
      agents: {
        ...snapshot.config.agents,
        defaults: {
          ...snapshot.config.agents?.defaults,
          sessionStore: { agentId: "research" },
        },
      },
      session: { ...snapshot.config.session, store: path.join(root, "destination-sessions.json") },
    };

    await io.writeConfigFile(nextConfig, {
      baseSnapshot: snapshot,
      explicitSetPaths: [["agents", "defaults", "sessionStore", "agentId"]],
      explicitSetValueSource: nextConfig,
    });

    const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
    expect(persisted.agents?.defaults?.sessionStore?.agentId).toBe("research");
  });

  it("pins the survivor's previous workspace during a generic roster collapse", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-collapse-"));
    roots.push(root);
    const configPath = path.join(root, "openclaw.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        agents: {
          ownership: "explicit",
          defaults: { workspace: "/srv/fleet" },
          entries: { ops: {}, research: {} },
        },
      }),
    );
    const io = configIO(root);
    const snapshot = await io.readConfigFileSnapshot();

    await io.writeConfigFile(
      {
        ...snapshot.config,
        agents: {
          ...snapshot.config.agents,
          ownership: undefined,
          entries: { research: {} },
        },
      },
      { baseSnapshot: snapshot, allowedAgentRosterRemovals: ["ops"] },
    );

    const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
    expect(persisted.agents?.entries?.research?.workspace).toBe("/srv/fleet/research");
  });

  it.each([
    ["pins the replaced owner", "research", false, "ops"],
    ["keeps an explicitly authored owner", "research", true, "research"],
    ["does nothing when the owner is unchanged", "ops", false, undefined],
  ] as const)(
    "%s during generic roster writes",
    async (_label, targetAgentId, explicit, expected) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-owner-transition-"));
      roots.push(root);
      const configPath = path.join(root, "openclaw.json");
      await fs.writeFile(configPath, JSON.stringify({ agents: { entries: { ops: {} } } }));
      const io = configIO(root);
      const snapshot = await io.readConfigFileSnapshot();
      const nextConfig: OpenClawConfig = {
        ...snapshot.config,
        agents: {
          ownership: "explicit",
          ...(explicit ? { defaults: { authInheritance: { agentId: "research" } } } : {}),
          entries: { [targetAgentId]: targetAgentId === "ops" ? { model: "openai/test" } : {} },
        },
      };
      await io.writeConfigFile(nextConfig, {
        baseSnapshot: snapshot,
        ...(targetAgentId === "research" ? { allowedAgentRosterRemovals: ["ops"] } : {}),
        explicitSetPaths: [
          ["agents", "entries"],
          ...(explicit ? [["agents", "defaults", "authInheritance"]] : []),
        ],
        explicitSetValueSource: nextConfig,
      });

      const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
      expect(persisted.agents?.defaults?.authInheritance?.agentId).toBe(expected);
    },
  );

  it("refuses to remove an inherited-auth owner with a custom agentDir", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-custom-auth-owner-"));
    roots.push(root);
    const configPath = path.join(root, "openclaw.json");
    const customAgentDir = path.join(root, "custom-ops-agent");
    await fs.writeFile(
      configPath,
      JSON.stringify({ agents: { entries: { ops: { agentDir: customAgentDir } } } }),
    );
    const io = configIO(root);
    const snapshot = await io.readConfigFileSnapshot();

    await expect(
      io.writeConfigFile(
        {
          ...snapshot.config,
          agents: { ownership: "explicit", entries: { research: {} } },
        },
        { baseSnapshot: snapshot, allowedAgentRosterRemovals: ["ops"] },
      ),
    ).rejects.toMatchObject({
      code: "CONFIG_WRITE_REJECTED",
      message: expect.stringContaining("set agents.defaults.authInheritance explicitly"),
    });
  });

  it("replaces a legacy list when persisting explicit ownership", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-legacy-roster-write-"));
    roots.push(root);
    const configPath = path.join(root, "openclaw.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        agents: {
          list: [
            { id: "ops", default: true, workspace: "/srv/ops" },
            { id: "research", model: "openai/research" },
          ],
        },
      }),
    );
    const io = configIO(root);
    const snapshot = await io.readConfigFileSnapshot();
    const nextConfig = createCanonicalAgentConfigFixture(snapshot.sourceConfig, {
      env: { HOME: root },
      homedir: () => root,
    }).config;

    await io.writeConfigFile(nextConfig, {
      baseSnapshot: snapshot,
      explicitSetPaths: [["agents", "ownership"]],
      explicitSetValueSource: nextConfig,
    });

    const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
    expect(persisted.agents).toEqual({
      ownership: "explicit",
      defaults: {
        systemAgent: { agentId: "ops" },
        authInheritance: { agentId: "ops" },
      },
      entries: {
        ops: { workspace: "/srv/ops" },
        research: { model: "openai/research" },
      },
    });
    expect(persisted.agents).not.toHaveProperty("list");
    const firstPersisted = await fs.readFile(configPath, "utf8");
    const reread = await io.readConfigFileSnapshot();
    await io.writeConfigFile(reread.config, { baseSnapshot: reread });
    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(firstPersisted);
  });

  it("refuses to retire the legacy owner while cron rows still need Doctor", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-legacy-cron-owner-write-"));
    roots.push(root);
    const configPath = path.join(root, "openclaw.json");
    const storePath = path.join(root, "custom-cron", "jobs.json");
    const env = {
      HOME: root,
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_TEST_FAST: "1",
    } as NodeJS.ProcessEnv;
    await fs.writeFile(
      configPath,
      JSON.stringify({
        agents: {
          list: [{ id: "ops", default: true }, { id: "research" }],
        },
      }),
    );
    writeConfigMachineState("cron.store", storePath, { env });
    const storeKey = cronStoreKey(storePath);
    const database = openOpenClawStateDatabase({ env }).db;
    replaceCronRows(database, storeKey, {
      version: 1,
      jobs: [makeCronJob({ id: "ownerless" }), makeCronJob({ id: "owned", agentId: "research" })],
    });
    const otherStoreKey = cronStoreKey(path.join(root, "other-cron", "jobs.json"));
    replaceCronRows(database, otherStoreKey, {
      version: 1,
      jobs: [makeCronJob({ id: "other-ownerless" })],
    });
    const beforeConfig = await fs.readFile(configPath, "utf8");
    const readRows = () =>
      openOpenClawStateDatabase({ env })
        .db.prepare(
          "SELECT * FROM cron_jobs WHERE store_key IN (?, ?) ORDER BY store_key, sort_order, job_id",
        )
        .all(storeKey, otherStoreKey);
    const beforeRows = readRows();
    const io = configIO(root, env);
    const snapshot = await io.readConfigFileSnapshot();
    const nextConfig = createCanonicalAgentConfigFixture(snapshot.sourceConfig, {
      env,
      homedir: () => root,
    }).config;

    const write = io.writeConfigFile(nextConfig, {
      baseSnapshot: snapshot,
      explicitSetPaths: [["agents", "ownership"]],
      explicitSetValueSource: nextConfig,
    });

    await expect(write).rejects.toMatchObject({
      code: "CONFIG_WRITE_REJECTED",
      refusal: "cron-owner-safety",
      message: expect.stringContaining("openclaw doctor --fix"),
    });
    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(beforeConfig);
    expect(readRows()).toEqual(beforeRows);
  });

  it("refuses to rewrite an unmigrated legacy cron file during an ordinary config write", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-legacy-json-cron-owner-"));
    roots.push(root);
    const configPath = path.join(root, "openclaw.json");
    const storePath = path.join(root, "cron", "jobs.json");
    const env = {
      HOME: root,
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_TEST_FAST: "1",
    } as NodeJS.ProcessEnv;
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({ agents: { list: [{ id: "ops", default: true }, { id: "research" }] } }),
    );
    await fs.writeFile(
      storePath,
      JSON.stringify({
        version: 1,
        jobs: [
          makeCronJob({ id: "ownerless" }),
          makeCronJob({ id: "owned", agentId: "research" }),
          { ...makeCronJob({ id: "session-owned" }), sessionKey: "agent:research:main" },
        ],
      }),
    );
    writeConfigMachineState("cron.store", storePath, { env });
    const beforeConfig = await fs.readFile(configPath, "utf8");
    const beforeStore = await fs.readFile(storePath, "utf8");
    const io = configIO(root, env);
    const snapshot = await io.readConfigFileSnapshot();
    const nextConfig = createCanonicalAgentConfigFixture(snapshot.sourceConfig, {
      env,
      homedir: () => root,
    }).config;

    const write = io.writeConfigFile(nextConfig, {
      baseSnapshot: snapshot,
      explicitSetPaths: [["agents", "ownership"]],
      explicitSetValueSource: nextConfig,
    });

    await expect(write).rejects.toMatchObject({
      code: "CONFIG_WRITE_REJECTED",
      refusal: "cron-owner-safety",
      message: expect.stringContaining("openclaw doctor --fix"),
    });
    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(beforeConfig);
    await expect(fs.readFile(storePath, "utf8")).resolves.toBe(beforeStore);
  });

  it("leaves the legacy owner marker intact when a cron row is corrupt", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-corrupt-cron-owner-write-"));
    roots.push(root);
    const configPath = path.join(root, "openclaw.json");
    const env = {
      HOME: root,
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_TEST_FAST: "1",
    } as NodeJS.ProcessEnv;
    const storePath = path.join(root, "cron", "jobs.json");
    const source = JSON.stringify({
      agents: { list: [{ id: "ops", default: true }, { id: "research" }] },
    });
    await fs.writeFile(configPath, source);
    writeConfigMachineState("cron.store", storePath, { env });
    const database = openOpenClawStateDatabase({ env }).db;
    replaceCronRows(database, cronStoreKey(storePath), {
      version: 1,
      jobs: [makeCronJob({ id: "corrupt" })],
    });
    database
      .prepare("UPDATE cron_jobs SET job_json = ? WHERE store_key = ? AND job_id = ?")
      .run("not json", cronStoreKey(storePath), "corrupt");
    const io = configIO(root, env);
    const snapshot = await io.readConfigFileSnapshot();
    const nextConfig = createCanonicalAgentConfigFixture(snapshot.sourceConfig, {
      env,
      homedir: () => root,
    }).config;

    await expect(
      io.writeConfigFile(nextConfig, {
        baseSnapshot: snapshot,
        explicitSetPaths: [["agents", "ownership"]],
        explicitSetValueSource: nextConfig,
      }),
    ).rejects.toThrow("ownership cannot be verified");
    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(source);
  });

  it("requires roster migration before an unrelated write and preserves the canonical owner", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-legacy-owner-roundtrip-"));
    roots.push(root);
    const configPath = path.join(root, "openclaw.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        agents: {
          entries: {
            ops: {},
            research: { default: true },
          },
        },
        gateway: { port: 18789 },
      }),
    );
    const io = configIO(root);
    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.valid).toBe(false);
    const original = await fs.readFile(configPath, "utf8");

    await expect(
      io.writeConfigFile(
        { ...snapshot.config, gateway: { ...snapshot.config.gateway, port: 19001 } },
        { baseSnapshot: snapshot, explicitSetPaths: [["gateway", "port"]] },
      ),
    ).rejects.toMatchObject({
      code: "CONFIG_VALIDATION_FAILED",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "agents.entries",
          message: expect.stringContaining("doctor --fix"),
        }),
      ]),
    });
    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(original);

    const doctorCandidate = createCanonicalAgentConfigFixture(snapshot.sourceConfig, {
      env: { HOME: root },
      homedir: () => root,
    }).config;
    await io.writeConfigFile(doctorCandidate, {
      baseSnapshot: snapshot,
      persistCanonicalAgentRoster: true,
    });
    const canonical = await io.readConfigFileSnapshot();
    expect(canonical.valid).toBe(true);
    expect(tryResolveLegacyCompatibilityAgentId(canonical.config)).toBe("research");

    await io.writeConfigFile(
      { ...canonical.config, gateway: { ...canonical.config.gateway, port: 19001 } },
      { baseSnapshot: canonical, explicitSetPaths: [["gateway", "port"]] },
    );

    const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
    expect(persisted.gateway?.port).toBe(19001);
    expect(persisted.agents?.ownership).toBe("explicit");
    expect(persisted.agents?.entries?.research).not.toHaveProperty("default");
    expect(persisted.agents?.defaults?.systemAgent?.agentId).toBe("research");
    const reread = await io.readConfigFileSnapshot();
    expect(tryResolveLegacyCompatibilityAgentId(reread.config)).toBe("research");
  });
});
