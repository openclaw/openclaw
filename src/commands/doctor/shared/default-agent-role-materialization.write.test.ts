import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfigIO, resetConfigRuntimeState } from "../../../config/io.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { readRetainedLegacyDefaultCronOwnerForStore } from "../../../cron/legacy-default-agent-owner-handoff.js";
import { CronService } from "../../../cron/service.js";
import {
  loadCronJobsStoreWithConfigJobsReadOnly,
  resolveCronJobsStorePath,
  saveCronJobsStore,
} from "../../../cron/store.js";
import type { CronJob } from "../../../cron/types.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { loadLegacyCronStoreForMigration } from "../cron/legacy-store-migration.js";
import { hasLegacyCronMigrationReceiptReadOnly } from "../cron/migration-ledger.js";

const roots: string[] = [];

afterEach(async () => {
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
    const workspacePluginPath = path.join(
      root,
      ".openclaw",
      "workspace",
      ".openclaw",
      "extensions",
    );
    await fs.mkdir(workspacePluginPath, { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          agents: {
            defaults: { model: "${DEFAULT_MODEL}" },
            entries: {
              ops: { default: true },
              research: { model: "${RESEARCH_MODEL}" },
            },
          },
          channels: { $include: "./channels.json5" },
          plugins: {
            entries: {
              "voice-call": {
                enabled: true,
                config: { enabled: true, provider: "mock" },
              },
            },
          },
          talk: { provider: "test" },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const io = createConfigIO({
      configPath,
      env: {
        HOME: root,
        OPENCLAW_TEST_FAST: "1",
        DEFAULT_MODEL: "openai/default-model",
        RESEARCH_MODEL: "openai/research-model",
      } as NodeJS.ProcessEnv,
      homedir: () => root,
      observe: false,
      logger: { warn: () => {}, error: () => {} },
    });

    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.config.agents?.entries?.ops).not.toHaveProperty("default");
    expect(snapshot.config.agents?.defaults?.heartbeat?.agentId).toBe("ops");
    const doctorCandidate = {
      ...snapshot.config,
      agents: { ...snapshot.config.agents, ownership: "explicit" as const },
    };
    await io.writeConfigFile(doctorCandidate, {
      baseSnapshot: snapshot,
      explicitSetPaths: [
        ["agents", "entries"],
        ["agents", "ownership"],
      ],
      explicitSetValueSource: doctorCandidate,
    });

    const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
      agents?: {
        ownership?: string;
        defaults?: {
          model?: string;
          heartbeat?: { agentId?: string };
          authInheritance?: { agentId?: string };
        };
        entries?: Record<string, { model?: string; default?: boolean; workspace?: string }>;
      };
      channels?: { $include?: string };
      bindings?: Array<{ agentId?: string; match?: { channel?: string; accountId?: string } }>;
      talk?: { agentId?: string };
      plugins?: {
        load?: { paths?: string[] };
        entries?: Record<string, { config?: Record<string, unknown> }>;
      };
    };
    expect(persisted.agents?.defaults?.model).toBe("${DEFAULT_MODEL}");
    expect(persisted.agents?.ownership).toBe("explicit");
    expect(persisted.agents?.entries?.research?.model).toBe("${RESEARCH_MODEL}");
    expect(persisted.agents?.entries?.ops).not.toHaveProperty("default");
    expect(persisted.agents?.entries?.ops?.workspace).toBe(
      path.join(root, ".openclaw", "workspace"),
    );
    expect(persisted.channels).toEqual({ $include: "./channels.json5" });
    await expect(fs.readFile(channelsPath, "utf-8")).resolves.toBe(includeRaw);
    expect(persisted.bindings).toContainEqual({
      agentId: "ops",
      match: { channel: "telegram", accountId: "*" },
    });
    expect(persisted.agents?.defaults?.heartbeat?.agentId).toBe("ops");
    expect(persisted.agents?.defaults?.authInheritance?.agentId).toBe("ops");
    expect(persisted.talk?.agentId).toBe("ops");
    expect(persisted.plugins?.load?.paths).toContain(workspacePluginPath);
    expect(persisted.plugins?.entries?.["voice-call"]?.config?.agentId).toBe("ops");

    const firstPersisted = await fs.readFile(configPath, "utf-8");
    const reread = await io.readConfigFileSnapshot();
    await io.writeConfigFile(reread.config, { baseSnapshot: reread });
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(firstPersisted);
  });

  it("preserves include-owned bindings byte-for-byte during a sole-to-fleet write", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-binding-include-handoff-"));
    roots.push(root);
    const configPath = path.join(root, "openclaw.json");
    const bindingsPath = path.join(root, "bindings.json5");
    const bindingsRaw = `${JSON.stringify([
      { agentId: "ops", match: { channel: "telegram", accountId: "*" } },
    ])}\n`;
    await fs.writeFile(bindingsPath, bindingsRaw, "utf-8");
    await fs.writeFile(
      configPath,
      `${JSON.stringify({
        agents: { entries: { ops: {} } },
        bindings: { $include: "./bindings.json5" },
      })}\n`,
      "utf-8",
    );
    const io = createConfigIO({
      configPath,
      env: { HOME: root, OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
      homedir: () => root,
      observe: false,
      logger: { warn: () => {}, error: () => {} },
    });
    const snapshot = await io.readConfigFileSnapshot();
    const nextConfig = {
      ...snapshot.config,
      agents: {
        ...snapshot.config.agents,
        entries: { ...snapshot.config.agents?.entries, research: {} },
      },
    };

    await io.writeConfigFile(nextConfig, {
      baseSnapshot: snapshot,
      explicitSetPaths: [["agents", "entries"]],
      explicitSetValueSource: nextConfig,
    });

    expect(await fs.readFile(bindingsPath, "utf-8")).toBe(bindingsRaw);
    const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
      bindings?: { $include?: string };
      agents?: { entries?: Record<string, unknown> };
    };
    expect(persisted.bindings).toEqual({ $include: "./bindings.json5" });
    expect(persisted.agents?.entries).toMatchObject({ ops: {}, research: {} });
  });

  it("refuses fallback materialization into include-owned bindings", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-binding-include-refusal-"));
    roots.push(root);
    const configPath = path.join(root, "openclaw.json");
    const bindingsPath = path.join(root, "bindings.json5");
    const bindingsRaw = `${JSON.stringify([
      { agentId: "ops", match: { channel: "telegram", accountId: "work" } },
    ])}\n`;
    const configRaw = `${JSON.stringify({
      agents: { entries: { ops: {} } },
      bindings: { $include: "./bindings.json5" },
    })}\n`;
    await fs.writeFile(bindingsPath, bindingsRaw, "utf-8");
    await fs.writeFile(configPath, configRaw, "utf-8");
    const env = {
      HOME: root,
      DISCORD_BOT_TOKEN: "env-only-token",
      OPENCLAW_TEST_FAST: "1",
    } as NodeJS.ProcessEnv;
    const io = createConfigIO({
      configPath,
      env,
      homedir: () => root,
      observe: false,
      logger: { warn: () => {}, error: () => {} },
    });
    const snapshot = await io.readConfigFileSnapshot();
    const nextConfig = {
      ...snapshot.config,
      agents: {
        ...snapshot.config.agents,
        entries: { ...snapshot.config.agents?.entries, research: {} },
      },
    };

    await expect(
      io.writeConfigFile(nextConfig, {
        baseSnapshot: snapshot,
        explicitSetPaths: [["agents", "entries"]],
        explicitSetValueSource: nextConfig,
      }),
    ).rejects.toThrow(
      'Add {"agentId":"ops","match":{"channel":"discord","accountId":"*"}} to the bindings include',
    );
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(configRaw);
    await expect(fs.readFile(bindingsPath, "utf-8")).resolves.toBe(bindingsRaw);
  });

  it("persists initially materialized ownership paths when stamping a legacy fleet", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-legacy-stamp-paths-"));
    roots.push(root);
    const configPath = path.join(root, "openclaw.json");
    await fs.writeFile(
      configPath,
      `${JSON.stringify({
        agents: { entries: { ops: { default: true }, research: {} } },
        channels: { telegram: { enabled: true } },
        plugins: {
          entries: {
            "voice-call": {
              enabled: true,
              config: { enabled: true, provider: "mock" },
            },
          },
        },
      })}\n`,
      "utf-8",
    );
    const io = createConfigIO({
      configPath,
      env: { HOME: root, OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
      homedir: () => root,
      observe: false,
      logger: { warn: () => {}, error: () => {} },
    });
    const snapshot = await io.readConfigFileSnapshot();
    const stamped = {
      ...snapshot.config,
      agents: { ...snapshot.config.agents, ownership: "explicit" as const },
    };

    await io.writeConfigFile(stamped, {
      baseSnapshot: snapshot,
      explicitSetPaths: [["agents", "ownership"]],
      explicitSetValueSource: stamped,
    });

    const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
      agents?: {
        ownership?: string;
        defaults?: {
          heartbeat?: { agentId?: string };
          systemAgent?: { agentId?: string };
        };
        entries?: Record<string, { workspace?: string; default?: boolean }>;
      };
      bindings?: Array<{ agentId?: string; match?: { channel?: string; accountId?: string } }>;
      plugins?: { entries?: Record<string, { config?: { agentId?: string } }> };
      talk?: { agentId?: string };
    };
    expect(persisted.agents?.ownership).toBe("explicit");
    expect(persisted.agents?.entries?.ops).not.toHaveProperty("default");
    expect(persisted.agents?.entries?.ops?.workspace).toBe(
      path.join(root, ".openclaw", "workspace"),
    );
    expect(persisted.bindings).toContainEqual({
      agentId: "ops",
      match: { channel: "telegram", accountId: "*" },
    });
    expect(persisted.agents?.defaults?.heartbeat?.agentId).toBe("ops");
    expect(persisted.agents?.defaults?.systemAgent?.agentId).toBe("ops");
    expect(persisted.talk?.agentId).toBe("ops");
    expect(persisted.plugins?.entries?.["voice-call"]?.config?.agentId).toBe("ops");
  });

  it("stamps an existing legacy fleet with its non-first default during agents add", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-existing-legacy-fleet-"));
    roots.push(root);
    const configPath = path.join(root, "openclaw.json");
    await fs.writeFile(
      configPath,
      `${JSON.stringify({
        agents: {
          entries: {
            ops: {},
            research: { default: true },
            support: {},
          },
        },
        channels: { telegram: { enabled: true } },
      })}\n`,
      "utf-8",
    );
    const io = createConfigIO({
      configPath,
      env: { HOME: root, OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
      homedir: () => root,
      observe: false,
      logger: { warn: () => {}, error: () => {} },
    });
    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.config.agents?.defaults?.heartbeat?.agentId).toBe("research");
    const nextConfig = {
      ...snapshot.config,
      agents: {
        ...snapshot.config.agents,
        entries: { ...snapshot.config.agents?.entries, analytics: {} },
      },
    };

    await io.writeConfigFile(nextConfig, {
      baseSnapshot: snapshot,
      explicitSetPaths: [["agents", "entries"]],
      explicitSetValueSource: nextConfig,
    });

    const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
      agents?: {
        ownership?: string;
        defaults?: { heartbeat?: { agentId?: string }; systemAgent?: { agentId?: string } };
        entries?: Record<string, { default?: boolean; workspace?: string }>;
      };
      bindings?: Array<{ agentId?: string; match?: { channel?: string; accountId?: string } }>;
      talk?: { agentId?: string };
    };
    expect(persisted.agents?.ownership).toBe("explicit");
    expect(persisted.agents?.entries).toMatchObject({
      ops: {},
      research: { workspace: path.join(root, ".openclaw", "workspace") },
      support: {},
      analytics: {},
    });
    expect(persisted.agents?.entries?.research).not.toHaveProperty("default");
    expect(persisted.agents?.entries?.ops?.workspace).toBeUndefined();
    expect(persisted.bindings).toContainEqual({
      agentId: "research",
      match: { channel: "telegram", accountId: "*" },
    });
    expect(persisted.bindings).not.toContainEqual({
      agentId: "ops",
      match: { channel: "telegram", accountId: "*" },
    });
    expect(persisted.agents?.defaults?.heartbeat?.agentId).toBe("research");
    expect(persisted.agents?.defaults?.systemAgent?.agentId).toBe("research");
    expect(persisted.talk?.agentId).toBe("research");
  });

  it("persists an env-activated channel binding when Doctor stamps a legacy fleet", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-env-channel-stamp-"));
    roots.push(root);
    const configPath = path.join(root, "openclaw.json");
    await fs.writeFile(
      configPath,
      `${JSON.stringify({
        agents: { entries: { ops: { default: true }, research: {} } },
      })}\n`,
      "utf-8",
    );
    const io = createConfigIO({
      configPath,
      env: {
        HOME: root,
        DISCORD_BOT_TOKEN: "env-only-token",
        OPENCLAW_TEST_FAST: "1",
      } as NodeJS.ProcessEnv,
      homedir: () => root,
      observe: false,
      logger: { warn: () => {}, error: () => {} },
    });
    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.config.bindings).toContainEqual({
      agentId: "ops",
      match: { channel: "discord", accountId: "*" },
    });
    const stamped = {
      ...snapshot.config,
      agents: { ...snapshot.config.agents, ownership: "explicit" as const },
    };

    await io.writeConfigFile(stamped, {
      baseSnapshot: snapshot,
      explicitSetPaths: [["agents", "ownership"]],
      explicitSetValueSource: stamped,
    });

    const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
      agents?: { ownership?: string };
      bindings?: Array<{ agentId?: string; match?: { channel?: string; accountId?: string } }>;
    };
    expect(persisted.agents?.ownership).toBe("explicit");
    expect(persisted.bindings).toContainEqual({
      agentId: "ops",
      match: { channel: "discord", accountId: "*" },
    });
  });

  it.each([
    { label: "marked", entry: { default: true } },
    { label: "markerless", entry: {} },
  ])(
    "persists a $label sole cron owner before a roster write creates a fleet",
    async ({ entry }) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-default-cron-owner-"));
      roots.push(root);
      const configPath = path.join(root, "openclaw.json");
      const stateDir = path.join(root, "state-root");
      const env = {
        HOME: root,
        DISCORD_BOT_TOKEN: "env-only-token",
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_TEST_FAST: "1",
      } as NodeJS.ProcessEnv;
      const storePath = resolveCronJobsStorePath(undefined, env);
      const soleWorkspace = path.join(root, ".openclaw", "workspace");
      const workspacePluginPath = path.join(soleWorkspace, ".openclaw", "extensions");
      await fs.mkdir(workspacePluginPath, { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify({
          agents: { entries: { ops: entry } },
          plugins: {
            entries: {
              "voice-call": {
                enabled: true,
                config: { enabled: true, provider: "mock" },
              },
            },
          },
        })}\n`,
        "utf-8",
      );
      const ownerlessJob: CronJob = {
        id: "ownerless",
        name: "ownerless",
        enabled: true,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "run" },
        state: { nextRunAtMs: Date.now() + 60_000 },
      };

      await withEnvAsync(env, async () => {
        await saveCronJobsStore(storePath, { version: 1, jobs: [ownerlessJob] });
        let currentDefaultAgentId: string | undefined = "ops";
        const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
        const cron = new CronService({
          storePath,
          cronEnabled: true,
          resolveDefaultAgentId: () => currentDefaultAgentId,
          isAgentAvailable: () => true,
          log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          runIsolatedAgentJob,
        });
        const secondCron = new CronService({
          storePath,
          cronEnabled: true,
          resolveDefaultAgentId: () => currentDefaultAgentId,
          isAgentAvailable: () => true,
          log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          runIsolatedAgentJob,
        });
        await Promise.all([cron.start(), secondCron.start()]);
        const io = createConfigIO({
          configPath,
          env,
          homedir: () => root,
          observe: false,
          logger: { warn: () => {}, error: () => {} },
        });
        const snapshot = await io.readConfigFileSnapshot();
        const nextConfig = {
          ...snapshot.config,
          agents: {
            ...snapshot.config.agents,
            entries: { ...snapshot.config.agents?.entries, research: {} },
          },
        };
        const explicitSetValueSource = {
          ...nextConfig,
          agents: {
            ...nextConfig.agents,
            defaults: {
              ...nextConfig.agents.defaults,
              model: { primary: "openai/gpt-5.5" },
            },
          },
        };

        try {
          await io.writeConfigFile(nextConfig, {
            baseSnapshot: snapshot,
            explicitSetPaths: [["agents"]],
            explicitSetValueSource,
          });
          currentDefaultAgentId = undefined;
          expect(cron.getLoadedJobs()?.[0]?.agentId).toBe("ops");
          expect(secondCron.getLoadedJobs()?.[0]?.agentId).toBe("ops");
          await expect(cron.run("ownerless", "force")).resolves.toMatchObject({
            ok: true,
            ran: true,
          });
          expect(runIsolatedAgentJob).toHaveBeenCalledWith(
            expect.objectContaining({ job: expect.objectContaining({ agentId: "ops" }) }),
          );

          const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
            agents?: {
              defaults?: {
                heartbeat?: { agentId?: string };
                model?: { primary?: string };
                systemAgent?: { agentId?: string };
                authInheritance?: { agentId?: string };
              };
              entries?: Record<string, { default?: boolean; workspace?: string }>;
            };
            bindings?: Array<{
              agentId?: string;
              match?: { channel?: string; accountId?: string };
            }>;
            plugins?: {
              load?: { paths?: string[] };
              entries?: Record<string, { config?: Record<string, unknown> }>;
            };
            talk?: { agentId?: string };
          };
          expect(persisted.agents?.entries?.ops).not.toHaveProperty("default");
          expect(persisted.agents?.entries?.ops?.workspace).toBe(soleWorkspace);
          expect(persisted.plugins?.load?.paths).toContain(workspacePluginPath);
          expect(persisted.bindings).toContainEqual({
            agentId: "ops",
            match: { channel: "discord", accountId: "*" },
          });
          expect(persisted.agents?.defaults?.heartbeat?.agentId).toBe("ops");
          expect(persisted.agents?.defaults?.systemAgent?.agentId).toBe("ops");
          expect(persisted.agents?.defaults?.authInheritance?.agentId).toBe("ops");
          expect(persisted.talk?.agentId).toBe("ops");
          expect(persisted.plugins?.entries?.["voice-call"]?.config?.agentId).toBe("ops");
          expect(persisted.agents?.defaults?.model?.primary).toBe("openai/gpt-5.5");
          expect(
            (await loadCronJobsStoreWithConfigJobsReadOnly(storePath, env)).store.jobs[0]?.agentId,
          ).toBe("ops");
        } finally {
          cron.stop();
          secondCron.stop();
        }
      });
    },
  );

  it("persists per-surface first-entry ownership and clears migration warnings", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-marker-free-roles-"));
    roots.push(root);
    const configPath = path.join(root, "openclaw.json");
    const raw = {
      agents: { entries: { ops: {}, research: {} } },
      channels: { telegram: { enabled: true } },
      bindings: [{ agentId: "research", match: { channel: "telegram", accountId: "work" } }],
    };
    await fs.writeFile(configPath, `${JSON.stringify(raw)}\n`, "utf-8");
    const io = createConfigIO({
      configPath,
      env: { HOME: root, OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
      homedir: () => root,
      observe: false,
      logger: { warn: () => {}, error: () => {} },
    });

    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.warnings.map((warning) => warning.path)).toEqual(
      expect.arrayContaining([
        "agents.entries.ops.workspace",
        "channels.telegram",
        "agents.defaults.heartbeat.agentId",
        "agents.defaults.systemAgent.agentId",
        "talk.agentId",
      ]),
    );
    const doctorCandidate = {
      ...snapshot.config,
      agents: { ...snapshot.config.agents, ownership: "explicit" as const },
    };
    await io.writeConfigFile(doctorCandidate, {
      baseSnapshot: snapshot,
      explicitSetPaths: [
        ["agents", "entries"],
        ["agents", "ownership"],
      ],
      explicitSetValueSource: doctorCandidate,
    });

    resetConfigRuntimeState();
    const reread = await io.readConfigFileSnapshot();
    expect(reread.warnings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("marker-free fleet") }),
      ]),
    );
    expect(reread.config.bindings).toContainEqual({
      agentId: "ops",
      match: { channel: "telegram", accountId: "*" },
    });
    expect(reread.config.agents?.entries?.ops?.workspace).toBe(
      path.join(root, ".openclaw", "workspace"),
    );
    expect(reread.config.agents?.ownership).toBe("explicit");
  });

  it("does not hand ownership to a previous sole agent removed by the fleet write", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-replaced-sole-owner-"));
    roots.push(root);
    const configPath = path.join(root, "openclaw.json");
    const env = {
      HOME: root,
      OPENCLAW_STATE_DIR: path.join(root, "state-root"),
      OPENCLAW_TEST_FAST: "1",
    } as NodeJS.ProcessEnv;
    const storePath = resolveCronJobsStorePath(undefined, env);
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ agents: { entries: { ops: {} } } })}\n`,
      "utf-8",
    );
    const ownerlessJob: CronJob = {
      id: "ownerless-replacement",
      name: "ownerless replacement",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run" },
      state: {},
    };

    await withEnvAsync(env, async () => {
      await saveCronJobsStore(storePath, { version: 1, jobs: [ownerlessJob] });
      const io = createConfigIO({
        configPath,
        env,
        homedir: () => root,
        observe: false,
        logger: { warn: () => {}, error: () => {} },
      });
      const snapshot = await io.readConfigFileSnapshot();
      const nextConfig = {
        ...snapshot.config,
        agents: {
          defaults: {
            ...snapshot.config.agents?.defaults,
            heartbeat: { agentId: "research" },
            systemAgent: { agentId: "research" },
          },
          entries: { research: {}, writer: {} },
        },
        bindings: [{ agentId: "research", match: { channel: "discord", accountId: "*" } }],
        talk: { ...snapshot.config.talk, agentId: "research" },
      };

      await expect(
        io.writeConfigFile(nextConfig, {
          baseSnapshot: snapshot,
          explicitSetPaths: [["agents", "entries"]],
          explicitSetValueSource: nextConfig,
          allowedAgentRosterRemovals: ["ops"],
        }),
      ).rejects.toThrow("contains 1 ownerless legacy cron job(s)");

      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        agents?: { entries?: Record<string, unknown> };
      };
      expect(persisted.agents?.entries).toEqual({ ops: {} });
      expect(
        (await loadCronJobsStoreWithConfigJobsReadOnly(storePath, env)).store.jobs[0]?.agentId,
      ).toBeUndefined();
    });
  });

  it("imports an offline legacy JSON cron store before a sole-to-fleet commit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-legacy-json-cron-owner-"));
    roots.push(root);
    const configPath = path.join(root, "openclaw.json");
    const env = {
      HOME: root,
      OPENCLAW_STATE_DIR: path.join(root, "state-root"),
      OPENCLAW_TEST_FAST: "1",
    } as NodeJS.ProcessEnv;
    const storePath = resolveCronJobsStorePath(undefined, env);
    const ownerlessJob: CronJob = {
      id: "legacy-json-ownerless",
      name: "legacy JSON ownerless",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run" },
      state: {},
    };
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ agents: { entries: { ops: {} } } })}\n`,
      "utf-8",
    );
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await saveCronJobsStore(
      storePath,
      {
        version: 1,
        jobs: [{ ...ownerlessJob, id: "canonical-owned", agentId: "research" }],
      },
      { env },
    );
    await fs.writeFile(storePath, JSON.stringify([ownerlessJob]), "utf-8");

    await withEnvAsync(env, async () => {
      const createCron = () =>
        new CronService({
          storePath,
          cronEnabled: true,
          resolveDefaultAgentId: () => "ops",
          isAgentAvailable: () => true,
          log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        });
      const cron = createCron();
      const secondCron = createCron();
      await Promise.all([cron.start(), secondCron.start()]);
      try {
        const io = createConfigIO({
          configPath,
          env,
          homedir: () => root,
          observe: false,
          logger: { warn: () => {}, error: () => {} },
        });
        const snapshot = await io.readConfigFileSnapshot();
        const nextConfig = {
          ...snapshot.config,
          agents: {
            ...snapshot.config.agents,
            entries: { ...snapshot.config.agents?.entries, research: {} },
          },
        };

        await io.writeConfigFile(nextConfig, {
          baseSnapshot: snapshot,
          explicitSetPaths: [["agents", "entries"]],
          explicitSetValueSource: nextConfig,
        });

        const loaded = await loadCronJobsStoreWithConfigJobsReadOnly(storePath, env);
        expect(loaded.store.jobs).toContainEqual(
          expect.objectContaining({ id: "legacy-json-ownerless", agentId: "ops" }),
        );
        expect(loaded.store.jobs).toContainEqual(
          expect.objectContaining({ id: "canonical-owned", agentId: "research" }),
        );
        for (const service of [cron, secondCron]) {
          expect(service.getLoadedJobs()).toContainEqual(
            expect.objectContaining({
              id: "legacy-json-ownerless",
              agentId: "ops",
              state: expect.objectContaining({ nextRunAtMs: expect.any(Number) }),
            }),
          );
        }
        const source = (await loadLegacyCronStoreForMigration(storePath)).migrationSource;
        expect(source).toBeDefined();
        expect(hasLegacyCronMigrationReceiptReadOnly(source!, env)).toBe(true);
      } finally {
        cron.stop();
        secondCron.stop();
      }
    });
  });

  it("refuses a combined fleet and cron.store write without mutating the destination", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dual-cron-store-owner-"));
    roots.push(root);
    const configPath = path.join(root, "openclaw.json");
    const env = {
      HOME: root,
      OPENCLAW_STATE_DIR: path.join(root, "state-root"),
      OPENCLAW_TEST_FAST: "1",
    } as NodeJS.ProcessEnv;
    const sourceStorePath = path.join(root, "cron", "source.json");
    const destinationStorePath = path.join(root, "cron", "destination.json");
    const ownerlessJob = (id: string): CronJob => ({
      id,
      name: id,
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: id },
      state: {},
    });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({
        agents: { entries: { ops: {} } },
        cron: { store: sourceStorePath },
      })}\n`,
      "utf-8",
    );
    await saveCronJobsStore(
      sourceStorePath,
      { version: 1, jobs: [ownerlessJob("source-ownerless")] },
      { env },
    );
    await saveCronJobsStore(
      destinationStorePath,
      { version: 1, jobs: [ownerlessJob("destination-ownerless")] },
      { env },
    );

    const io = createConfigIO({
      configPath,
      env,
      homedir: () => root,
      observe: false,
      preservedLegacyRootKeys: ["cron"],
      logger: { warn: () => {}, error: () => {} },
    });
    const snapshot = await io.readConfigFileSnapshot();
    const nextConfig = {
      ...snapshot.config,
      agents: {
        ...snapshot.config.agents,
        entries: { ...snapshot.config.agents?.entries, research: {} },
      },
      cron: { ...(snapshot.config.cron as object), store: destinationStorePath },
    } as OpenClawConfig;
    const configBefore = await fs.readFile(configPath, "utf-8");
    const destinationBefore = JSON.stringify(
      await loadCronJobsStoreWithConfigJobsReadOnly(destinationStorePath, env),
    );
    const receiptBefore = readRetainedLegacyDefaultCronOwnerForStore(destinationStorePath, env);

    await expect(
      io.writeConfigFile(nextConfig, {
        baseSnapshot: snapshot,
        explicitSetPaths: [["agents", "entries"], ["cron"]],
        explicitSetValueSource: nextConfig,
        preservedLegacyRootKeys: ["cron"],
      }),
    ).rejects.toThrow("cron.store destination");

    expect(await fs.readFile(configPath, "utf-8")).toBe(configBefore);
    expect(
      JSON.stringify(await loadCronJobsStoreWithConfigJobsReadOnly(destinationStorePath, env)),
    ).toBe(destinationBefore);
    expect(readRetainedLegacyDefaultCronOwnerForStore(destinationStorePath, env)).toBe(
      receiptBefore,
    );
  });
});
