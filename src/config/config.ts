import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import JSON5 from "json5";
import { z } from "zod";

export type SessionScope = "per-sender" | "global";

export type SessionConfig = {
  scope?: SessionScope;
  resetTriggers?: string[];
  idleMinutes?: number;
  heartbeatIdleMinutes?: number;
  store?: string;
  typingIntervalSeconds?: number;
  mainKey?: string;
};

export type LoggingConfig = {
  level?: "silent" | "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  file?: string;
};

export type WebReconnectConfig = {
  initialMs?: number;
  maxMs?: number;
  factor?: number;
  jitter?: number;
  maxAttempts?: number; // 0 = unlimited
};

export type WebConfig = {
  heartbeatSeconds?: number;
  reconnect?: WebReconnectConfig;
};

export type BrowserConfig = {
  enabled?: boolean;
  /** Base URL of the clawd browser control server. Default: http://127.0.0.1:18791 */
  controlUrl?: string;
  /** Accent color for the clawd browser profile (hex). Default: #FF4500 */
  color?: string;
  /** Start Chrome headless (best-effort). Default: false */
  headless?: boolean;
  /** If true: never launch; only attach to an existing browser. Default: false */
  attachOnly?: boolean;
};

export type CronConfig = {
  enabled?: boolean;
  store?: string;
  maxConcurrentRuns?: number;
};

export type TelegramConfig = {
  botToken?: string;
  requireMention?: boolean;
  allowFrom?: Array<string | number>;
  mediaMaxMb?: number;
  proxy?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  webhookPath?: string;
};

export type GroupChatConfig = {
  requireMention?: boolean;
  mentionPatterns?: string[];
  historyLimit?: number;
};

export type BridgeBindMode = "auto" | "lan" | "tailnet" | "loopback";

export type BridgeConfig = {
  enabled?: boolean;
  port?: number;
  /**
   * Bind address policy for the node bridge server.
   * - auto: prefer tailnet IP when present, else LAN (0.0.0.0)
   * - lan:  0.0.0.0 (reachable on local network + any forwarded interfaces)
   * - tailnet: bind only to the Tailscale interface IP (100.64.0.0/10)
   * - loopback: 127.0.0.1
   */
  bind?: BridgeBindMode;
};

export type WideAreaDiscoveryConfig = {
  enabled?: boolean;
};

export type DiscoveryConfig = {
  wideArea?: WideAreaDiscoveryConfig;
};

export type CanvasHostConfig = {
  enabled?: boolean;
  /** Directory to serve (default: ~/clawd/canvas). */
  root?: string;
  /** HTTP port to listen on (deprecated; Gateway port is used). */
  port?: number;
};

export type GatewayControlUiConfig = {
  /** If false, the Gateway will not serve the Control UI (/). Default: true. */
  enabled?: boolean;
};

export type GatewayConfig = {
  /**
   * Explicit gateway mode. When set to "remote", local gateway start is disabled.
   * When set to "local", the CLI may start the gateway locally.
   */
  mode?: "local" | "remote";
  /**
   * Bind address policy for the Gateway WebSocket + Control UI HTTP server.
   * Default: loopback (127.0.0.1).
   */
  bind?: BridgeBindMode;
  controlUi?: GatewayControlUiConfig;
};

export type SkillConfig = {
  enabled?: boolean;
  apiKey?: string;
  env?: Record<string, string>;
  [key: string]: unknown;
};

export type SkillsLoadConfig = {
  /**
   * Additional skill folders to scan (lowest precedence).
   * Each directory should contain skill subfolders with `SKILL.md`.
   */
  extraDirs?: string[];
};

export type SkillsInstallConfig = {
  preferBrew?: boolean;
  nodeManager?: "npm" | "pnpm" | "bun";
};

export type ClawdisConfig = {
  identity?: {
    name?: string;
    theme?: string;
    emoji?: string;
  };
  logging?: LoggingConfig;
  browser?: BrowserConfig;
  skillsLoad?: SkillsLoadConfig;
  inbound?: {
    allowFrom?: string[]; // E.164 numbers allowed to trigger auto-reply (without whatsapp:)
    /** Agent working directory (preferred). Used as the default cwd for agent runs. */
    workspace?: string;
    messagePrefix?: string; // Prefix added to all inbound messages (default: "[clawdis]" if no allowFrom, else "")
    responsePrefix?: string; // Prefix auto-added to all outbound replies (e.g., "🦞")
    timestampPrefix?: boolean | string; // true/false or IANA timezone string (default: true with UTC)
    transcribeAudio?: {
      // Optional CLI to turn inbound audio into text; templated args, must output transcript to stdout.
      command: string[];
      timeoutSeconds?: number;
    };
    groupChat?: GroupChatConfig;
    agent?: {
      /** Provider id, e.g. "anthropic" or "openai" (pi-ai catalog). */
      provider?: string;
      /** Model id within provider, e.g. "claude-opus-4-5". */
      model?: string;
      /** Optional display-only context window override (used for % in status UIs). */
      contextTokens?: number;
      /** Default thinking level when no /think directive is present. */
      thinkingDefault?: "off" | "minimal" | "low" | "medium" | "high";
      /** Default verbose level when no /verbose directive is present. */
      verboseDefault?: "off" | "on";
      timeoutSeconds?: number;
      /** Max inbound media size in MB for agent-visible attachments (text note or future image attach). */
      mediaMaxMb?: number;
      typingIntervalSeconds?: number;
      /** Periodic background heartbeat runs (minutes). 0 disables. */
      heartbeatMinutes?: number;
    };
    session?: SessionConfig;
  };
  web?: WebConfig;
  telegram?: TelegramConfig;
  cron?: CronConfig;
  bridge?: BridgeConfig;
  discovery?: DiscoveryConfig;
  canvasHost?: CanvasHostConfig;
  gateway?: GatewayConfig;
  skills?: Record<string, SkillConfig>;
  skillsInstall?: SkillsInstallConfig;
};

// New branding path (preferred)
export const CONFIG_PATH_CLAWDIS = path.join(
  os.homedir(),
  ".clawdis",
  "clawdis.json",
);

const ClawdisSchema = z.object({
  identity: z
    .object({
      name: z.string().optional(),
      theme: z.string().optional(),
      emoji: z.string().optional(),
    })
    .optional(),
  logging: z
    .object({
      level: z
        .union([
          z.literal("silent"),
          z.literal("fatal"),
          z.literal("error"),
          z.literal("warn"),
          z.literal("info"),
          z.literal("debug"),
          z.literal("trace"),
        ])
        .optional(),
      file: z.string().optional(),
    })
    .optional(),
  browser: z
    .object({
      enabled: z.boolean().optional(),
      controlUrl: z.string().optional(),
      color: z.string().optional(),
      headless: z.boolean().optional(),
      attachOnly: z.boolean().optional(),
    })
    .optional(),
  inbound: z
    .object({
      allowFrom: z.array(z.string()).optional(),
      workspace: z.string().optional(),
      messagePrefix: z.string().optional(),
      responsePrefix: z.string().optional(),
      timestampPrefix: z.union([z.boolean(), z.string()]).optional(),
      groupChat: z
        .object({
          requireMention: z.boolean().optional(),
          mentionPatterns: z.array(z.string()).optional(),
          historyLimit: z.number().int().positive().optional(),
        })
        .optional(),
      transcribeAudio: z
        .object({
          command: z.array(z.string()),
          timeoutSeconds: z.number().int().positive().optional(),
        })
        .optional(),
      agent: z
        .object({
          provider: z.string().optional(),
          model: z.string().optional(),
          contextTokens: z.number().int().positive().optional(),
          thinkingDefault: z
            .union([
              z.literal("off"),
              z.literal("minimal"),
              z.literal("low"),
              z.literal("medium"),
              z.literal("high"),
            ])
            .optional(),
          verboseDefault: z
            .union([z.literal("off"), z.literal("on")])
            .optional(),
          timeoutSeconds: z.number().int().positive().optional(),
          mediaMaxMb: z.number().positive().optional(),
          typingIntervalSeconds: z.number().int().positive().optional(),
          heartbeatMinutes: z.number().nonnegative().optional(),
        })
        .optional(),
      session: z
        .object({
          scope: z
            .union([z.literal("per-sender"), z.literal("global")])
            .optional(),
          resetTriggers: z.array(z.string()).optional(),
          idleMinutes: z.number().int().positive().optional(),
          heartbeatIdleMinutes: z.number().int().positive().optional(),
          store: z.string().optional(),
          typingIntervalSeconds: z.number().int().positive().optional(),
          mainKey: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  cron: z
    .object({
      enabled: z.boolean().optional(),
      store: z.string().optional(),
      maxConcurrentRuns: z.number().int().positive().optional(),
    })
    .optional(),
  web: z
    .object({
      heartbeatSeconds: z.number().int().positive().optional(),
      reconnect: z
        .object({
          initialMs: z.number().positive().optional(),
          maxMs: z.number().positive().optional(),
          factor: z.number().positive().optional(),
          jitter: z.number().min(0).max(1).optional(),
          maxAttempts: z.number().int().min(0).optional(),
        })
        .optional(),
    })
    .optional(),
  telegram: z
    .object({
      botToken: z.string().optional(),
      requireMention: z.boolean().optional(),
      allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
      mediaMaxMb: z.number().positive().optional(),
      proxy: z.string().optional(),
      webhookUrl: z.string().optional(),
      webhookSecret: z.string().optional(),
      webhookPath: z.string().optional(),
    })
    .optional(),
  bridge: z
    .object({
      enabled: z.boolean().optional(),
      port: z.number().int().positive().optional(),
      bind: z
        .union([
          z.literal("auto"),
          z.literal("lan"),
          z.literal("tailnet"),
          z.literal("loopback"),
        ])
        .optional(),
    })
    .optional(),
  discovery: z
    .object({
      wideArea: z
        .object({
          enabled: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
  canvasHost: z
    .object({
      enabled: z.boolean().optional(),
      root: z.string().optional(),
      port: z.number().int().positive().optional(),
    })
    .optional(),
  gateway: z
    .object({
      mode: z.union([z.literal("local"), z.literal("remote")]).optional(),
      bind: z
        .union([
          z.literal("auto"),
          z.literal("lan"),
          z.literal("tailnet"),
          z.literal("loopback"),
        ])
        .optional(),
      controlUi: z
        .object({
          enabled: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
  skillsLoad: z
    .object({
      extraDirs: z.array(z.string()).optional(),
    })
    .optional(),
  skillsInstall: z
    .object({
      preferBrew: z.boolean().optional(),
      nodeManager: z
        .union([z.literal("npm"), z.literal("pnpm"), z.literal("bun")])
        .optional(),
    })
    .optional(),
  skills: z
    .record(
      z.string(),
      z
        .object({
          enabled: z.boolean().optional(),
          apiKey: z.string().optional(),
          env: z.record(z.string(), z.string()).optional(),
        })
        .passthrough(),
    )
    .optional(),
});

export type ConfigValidationIssue = {
  path: string;
  message: string;
};

export type ConfigFileSnapshot = {
  path: string;
  exists: boolean;
  raw: string | null;
  parsed: unknown;
  valid: boolean;
  config: ClawdisConfig;
  issues: ConfigValidationIssue[];
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyIdentityDefaults(cfg: ClawdisConfig): ClawdisConfig {
  const identity = cfg.identity;
  if (!identity) return cfg;

  const emoji = identity.emoji?.trim();
  const name = identity.name?.trim();

  const inbound = cfg.inbound ?? {};
  const groupChat = inbound.groupChat ?? {};

  let mutated = false;
  const next: ClawdisConfig = { ...cfg };

  if (emoji && !inbound.responsePrefix) {
    next.inbound = { ...inbound, responsePrefix: emoji };
    mutated = true;
  }

  if (name && !groupChat.mentionPatterns) {
    const parts = name.split(/\s+/).filter(Boolean).map(escapeRegExp);
    const re = parts.length ? parts.join("\\s+") : escapeRegExp(name);
    const pattern = `\\b@?${re}\\b`;
    next.inbound = {
      ...(next.inbound ?? inbound),
      groupChat: { ...groupChat, mentionPatterns: [pattern] },
    };
    mutated = true;
  }

  return mutated ? next : cfg;
}

export function loadConfig(): ClawdisConfig {
  // Read config file (JSON5) if present.
  const configPath = CONFIG_PATH_CLAWDIS;
  try {
    if (!fs.existsSync(configPath)) return {};
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON5.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const validated = ClawdisSchema.safeParse(parsed);
    if (!validated.success) {
      console.error("Invalid config:");
      for (const iss of validated.error.issues) {
        console.error(`- ${iss.path.join(".")}: ${iss.message}`);
      }
      return {};
    }
    return applyIdentityDefaults(validated.data as ClawdisConfig);
  } catch (err) {
    console.error(`Failed to read config at ${configPath}`, err);
    return {};
  }
}

export function validateConfigObject(
  raw: unknown,
):
  | { ok: true; config: ClawdisConfig }
  | { ok: false; issues: ConfigValidationIssue[] } {
  const validated = ClawdisSchema.safeParse(raw);
  if (!validated.success) {
    return {
      ok: false,
      issues: validated.error.issues.map((iss) => ({
        path: iss.path.join("."),
        message: iss.message,
      })),
    };
  }
  return {
    ok: true,
    config: applyIdentityDefaults(validated.data as ClawdisConfig),
  };
}

export function parseConfigJson5(
  raw: string,
): { ok: true; parsed: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, parsed: JSON5.parse(raw) as unknown };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function readConfigFileSnapshot(): Promise<ConfigFileSnapshot> {
  const configPath = CONFIG_PATH_CLAWDIS;
  const exists = fs.existsSync(configPath);
  if (!exists) {
    return {
      path: configPath,
      exists: false,
      raw: null,
      parsed: {},
      valid: true,
      config: {},
      issues: [],
    };
  }

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsedRes = parseConfigJson5(raw);
    if (!parsedRes.ok) {
      return {
        path: configPath,
        exists: true,
        raw,
        parsed: {},
        valid: false,
        config: {},
        issues: [
          { path: "", message: `JSON5 parse failed: ${parsedRes.error}` },
        ],
      };
    }

    const validated = validateConfigObject(parsedRes.parsed);
    if (!validated.ok) {
      return {
        path: configPath,
        exists: true,
        raw,
        parsed: parsedRes.parsed,
        valid: false,
        config: {},
        issues: validated.issues,
      };
    }

    return {
      path: configPath,
      exists: true,
      raw,
      parsed: parsedRes.parsed,
      valid: true,
      config: validated.config,
      issues: [],
    };
  } catch (err) {
    return {
      path: configPath,
      exists: true,
      raw: null,
      parsed: {},
      valid: false,
      config: {},
      issues: [{ path: "", message: `read failed: ${String(err)}` }],
    };
  }
}

export async function writeConfigFile(cfg: ClawdisConfig) {
  await fs.promises.mkdir(path.dirname(CONFIG_PATH_CLAWDIS), {
    recursive: true,
  });
  const json = JSON.stringify(cfg, null, 2).trimEnd().concat("\n");
  await fs.promises.writeFile(CONFIG_PATH_CLAWDIS, json, "utf-8");
}
