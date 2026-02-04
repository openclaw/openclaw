import type { OpenClawConfig } from "./types.openclaw.js";

/**
 * Sanitizes a config object by replacing sensitive values with placeholders.
 * Used in secure mode (OPENCLAW_SECURE_MODE=1) to ensure no secrets exist in the container.
 */
export function sanitizeConfigSecrets(cfg: OpenClawConfig): OpenClawConfig {
  // Don't modify if not in secure mode
  if (process.env.OPENCLAW_SECURE_MODE !== "1") {
    return cfg;
  }

  // Deep clone to avoid mutating the original
  const sanitized = JSON.parse(JSON.stringify(cfg)) as OpenClawConfig;

  // Sanitize channel secrets
  if (sanitized.channels) {
    // Discord
    if (sanitized.channels.discord?.token) {
      sanitized.channels.discord.token = "{{CONFIG:channels.discord.token}}";
    }

    // Telegram
    if (sanitized.channels.telegram) {
      if (sanitized.channels.telegram.botToken) {
        sanitized.channels.telegram.botToken = "{{CONFIG:channels.telegram.botToken}}";
      }
      if (sanitized.channels.telegram.webhookSecret) {
        sanitized.channels.telegram.webhookSecret = "{{CONFIG:channels.telegram.webhookSecret}}";
      }
    }

    // Slack
    if (sanitized.channels.slack) {
      if (sanitized.channels.slack.botToken) {
        sanitized.channels.slack.botToken = "{{CONFIG:channels.slack.botToken}}";
      }
      if (sanitized.channels.slack.appToken) {
        sanitized.channels.slack.appToken = "{{CONFIG:channels.slack.appToken}}";
      }
      if (sanitized.channels.slack.userToken) {
        sanitized.channels.slack.userToken = "{{CONFIG:channels.slack.userToken}}";
      }
      if (sanitized.channels.slack.signingSecret) {
        sanitized.channels.slack.signingSecret = "{{CONFIG:channels.slack.signingSecret}}";
      }
    }

    // Feishu
    if (sanitized.channels.feishu) {
      if (sanitized.channels.feishu.appId) {
        sanitized.channels.feishu.appId = "{{CONFIG:channels.feishu.appId}}";
      }
      if (sanitized.channels.feishu.appSecret) {
        sanitized.channels.feishu.appSecret = "{{CONFIG:channels.feishu.appSecret}}";
      }
    }

    // Google Chat
    if (sanitized.channels.googlechat?.serviceAccount) {
      sanitized.channels.googlechat.serviceAccount = "{{CONFIG:channels.googlechat.serviceAccount}}";
    }
  }

  // Sanitize gateway remote credentials (for connecting TO a remote gateway)
  // NOTE: gateway.auth is NOT sanitized because it's for inbound authentication
  // The container needs the real token/password to validate incoming connections
  if (sanitized.gateway?.remote) {
    if (sanitized.gateway.remote.token) {
      sanitized.gateway.remote.token = "{{CONFIG:gateway.remote.token}}";
    }
    if (sanitized.gateway.remote.password) {
      sanitized.gateway.remote.password = "{{CONFIG:gateway.remote.password}}";
    }
  }

  // Sanitize talk API key (ElevenLabs)
  if (sanitized.talk?.apiKey) {
    sanitized.talk.apiKey = "{{CONFIG:talk.apiKey}}";
  }

  // Sanitize inline env vars
  if (sanitized.env?.vars) {
    for (const key of Object.keys(sanitized.env.vars)) {
      // Only sanitize keys that look like secrets
      if (
        key.includes("KEY") ||
        key.includes("SECRET") ||
        key.includes("TOKEN") ||
        key.includes("PASSWORD")
      ) {
        sanitized.env.vars[key] = `{{CONFIG:env.vars.${key}}}`;
      }
    }
  }

  // Sanitize agent workspace paths (rewrite host home dir to container path)
  if (sanitized.agents) {
    // Handle agents.defaults.workspace
    const defaults = (sanitized.agents as any).defaults;
    if (defaults?.workspace && typeof defaults.workspace === "string") {
      defaults.workspace = defaults.workspace.replace(
        /^\/home\/[^/]+\//,
        "/home/node/"
      );
    }
    
    // Handle per-agent workspaces (agents[agentId].workspace)
    const agents = sanitized.agents as Record<string, { workspace?: string } | undefined>;
    for (const agentId of Object.keys(agents)) {
      if (agentId === "defaults") continue; // Already handled above
      const agent = agents[agentId];
      if (agent?.workspace && typeof agent.workspace === "string") {
        // Replace any home directory path with container path
        // This handles paths like /home/username/.openclaw/workspace
        agent.workspace = agent.workspace.replace(
          /^\/home\/[^/]+\//,
          "/home/node/"
        );
      }
    }
  }

  return sanitized;
}
