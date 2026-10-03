import { formatCliCommand } from "../../../cli/command-format.js";
import {
  isRecord,
  visitAgentConfigScopes,
  visitChannelEntries,
} from "./legacy-config-record-shared.js";

export function findRetiredConfigUpgradeRequirement(
  config: unknown,
): { message: string; nextAction: string } | undefined {
  if (!isRecord(config)) {
    return undefined;
  }
  const retired: string[] = [];
  const checkKeys = (scope: unknown, configPath: string, keys: string[]) => {
    if (!isRecord(scope)) {
      return;
    }
    for (const key of keys) {
      if (Object.hasOwn(scope, key)) {
        retired.push(configPath ? `${configPath}.${key}` : key);
      }
    }
  };
  checkKeys(config, "", ["heartbeat"]);
  checkKeys(config.routing, "routing", ["allowFrom", "groupChat"]);
  checkKeys(config.plugins, "plugins", ["installs"]);
  checkKeys(config.browser, "browser", ["relayBindHost"]);
  checkKeys(
    isRecord(config.browser) ? config.browser.ssrfPolicy : undefined,
    "browser.ssrfPolicy",
    ["allowPrivateNetwork"],
  );
  const checkMemoryStore = (scope: Record<string, unknown>, configPath: string) => {
    checkKeys(
      isRecord(scope.memorySearch) ? scope.memorySearch.store : undefined,
      `${configPath}memorySearch.store`,
      ["path"],
    );
    const memory = isRecord(scope.memory) ? scope.memory : undefined;
    checkKeys(
      isRecord(memory?.search) ? memory.search.store : undefined,
      `${configPath}memory.search.store`,
      ["path"],
    );
  };
  checkMemoryStore(config, "");
  visitAgentConfigScopes(config, (scope, configPath) => {
    checkKeys(scope, configPath, [
      "systemPromptOverride",
      "silentReplyRewrite",
      "embeddedPi",
      "embeddedHarness",
      "agentRuntime",
    ]);
    checkKeys(scope.sandbox, `${configPath}.sandbox`, ["perSession"]);
    checkKeys(scope.silentReply, `${configPath}.silentReply`, ["direct"]);
    checkKeys(scope.model, `${configPath}.model`, ["timeoutMs"]);
    checkKeys(
      isRecord(scope.subagents) ? scope.subagents.model : undefined,
      `${configPath}.subagents.model`,
      ["timeoutMs"],
    );
    checkMemoryStore(scope, `${configPath}.`);
  });
  if (isRecord(config.surfaces)) {
    for (const [id, surface] of Object.entries(config.surfaces)) {
      checkKeys(surface, `surfaces.${id}`, ["silentReplyRewrite"]);
      checkKeys(isRecord(surface) ? surface.silentReply : undefined, `surfaces.${id}.silentReply`, [
        "direct",
      ]);
    }
  }
  const messages = isRecord(config.messages) ? config.messages : undefined;
  const queue = isRecord(messages?.queue) ? messages.queue : undefined;
  const checkQueueMode = (value: unknown, configPath: string) => {
    if (value === "queue" || value === "steer-backlog" || value === "steer+backlog") {
      retired.push(configPath);
    }
  };
  checkQueueMode(queue?.mode, "messages.queue.mode");
  if (isRecord(queue?.byChannel)) {
    for (const [channel, mode] of Object.entries(queue.byChannel)) {
      checkQueueMode(mode, `messages.queue.byChannel.${channel}`);
    }
  }
  checkKeys(config.talk, "talk", ["mode", "transport", "brain", "model", "voice"]);
  const channels = isRecord(config.channels) ? config.channels : {};
  checkKeys(config.gateway, "gateway", ["webchat"]);
  checkKeys(channels, "channels", ["webchat"]);
  checkKeys(channels.telegram, "channels.telegram", ["requireMention", "groupMentionsOnly"]);
  const beforeDiscord = retired.length;
  visitChannelEntries(config, "discord", (scope, configPath) => {
    const voice = isRecord(scope.voice) ? scope.voice : {};
    checkKeys(voice.tts, `${configPath}.voice.tts`, ["openai", "elevenlabs", "microsoft", "edge"]);
    for (const [guildId, guild] of Object.entries(isRecord(scope.guilds) ? scope.guilds : {})) {
      const guildChannels = isRecord(guild) && isRecord(guild.channels) ? guild.channels : {};
      for (const [channelId, channel] of Object.entries(guildChannels)) {
        checkKeys(channel, `${configPath}.guilds.${guildId}.channels.${channelId}`, [
          "allow",
          "agentId",
        ]);
      }
    }
  });
  const bridgeVersion = retired.length > beforeDiscord ? "2026.9.7" : "2026.9.5";
  visitChannelEntries(config, "telegram", (scope, configPath) => {
    checkKeys(scope, configPath, [
      "streamMode",
      "chunkMode",
      "blockStreaming",
      "blockStreamingCoalesce",
      "draftChunk",
    ]);
    if (isRecord(scope.dm)) {
      retired.push(`${configPath}.dm`);
    }
    if (typeof scope.streaming === "boolean" || typeof scope.streaming === "string") {
      retired.push(`${configPath}.streaming`);
    }
    const streaming = isRecord(scope.streaming) ? scope.streaming : {};
    checkKeys(streaming.preview, `${configPath}.streaming.preview`, [
      "nativeToolProgress",
      "nativeToolProgressAllowFrom",
    ]);
    if (isRecord(scope.direct)) {
      for (const [chatId, direct] of Object.entries(scope.direct)) {
        checkKeys(direct, `${configPath}.direct.${chatId}`, ["threadReplies"]);
      }
    }
  });
  visitChannelEntries(config, "nextcloud-talk", (scope, configPath) => {
    checkKeys(scope, configPath, ["allowPrivateNetwork"]);
  });
  visitChannelEntries(config, "matrix", (scope, configPath) => {
    checkKeys(scope, configPath, ["allowPrivateNetwork"]);
    if (isRecord(scope.dm) && scope.dm.policy === "trusted") {
      retired.push(`${configPath}.dm.policy`);
    }
    for (const section of ["groups", "rooms"]) {
      const rooms = scope[section];
      if (isRecord(rooms)) {
        for (const [roomId, room] of Object.entries(rooms)) {
          checkKeys(room, `${configPath}.${section}.${roomId}`, ["allow"]);
        }
      }
    }
  });
  visitChannelEntries(config, "slack", (scope, configPath) => {
    if (isRecord(scope.channels)) {
      for (const [channelId, channel] of Object.entries(scope.channels)) {
        checkKeys(channel, `${configPath}.channels.${channelId}`, ["allow"]);
      }
    }
  });
  for (const channelId of ["discord", "line", "matrix", "telegram"]) {
    visitChannelEntries(config, channelId, (scope, configPath) => {
      checkKeys(scope.threadBindings, `${configPath}.threadBindings`, ["ttlHours"]);
    });
  }
  visitChannelEntries(config, "feishu", (scope, configPath) => {
    if (configPath !== "channels.feishu") {
      checkKeys(scope, configPath, ["botName"]);
    }
  });
  const session = isRecord(config.session) ? config.session : {};
  checkKeys(session, "session", ["parentForkMaxTokens"]);
  checkKeys(session.threadBindings, "session.threadBindings", ["ttlHours"]);
  checkKeys(isRecord(config.agents) ? config.agents.defaults : undefined, "agents.defaults", [
    "llm",
  ]);
  if (retired.length === 0) {
    return undefined;
  }
  return {
    message: `Config contains retired pre-July-2026 settings: ${retired.join(", ")}. Doctor cannot remove these settings safely.`,
    nextAction:
      `Install OpenClaw ${bridgeVersion}, run "${formatCliCommand("openclaw doctor --fix")}", then upgrade to latest. ` +
      "See https://docs.openclaw.ai/install/updating#upgrading-very-old-versions.",
  };
}
