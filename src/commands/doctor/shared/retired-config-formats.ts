import { formatCliCommand } from "../../../cli/command-format.js";
import { isRecord, visitChannelEntries } from "./legacy-config-record-shared.js";

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
  const channels = isRecord(config.channels) ? config.channels : {};
  checkKeys(channels, "channels", ["webchat"]);
  checkKeys(channels.telegram, "channels.telegram", ["requireMention"]);
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
  checkKeys(session.threadBindings, "session.threadBindings", ["ttlHours"]);
  checkKeys(isRecord(config.agents) ? config.agents.defaults : undefined, "agents.defaults", [
    "llm",
  ]);
  if (retired.length === 0) {
    return undefined;
  }
  return {
    message: `Config contains retired pre-June keys: ${retired.join(", ")}. Doctor cannot remove these settings safely.`,
    nextAction:
      `Install OpenClaw 2026.9.5, run "${formatCliCommand("openclaw doctor --fix")}", then upgrade to latest. ` +
      "See https://docs.openclaw.ai/install/updating#upgrading-very-old-versions.",
  };
}
