import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRailwayBootstrapConfig,
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

describe("railway bootstrap config", () => {
  it("injects a locked-down Discord guild route and automatic group replies", () => {
    const config = buildRailwayBootstrapConfig({
      baseConfig: createBaseConfig(),
      env: {
        OPENCLAW_DISCORD_GUILD_ID: "guild-123",
        OPENCLAW_DISCORD_CHANNEL_IDS: "general,memes,general",
        OPENCLAW_DISCORD_ALLOWED_USER_IDS: "user-1,user-2",
        OPENCLAW_DISCORD_REQUIRE_MENTION: "false",
        OPENCLAW_DISCORD_AGENT_NAME: "Bog Emperor",
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
          requireMention: false,
          users: ["user-1", "user-2"],
          channels: {
            general: { allow: true, requireMention: false },
            memes: { allow: true, requireMention: false },
          },
        },
      },
    });
    expect(config.agents.list[1]?.name).toBe("Bog Emperor");
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
      },
      personaTemplateText: personaText,
    });

    expect(result.wroteConfig).toBe(true);
    expect(result.wrotePersona).toBe(true);
    expect(result.workspacePath).toBe(workspacePath);

    const writtenConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(resolveDiscordWorkspacePath(writtenConfig)).toBe(workspacePath);
    expect(writtenConfig.channels.discord.guilds["guild-123"].requireMention).toBe(false);
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
      baseConfig: createBaseConfig(workspacePath),
      env: {
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
      },
      personaTemplateText: "# New Persona\n",
    });

    expect(result.wroteConfig).toBe(false);
    expect(result.wrotePersona).toBe(false);
    expect(await fs.readFile(configPath, "utf8")).toContain(workspacePath);
    expect(await fs.readFile(agentsPath, "utf8")).toBe("# Existing Persona\n");
  });
});
