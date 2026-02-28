import { RequestClient } from "@buape/carbon";
import { Routes } from "discord-api-types/v10";
import type { CliDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import { loadConfig } from "../config/config.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import { resolveDiscordAccount } from "../discord/accounts.js";
import { getChildLogger } from "../logging.js";
import { ProactiveService } from "../proactive/service.js";
import { normalizeAgentId, DEFAULT_AGENT_ID } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";

export type GatewayProactiveState = {
  proactive: ProactiveService;
  proactiveEnabled: boolean;
};

const TYPING_INTERVAL_MS = 6_000;

/**
 * Start a Discord typing indicator loop for a session. Returns a
 * stop function that clears the interval. Resolves the delivery
 * target from the session store so the typing indicator appears
 * in the correct DM or channel.
 */
function startTypingForSession(
  sessionKey: string,
  cfg: ReturnType<typeof loadConfig>,
): (() => void) | undefined {
  const agentId = normalizeAgentId(
    sessionKey.includes(":") ? sessionKey.split(":")[0] : DEFAULT_AGENT_ID,
  );
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  let entry;
  try {
    const store = loadSessionStore(storePath);
    entry = store[sessionKey];
  } catch {
    return undefined;
  }
  if (!entry) {
    return undefined;
  }

  const channel = entry.deliveryContext?.channel ?? entry.lastChannel;
  if (channel !== "discord") {
    return undefined;
  }

  const to = entry.deliveryContext?.to ?? entry.lastTo;
  if (!to) {
    return undefined;
  }

  const accountId = entry.deliveryContext?.accountId ?? entry.lastAccountId;
  let rest: RequestClient;
  try {
    const account = resolveDiscordAccount({ cfg, accountId });
    if (!account.token) {
      return undefined;
    }
    rest = new RequestClient(account.token);
  } catch {
    return undefined;
  }

  // Discord typing targets are channel IDs; DM "to" values are
  // user IDs that need a DM channel opened first. For DMs the
  // session entry stores the channel ID as deliveryContext.to
  // after the first reply, so this should already be a channel ID.
  const channelId = to;

  const fire = () => {
    void rest.post(Routes.channelTyping(channelId)).catch(() => {});
  };
  fire();
  const interval = setInterval(fire, TYPING_INTERVAL_MS);
  return () => clearInterval(interval);
}

export function buildGatewayProactiveService(params: {
  cfg: ReturnType<typeof loadConfig>;
  deps: CliDeps;
}): GatewayProactiveState {
  const proactiveLogger = getChildLogger({ module: "proactive" });
  const proactiveEnabled =
    process.env.OPENCLAW_SKIP_PROACTIVE !== "1" && params.cfg.proactive?.enabled !== false;

  const silentRuntime = {
    log: () => {},
    error: (message: string) => proactiveLogger.error(String(message)),
    exit: defaultRuntime.exit,
  };

  const proactive = new ProactiveService({
    loadConfig,
    runAgentCommand: async (opts) => {
      const cfg = loadConfig();
      const stopTyping = startTypingForSession(opts.sessionKey, cfg);
      try {
        const result = await agentCommand(
          {
            message: opts.message,
            sessionKey: opts.sessionKey,
            deliver: opts.deliver,
            bestEffortDeliver: opts.bestEffortDeliver,
            thinking: opts.thinking,
            lane: opts.lane,
          },
          silentRuntime,
          params.deps,
        );
        return result ?? undefined;
      } finally {
        stopTyping?.();
      }
    },
    log: {
      info: (msg) => proactiveLogger.info(msg),
      warn: (msg) => proactiveLogger.warn(msg),
      error: (msg) => proactiveLogger.error(msg),
    },
  });

  return { proactive, proactiveEnabled };
}
