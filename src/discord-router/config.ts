import fs from "node:fs";
import path from "node:path";

export type InstanceConfig = {
  port: number;
  token: string;
  onboarded: boolean;
  configPath: string;
};

export type RouterConfig = {
  discordToken: string;
  instances: Map<string, InstanceConfig>;
  instancesDir: string;
  agentTimeoutMs: number;
};

/**
 * Load router configuration by scanning the instances directory.
 * Each instance directory is named by Discord user ID and contains
 * an openclaw.json with gateway config.
 */
export function loadRouterConfig(opts: {
  instancesDir?: string;
  discordToken?: string;
  basePort?: number;
}): RouterConfig {
  const instancesDir =
    opts.instancesDir ??
    process.env.OPENCLAW_INSTANCES_DIR ??
    path.join(process.env.HOME ?? "/root", ".openclaw-instances");

  const discordToken =
    opts.discordToken ?? process.env.DISCORD_BOT_TOKEN ?? process.env.OPENCLAW_DISCORD_TOKEN;
  if (!discordToken) {
    throw new Error("Discord bot token required. Set DISCORD_BOT_TOKEN or pass --discord-token.");
  }

  const instances = new Map<string, InstanceConfig>();
  const basePort = opts.basePort ?? 18789;
  const DISCORD_ID_RE = /^\d{17,20}$/;

  if (!fs.existsSync(instancesDir)) {
    throw new Error(`Instances directory not found: ${instancesDir}`);
  }

  const entries = fs.readdirSync(instancesDir, { withFileTypes: true });
  let portOffset = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !DISCORD_ID_RE.test(entry.name)) {
      continue;
    }
    const discordUserId = entry.name;
    const configPath = path.join(instancesDir, discordUserId, "openclaw.json");

    let gatewayToken = "";
    let onboarded = false;
    // Each instance gets a unique host port: base, base+2, base+4, ...
    // This matches the Docker Compose port mapping pattern.
    let port = basePort + portOffset * 2;

    if (fs.existsSync(configPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        gatewayToken = raw?.gateway?.auth?.token ?? "";
        onboarded = raw?.onboarded === true;
        // Don't read port from instance config — that's the container-internal
        // port (always 18789). The host-mapped port is computed from the offset.
      } catch {
        // Fall through with defaults
      }
    }

    // Env vars override computed values
    const envToken = process.env[`OPENCLAW_${discordUserId}_TOKEN`];
    const envPort = process.env[`OPENCLAW_${discordUserId}_PORT`];
    if (envToken) {
      gatewayToken = envToken;
    }
    if (envPort) {
      port = Number(envPort);
    }

    instances.set(discordUserId, { port, token: gatewayToken, onboarded, configPath });
    portOffset++;
  }

  return {
    discordToken,
    instances,
    instancesDir,
    agentTimeoutMs: 600_000,
  };
}

/** Mark an instance as onboarded in its config file. */
export function markOnboarded(instance: InstanceConfig): void {
  try {
    const raw = JSON.parse(fs.readFileSync(instance.configPath, "utf-8"));
    raw.onboarded = true;
    fs.writeFileSync(instance.configPath, JSON.stringify(raw, null, 2));
    instance.onboarded = true;
  } catch {
    // Best effort
  }
}
