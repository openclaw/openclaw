import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  bootstrapRailwayManagedInstalls,
  buildRailwayBootstrapConfig,
  resolveMainWorkspacePath,
  resolveDiscordWorkspacePath,
  seedRailwayBootstrapFiles,
} from "../../scripts/railway-bootstrap-config.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDirAsync } = createScriptTestHarness();

function createBaseConfig(discordWorkspace = "/data/workspaces/discord-jester") {
  return {
    session: {
      dmScope: "per-channel-peer",
    },
    agents: {
      list: [
        {
          id: "main",
          default: true,
          workspace: "/data/workspace",
        },
        {
          id: "discord-jester",
          name: "Grumbleghast",
          workspace: discordWorkspace,
          skills: [],
          tools: {
            deny: ["group:openclaw"],
          },
        },
      ],
    },
  };
}

function createTemplateConfigWithSecondaryGuild(
  discordWorkspace = "/data/workspaces/discord-jester",
  secondaryGuildId = "764311192122294314",
) {
  return {
    ...createBaseConfig(discordWorkspace),
    bindings: [
      {
        agentId: "discord-jester",
        match: {
          channel: "discord",
          guildId: secondaryGuildId,
        },
      },
    ],
    channels: {
      discord: {
        guilds: {
          [secondaryGuildId]: {
            requireMention: true,
          },
        },
      },
    },
  };
}

describe("railway bootstrap config", () => {
  it("injects a locked-down Discord guild route and automatic group replies", () => {
    const config = buildRailwayBootstrapConfig({
      baseConfig: createBaseConfig(),
      templateConfig: createBaseConfig(),
      env: {
        OPENCLAW_DISCORD_GUILD_ID: "guild-123",
        OPENCLAW_DISCORD_CHANNEL_IDS: "general,memes,general",
        OPENCLAW_DISCORD_ALLOWED_USER_IDS: "user-1,user-2",
        OPENCLAW_DISCORD_AGENT_NAME: "Bog Emperor",
        OPENCLAW_DISCORD_CHECKIN_CHANNEL_ID: "tavern",
      },
    });

    expect(config.messages?.groupChat?.visibleReplies).toBe("automatic");
    expect(config.bindings).toEqual([
      {
        agentId: "discord-jester",
        match: {
          channel: "discord",
          guildId: "guild-123",
        },
      },
    ]);
    expect(config.channels?.discord).toEqual({
      enabled: true,
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
      token: {
        source: "env",
        provider: "default",
        id: "DISCORD_BOT_TOKEN",
      },
      guilds: {
        "guild-123": {
          requireMention: true,
          users: ["user-1", "user-2"],
          channels: {
            general: { allow: true, requireMention: true },
            memes: { allow: true, requireMention: true },
            tavern: { allow: true, requireMention: true },
          },
        },
      },
    });
    expect(config.agents.list[1]?.name).toBe("Bog Emperor");
    expect(config.agents.list[0]?.tools).toEqual({
      alsoAllow: ["lobster"],
    });
  });

  it("enables the Mem0 plugin config when MEM0_API_KEY is present", () => {
    const config = buildRailwayBootstrapConfig({
      baseConfig: createBaseConfig(),
      templateConfig: createBaseConfig(),
      env: {
        MEM0_API_KEY: "m0-test",
      },
    });

    expect(config.plugins?.entries?.["openclaw-mem0"]).toEqual({
      enabled: true,
      config: {
        mode: "platform",
        apiKey: "${MEM0_API_KEY}",
        userId: "default",
        autoCapture: true,
        autoRecall: true,
      },
    });
  });

  it("switches the inherited default model profile without changing fallback shape", () => {
    const config = buildRailwayBootstrapConfig({
      baseConfig: {
        ...createBaseConfig(),
        agents: {
          defaults: {
            model: {
              primary: "openai-codex/gpt-5.4",
              fallbacks: ["openrouter/openai/gpt-4.1", "openrouter/google/gemini-2.5-flash"],
            },
          },
          list: createBaseConfig().agents.list,
        },
      },
      templateConfig: createBaseConfig(),
      env: {
        OPENCLAW_DEFAULT_MODEL_PROFILE: "codex-plan",
      },
    });

    expect(config.agents.defaults.model).toEqual({
      primary: "openai-codex/gpt-5.4",
      fallbacks: ["openrouter/openai/gpt-4.1", "openrouter/google/gemini-2.5-flash"],
    });
  });

  it("preserves an existing default model when no Railway model switch env is set", () => {
    const config = buildRailwayBootstrapConfig({
      baseConfig: {
        ...createBaseConfig(),
        agents: {
          defaults: {
            model: {
              primary: "openai-codex/gpt-5.4",
              fallbacks: ["openrouter/openai/gpt-4.1"],
            },
          },
          list: createBaseConfig().agents.list,
        },
      },
      templateConfig: createBaseConfig(),
      env: {},
    });

    expect(config.agents.defaults.model).toEqual({
      primary: "openai-codex/gpt-5.4",
      fallbacks: ["openrouter/openai/gpt-4.1"],
    });
  });

  it("accepts an explicit default primary override for Railway config switching", () => {
    const config = buildRailwayBootstrapConfig({
      baseConfig: {
        ...createBaseConfig(),
        agents: {
          defaults: {
            model: {
              primary: "openai-codex/gpt-5.4",
              fallbacks: ["openrouter/openai/gpt-4.1"],
            },
          },
          list: createBaseConfig().agents.list,
        },
      },
      templateConfig: createBaseConfig(),
      env: {
        OPENCLAW_DEFAULT_MODEL_PRIMARY:
          "openrouter/cognitivecomputations/dolphin-mistral-24b-venice-edition:free",
      },
    });

    expect(config.agents.defaults.model).toEqual({
      primary: "openrouter/cognitivecomputations/dolphin-mistral-24b-venice-edition:free",
      fallbacks: ["openrouter/openai/gpt-4.1"],
    });
  });

  it("accepts an explicit default backup override for Railway config switching", () => {
    const config = buildRailwayBootstrapConfig({
      baseConfig: {
        ...createBaseConfig(),
        agents: {
          defaults: {
            model: {
              primary: "openai-codex/gpt-5.4",
              fallbacks: ["openrouter/openai/gpt-4.1", "openrouter/google/gemini-2.5-flash"],
            },
          },
          list: createBaseConfig().agents.list,
        },
      },
      templateConfig: createBaseConfig(),
      env: {
        OPENCLAW_DEFAULT_MODEL_BACKUP: "openrouter/meta-llama/llama-3.3-70b-instruct",
      },
    });

    expect(config.agents.defaults.model).toEqual({
      primary: "openai-codex/gpt-5.4",
      fallbacks: ["openrouter/meta-llama/llama-3.3-70b-instruct"],
    });
  });

  it("accepts an explicit fallback list override for Railway config switching", () => {
    const config = buildRailwayBootstrapConfig({
      baseConfig: {
        ...createBaseConfig(),
        agents: {
          defaults: {
            model: {
              primary: "openai-codex/gpt-5.4",
              fallbacks: ["openrouter/openai/gpt-4.1"],
            },
          },
          list: createBaseConfig().agents.list,
        },
      },
      templateConfig: createBaseConfig(),
      env: {
        OPENCLAW_DEFAULT_MODEL_FALLBACKS:
          "openrouter/openai/gpt-4.1,openrouter/google/gemini-2.5-flash",
      },
    });

    expect(config.agents.defaults.model).toEqual({
      primary: "openai-codex/gpt-5.4",
      fallbacks: ["openrouter/openai/gpt-4.1", "openrouter/google/gemini-2.5-flash"],
    });
  });

  it("accepts an explicit default heartbeat model override for Railway config switching", () => {
    const config = buildRailwayBootstrapConfig({
      baseConfig: {
        ...createBaseConfig(),
        agents: {
          defaults: {
            heartbeat: {
              model: "openrouter/google/gemini-2.5-flash",
              lightContext: true,
              isolatedSession: true,
            },
          },
          list: createBaseConfig().agents.list,
        },
      },
      templateConfig: createBaseConfig(),
      env: {
        OPENCLAW_DEFAULT_HEARTBEAT_MODEL: "openrouter/openai/gpt-4.1",
      },
    });

    expect(config.agents.defaults.heartbeat).toEqual({
      model: "openrouter/openai/gpt-4.1",
      lightContext: true,
      isolatedSession: true,
    });
  });

  it("merges template-declared secondary Discord guild routes into the bootstrapped config", () => {
    const config = buildRailwayBootstrapConfig({
      baseConfig: createBaseConfig(),
      templateConfig: createTemplateConfigWithSecondaryGuild(),
      env: {
        OPENCLAW_DISCORD_GUILD_ID: "guild-123",
      },
    });

    expect(config.bindings).toEqual([
      {
        agentId: "discord-jester",
        match: {
          channel: "discord",
          guildId: "764311192122294314",
        },
      },
      {
        agentId: "discord-jester",
        match: {
          channel: "discord",
          guildId: "guild-123",
        },
      },
    ]);
    expect(config.channels?.discord?.guilds).toMatchObject({
      "764311192122294314": { requireMention: true },
      "guild-123": { requireMention: true },
    });
  });

  it("repairs an existing config when Discord env vars are added later", async () => {
    const root = await createTempDirAsync("openclaw-railway-bootstrap-");
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const workspacePath = path.join(root, "workspaces", "discord-jester");

    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({
        agents: {
          list: [{ id: "main", default: true, workspace: "/data/workspace" }],
        },
      })}\n`,
      "utf8",
    );

    const result = seedRailwayBootstrapFiles({
      templateConfig: createTemplateConfigWithSecondaryGuild(workspacePath),
      env: {
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DISCORD_GUILD_ID: "guild-123",
        OPENCLAW_DISCORD_CHANNEL_IDS: "general",
        OPENCLAW_RAILWAY_BOOTSTRAP_INSTALLS: "false",
      },
      personaTemplateText: "# Repaired Persona\n",
    });

    expect(result.wroteConfig).toBe(true);
    expect(result.wrotePersona).toBe(true);

    const writtenConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(writtenConfig.bindings).toEqual([
      {
        agentId: "discord-jester",
        match: {
          channel: "discord",
          guildId: "764311192122294314",
        },
      },
      {
        agentId: "discord-jester",
        match: {
          channel: "discord",
          guildId: "guild-123",
        },
      },
    ]);
    expect(writtenConfig.channels.discord.guilds["764311192122294314"]).toEqual({
      requireMention: true,
    });
    expect(writtenConfig.channels.discord.guilds["guild-123"]).toEqual({
      requireMention: true,
      channels: {
        general: { allow: true, requireMention: true },
      },
    });
    expect(writtenConfig.agents.list.some((agent: { id?: string }) => agent.id === "discord-jester")).toBe(
      true,
    );
  });

  it("recovers template structure when existing config was hollowed out by auth command", async () => {
    const root = await createTempDirAsync("openclaw-railway-bootstrap-");
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");

    // Simulate the minimal config that the auth command writes (no agents.list)
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({
        agents: {
          defaults: {
            models: { "openai-codex/gpt-5.5": {} },
            model: { primary: "openai-codex/gpt-5.5" },
          },
        },
        auth: {
          profiles: {
            "openai-codex:user@example.com": { provider: "openai-codex", mode: "oauth" },
          },
        },
        channels: { discord: { enabled: true } },
      })}\n`,
      "utf8",
    );

    seedRailwayBootstrapFiles({
      templateConfig: createBaseConfig(),
      env: {
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DISCORD_GUILD_ID: "guild-123",
        OPENCLAW_RAILWAY_BOOTSTRAP_INSTALLS: "false",
      },
      personaTemplateText: "# Recovered Persona\n",
    });

    const writtenConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
    // Template structure restored
    expect(writtenConfig.agents.list.some((a: { id?: string }) => a.id === "discord-jester")).toBe(true);
    // Guild config injected
    expect(writtenConfig.channels.discord.guilds?.["guild-123"]?.requireMention).toBe(true);
    // Auth credentials preserved
    expect(writtenConfig.auth?.profiles?.["openai-codex:user@example.com"]?.provider).toBe("openai-codex");
    // Auth model tokens preserved
    expect(writtenConfig.agents.defaults.models?.["openai-codex/gpt-5.5"]).toBeDefined();
  });

  it("seeds managed Discord check-in cron jobs when configured", async () => {
    const root = await createTempDirAsync("openclaw-railway-bootstrap-");
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const cronStorePath = path.join(stateDir, "cron", "jobs.json");

    const result = seedRailwayBootstrapFiles({
      baseConfig: createBaseConfig(),
      env: {
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DISCORD_GUILD_ID: "guild-123",
        OPENCLAW_DISCORD_CHECKIN_CHANNEL_ID: "banter-hall",
        OPENCLAW_DISCORD_CHECKIN_TIMES: "09:30,13:00,18:45",
        OPENCLAW_DISCORD_CHECKIN_TIMEZONE: "America/New_York",
        OPENCLAW_RAILWAY_BOOTSTRAP_INSTALLS: "false",
      },
      personaTemplateText: "# Cron Goblin\n",
    });

    expect(result.wroteCronStore).toBe(true);
    expect(result.cronStorePath).toBe(cronStorePath);

    const cronStore = JSON.parse(await fs.readFile(cronStorePath, "utf8"));
    expect(cronStore.version).toBe(1);
    expect(cronStore.jobs).toHaveLength(3);
    expect(
      cronStore.jobs.map((job: { id: string; schedule: { expr: string; tz: string }; delivery: { to: string } }) => ({
        id: job.id,
        expr: job.schedule.expr,
        tz: job.schedule.tz,
        to: job.delivery.to,
      })),
    ).toEqual([
      {
        id: "railway-discord-checkin-1",
        expr: "30 9 * * *",
        tz: "America/New_York",
        to: "channel:banter-hall",
      },
      {
        id: "railway-discord-checkin-2",
        expr: "0 13 * * *",
        tz: "America/New_York",
        to: "channel:banter-hall",
      },
      {
        id: "railway-discord-checkin-3",
        expr: "45 18 * * *",
        tz: "America/New_York",
        to: "channel:banter-hall",
      },
    ]);
  });

  it("seeds check-in jobs without a pinned channel when CHECKIN_CHANNEL_ID is 'last'", async () => {
    const root = await createTempDirAsync("openclaw-railway-bootstrap-");
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const cronStorePath = path.join(stateDir, "cron", "jobs.json");

    const result = seedRailwayBootstrapFiles({
      baseConfig: createBaseConfig(),
      env: {
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DISCORD_GUILD_ID: "guild-123",
        OPENCLAW_DISCORD_CHECKIN_CHANNEL_ID: "last",
        OPENCLAW_DISCORD_CHECKIN_TIMES: "09:00,21:00",
        OPENCLAW_DISCORD_CHECKIN_TIMEZONE: "UTC",
        OPENCLAW_RAILWAY_BOOTSTRAP_INSTALLS: "false",
      },
      personaTemplateText: "# Last Channel Goblin\n",
    });

    expect(result.wroteCronStore).toBe(true);
    const cronStore = JSON.parse(await fs.readFile(cronStorePath, "utf8"));
    expect(cronStore.jobs).toHaveLength(2);
    for (const job of cronStore.jobs) {
      expect(job.delivery.channel).toBe("discord");
      expect(job.delivery.to).toBeUndefined();
    }
  });

  it("propagates wildcard guild from template into bootstrapped config", () => {
    const baseConfig = {
      ...createBaseConfig(),
      channels: {
        discord: {
          guilds: { "*": { requireMention: false } },
        },
      },
    };
    const config = buildRailwayBootstrapConfig({
      baseConfig,
      env: {
        OPENCLAW_DISCORD_GUILD_ID: "guild-456",
      },
    });
    expect(config.channels?.discord?.guilds).toMatchObject({
      "*": { requireMention: false },
      "guild-456": { requireMention: true },
    });
  });

  it("seeds config and persona files when they are missing", async () => {
    const root = await createTempDirAsync("openclaw-railway-bootstrap-");
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const workspacePath = path.join(root, "workspaces", "discord-jester");
    const agentsPath = path.join(workspacePath, "AGENTS.md");
    const personaText = "# Angry Goblin\n";

    const result = seedRailwayBootstrapFiles({
      baseConfig: createBaseConfig(workspacePath),
      env: {
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DISCORD_GUILD_ID: "guild-123",
        OPENCLAW_RAILWAY_BOOTSTRAP_INSTALLS: "false",
      },
      personaTemplateText: personaText,
    });

    expect(result.wroteConfig).toBe(true);
    expect(result.wrotePersona).toBe(true);
    expect(result.workspacePath).toBe(workspacePath);

    const writtenConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(resolveDiscordWorkspacePath(writtenConfig)).toBe(workspacePath);
    expect(resolveMainWorkspacePath(writtenConfig)).toBe("/data/workspace");
    expect(writtenConfig.channels.discord.guilds["guild-123"].requireMention).toBe(true);
    expect(await fs.readFile(agentsPath, "utf8")).toBe(personaText);
  });

  it("does not overwrite an existing config or persona file", async () => {
    const root = await createTempDirAsync("openclaw-railway-bootstrap-");
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const workspacePath = path.join(root, "workspaces", "discord-jester");
    const agentsPath = path.join(workspacePath, "AGENTS.md");

    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({
        agents: {
          list: [{ id: "discord-jester", workspace: workspacePath }],
        },
      })}\n`,
      "utf8",
    );
    await fs.writeFile(agentsPath, "# Existing Persona\n", "utf8");

    const result = seedRailwayBootstrapFiles({
      templateConfig: createBaseConfig(workspacePath),
      env: {
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_RAILWAY_BOOTSTRAP_INSTALLS: "false",
      },
      personaTemplateText: "# New Persona\n",
    });

    expect(result.wroteConfig).toBe(false);
    expect(result.wrotePersona).toBe(false);
    expect(await fs.readFile(configPath, "utf8")).toContain("discord-jester");
    expect(await fs.readFile(agentsPath, "utf8")).toBe("# Existing Persona\n");
  });

  it("installs missing Railway plugins and workspace skills exactly once", async () => {
    const root = await createTempDirAsync("openclaw-railway-bootstrap-");
    const workspacePath = path.join(root, "workspace");
    const calls: Array<{ args: string[]; cwd: string }> = [];

    const result = bootstrapRailwayManagedInstalls({
      config: {
        agents: {
          list: [{ id: "main", default: true, workspace: workspacePath }],
        },
      },
      mainWorkspacePath: workspacePath,
      runner: ({ args, cwd }: { args: string[]; cwd: string }) => {
        calls.push({ args, cwd });
        if (args.join(" ") === "plugins list --json") {
          return {
            status: 0,
            stdout: JSON.stringify({
              plugins: [{ id: "claw-messenger" }],
            }),
            stderr: "",
          };
        }
        return {
          status: 0,
          stdout: "",
          stderr: "",
        };
      },
    });

    expect(result.installedPlugins).toEqual(["openclaw-mem0", "lobster"]);
    expect(result.installedSkills).toEqual(["gog", "web-search", "github", "weather"]);
    expect(calls.map((call) => call.args)).toEqual([
      ["plugins", "list", "--json"],
      ["plugins", "install", "clawhub:@mem0/openclaw-mem0"],
      ["plugins", "install", "clawhub:@openclaw/lobster"],
      ["skills", "install", "gog"],
      ["skills", "install", "web-search"],
      ["skills", "install", "github"],
      ["skills", "install", "weather"],
    ]);
    expect(calls[0]?.cwd.endsWith("openclaw")).toBe(true);
    expect(calls[1]?.cwd.endsWith("openclaw")).toBe(true);
    expect(calls[2]?.cwd.endsWith("openclaw")).toBe(true);
    expect(calls[3]?.cwd).toBe(workspacePath);
  });

  it("skips plugin and skill installs that already exist", async () => {
    const root = await createTempDirAsync("openclaw-railway-bootstrap-");
    const workspacePath = path.join(root, "workspace");
    await fs.mkdir(path.join(workspacePath, "skills", "gog"), { recursive: true });
    await fs.writeFile(path.join(workspacePath, "skills", "gog", "SKILL.md"), "# gog\n", "utf8");
    const calls: Array<{ args: string[]; cwd: string }> = [];

    const result = bootstrapRailwayManagedInstalls({
      config: {
        agents: {
          list: [{ id: "main", default: true, workspace: workspacePath }],
        },
      },
      mainWorkspacePath: workspacePath,
      runner: ({ args, cwd }: { args: string[]; cwd: string }) => {
        calls.push({ args, cwd });
        return {
          status: 0,
          stdout: JSON.stringify({
            plugins: [
              { id: "claw-messenger" },
              { id: "openclaw-mem0" },
              { id: "lobster" },
            ],
          }),
          stderr: "",
        };
      },
    });

    expect(result.installedPlugins).toEqual([]);
    expect(result.installedSkills).toEqual(["web-search", "github", "weather"]);
    expect(calls.map((call) => call.args)).toEqual([
      ["plugins", "list", "--json"],
      ["skills", "install", "web-search"],
      ["skills", "install", "github"],
      ["skills", "install", "weather"],
    ]);
  });
});
