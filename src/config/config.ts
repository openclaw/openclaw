import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import JSON5 from "json5";
import { z } from "zod";

import type { AgentKind } from "../agents/index.js";

export type ReplyMode = "text" | "command";
export type SessionScope = "per-sender" | "global";

export type SessionConfig = {
  scope?: SessionScope;
  resetTriggers?: string[];
  idleMinutes?: number;
  heartbeatIdleMinutes?: number;
  store?: string;
  sessionArgNew?: string[];
  sessionArgResume?: string[];
  sessionArgBeforeBody?: boolean;
  sendSystemOnce?: boolean;
  sessionIntro?: string;
  typingIntervalSeconds?: number;
  heartbeatMinutes?: number;
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

export type WebChatConfig = {
  enabled?: boolean;
  port?: number;
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

export type ClawdisConfig = {
  identity?: {
    name?: string;
    theme?: string;
    emoji?: string;
  };
  logging?: LoggingConfig;
  browser?: BrowserConfig;
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
    reply?: {
      mode: ReplyMode;
      text?: string;
      command?: string[];
      heartbeatCommand?: string[];
      thinkingDefault?: "off" | "minimal" | "low" | "medium" | "high";
      verboseDefault?: "off" | "on";
      cwd?: string;
      template?: string;
      timeoutSeconds?: number;
      bodyPrefix?: string;
      mediaUrl?: string;
      session?: SessionConfig;
      mediaMaxMb?: number;
      typingIntervalSeconds?: number;
      heartbeatMinutes?: number;
      agent?: {
        kind: AgentKind;
        format?: "text" | "json";
        identityPrefix?: string;
        provider?: string;
        model?: string;
        contextTokens?: number;
      };
    };
  };
  web?: WebConfig;
  telegram?: TelegramConfig;
  webchat?: WebChatConfig;
  cron?: CronConfig;
};

// New branding path (preferred)
export const CONFIG_PATH_CLAWDIS = path.join(
  os.homedir(),
  ".clawdis",
  "clawdis.json",
);

const ReplySchema = z
  .object({
    mode: z.union([z.literal("text"), z.literal("command")]),
    text: z.string().optional(),
    command: z.array(z.string()).optional(),
    heartbeatCommand: z.array(z.string()).optional(),
    thinkingDefault: z
      .union([
        z.literal("off"),
        z.literal("minimal"),
        z.literal("low"),
        z.literal("medium"),
        z.literal("high"),
      ])
      .optional(),
    verboseDefault: z.union([z.literal("off"), z.literal("on")]).optional(),
    cwd: z.string().optional(),
    template: z.string().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    bodyPrefix: z.string().optional(),
    mediaUrl: z.string().optional(),
    mediaMaxMb: z.number().positive().optional(),
    typingIntervalSeconds: z.number().int().positive().optional(),
    session: z
      .object({
        scope: z
          .union([z.literal("per-sender"), z.literal("global")])
          .optional(),
        resetTriggers: z.array(z.string()).optional(),
        idleMinutes: z.number().int().positive().optional(),
        heartbeatIdleMinutes: z.number().int().positive().optional(),
        store: z.string().optional(),
        sessionArgNew: z.array(z.string()).optional(),
        sessionArgResume: z.array(z.string()).optional(),
        sessionArgBeforeBody: z.boolean().optional(),
        sendSystemOnce: z.boolean().optional(),
        sessionIntro: z.string().optional(),
        typingIntervalSeconds: z.number().int().positive().optional(),
        mainKey: z.string().optional(),
      })
      .optional(),
    heartbeatMinutes: z.number().int().nonnegative().optional(),
    agent: z
      .object({
        kind: z.literal("pi"),
        format: z.union([z.literal("text"), z.literal("json")]).optional(),
        identityPrefix: z.string().optional(),
        provider: z.string().optional(),
        model: z.string().optional(),
        contextTokens: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .refine(
    (val) =>
      val.mode === "text"
        ? Boolean(val.text)
        : Boolean(val.command || val.heartbeatCommand),
    {
      message:
        "reply.text is required for mode=text; reply.command or reply.heartbeatCommand is required for mode=command",
    },
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
      reply: ReplySchema.optional(),
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
  webchat: z
    .object({
      enabled: z.boolean().optional(),
      port: z.number().int().positive().optional(),
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
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyIdentityDefaults(cfg: ClawdisConfig): ClawdisConfig {
  const identity = cfg.identity;
  if (!identity) return cfg;

  const emoji = identity.emoji?.trim();
  const name = identity.name?.trim();
  const theme = identity.theme?.trim();

  const inbound = cfg.inbound ?? {};
  const groupChat = inbound.groupChat ?? {};
  const reply = inbound.reply ?? undefined;
  const session = reply?.session ?? undefined;

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

  if (name && reply && !session?.sessionIntro) {
    const introParts = [
      `You are ${name}.`,
      theme ? `Theme: ${theme}.` : undefined,
      emoji ? `Your emoji is ${emoji}.` : undefined,
    ].filter(Boolean);
    next.inbound = {
      ...(next.inbound ?? inbound),
      reply: {
        ...reply,
        session: { ...(session ?? {}), sessionIntro: introParts.join(" ") },
      },
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
