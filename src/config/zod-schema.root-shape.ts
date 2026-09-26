import path from "node:path";
import { normalizeStringifiedOptionalString } from "@openclaw/normalization-core/string-coerce";
import { z } from "zod";
import { parseDurationMs } from "../cli/parse-duration.js";
import { SilentReplyPolicyConfigSchema } from "./zod-schema.agent-defaults.js";
import { ToolsSchema } from "./zod-schema.agent-runtime.js";
import { AgentsSchema, BindingsSchema, BroadcastSchema } from "./zod-schema.agents.js";
import { ApprovalsSchema } from "./zod-schema.approvals.js";
import { ChannelsSchema } from "./zod-schema.channels-config.js";
import { CloudWorkersConfigSchema } from "./zod-schema.cloud-workers.js";
import {
  HexColorSchema,
  ModelsConfigSchema,
  SecretInputSchema,
  SecretsConfigSchema,
  SsrFPolicyConfigSchema,
  TtsConfigSchema,
} from "./zod-schema.core.js";
import { DesktopConfigSchema } from "./zod-schema.desktop.js";
import { GatewayConfigSchema } from "./zod-schema.gateway.js";
import { HookMappingSchema, HooksGmailSchema, InternalHooksSchema } from "./zod-schema.hooks.js";
import { DiagnosticsConfigSchema, LoggingConfigSchema } from "./zod-schema.logging.js";
import { BrowserSnapshotDefaultsSchema } from "./zod-schema.node-host.js";
import { ProxyConfigSchema } from "./zod-schema.proxy.js";
import {
  AccessGroupsSchema,
  McpConfigSchema,
  MemorySchema,
  NodeHostSchema,
  PluginEntrySchema,
  SecuritySchema,
  SkillEntrySchema,
  TalkSchema,
} from "./zod-schema.root-support.js";
import { sensitive } from "./zod-schema.sensitive.js";
import { CommandsSchema, MessagesSchema, SessionSchema } from "./zod-schema.session.js";
import { TelemetryConfigSchema } from "./zod-schema.telemetry.js";

export const OpenClawSchemaShape = {
  $schema: z.string().optional(),
  meta: z
    .strictObject({
      lastTouchedVersion: z.string().optional(),
      migrations: z
        .strictObject({
          modelPolicyAllowlist: z.literal(true).optional(),
          utilityModelSeparation: z.literal(true).optional(),
        })
        .optional(),
    })
    .optional(),
  env: z
    .object({
      shellEnv: z
        .strictObject({
          enabled: z.boolean().optional(),
          timeoutMs: z.number().int().nonnegative().optional(),
        })
        .optional(),
      vars: z.record(z.string(), z.string()).optional(),
    })
    .strict()
    .optional(),
  wizard: z
    .strictObject({
      accessMode: z.union([z.literal("full"), z.literal("guarded")]).optional(),
      appRecommendations: z.boolean().optional(),
      lastRunAt: z.string().optional(),
      lastRunVersion: z.string().optional(),
      lastRunCommit: z.string().optional(),
      lastRunCommand: z.string().optional(),
      lastRunMode: z.union([z.literal("local"), z.literal("remote")]).optional(),
      securityAcknowledgedAt: z.string().optional(),
    })
    .optional(),
  diagnostics: DiagnosticsConfigSchema,
  logging: LoggingConfigSchema,
  update: z
    .strictObject({
      channel: z
        .union([
          z.literal("stable"),
          z.literal("extended-stable"),
          z.literal("beta"),
          z.literal("dev"),
        ])
        .optional(),
      checkOnStart: z.boolean().optional(),
      auto: z
        .strictObject({
          enabled: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
  telemetry: TelemetryConfigSchema,
  browser: z
    .strictObject({
      enabled: z.boolean().optional(),
      /** Allow importing cookies from the user's real Chrome-family profile into a managed profile (macOS). Default: true. */
      allowSystemProfileImport: z.boolean().optional(),
      /** If false, disable browser act:evaluate (arbitrary JS). Default: true */
      evaluateEnabled: z.boolean().optional(),
      /** Base URL of the CDP endpoint (for remote browsers). Default: loopback CDP on the derived port. */
      cdpUrl: z.string().optional(),
      /** Override the browser executable path (all platforms). */
      executablePath: z.string().optional(),
      /** Start Chrome headless (best-effort). Default: false */
      headless: z.boolean().optional(),
      /** Pass --no-sandbox to Chrome (Linux containers). Default: false */
      noSandbox: z.boolean().optional(),
      /** If true: never launch; only attach to an existing browser. Default: false */
      attachOnly: z.boolean().optional(),
      /** Default profile to use when profile param is omitted. Default: "openclaw" */
      defaultProfile: z.string().optional(),
      /** Default snapshot options (applied by the browser tool/CLI when unset). */
      snapshotDefaults: BrowserSnapshotDefaultsSchema,
      /** SSRF policy for browser navigation/open-tab operations. */
      ssrfPolicy: SsrFPolicyConfigSchema.optional(),
      profiles: z
        .record(
          z.string().regex(/^[a-z0-9-]+$/, "Profile names must be alphanumeric with hyphens only"),
          z
            .strictObject({
              /** Browser engine capability preset. Lightpanda is an external, semantic-only CDP service. */
              engine: z.enum(["chromium", "lightpanda"]).optional(),
              /** CDP port for this profile. Allocated once at creation, persisted permanently. */
              cdpPort: z.number().int().min(1).max(65535).optional(),
              /** CDP/DevTools endpoint URL for this profile (remote CDP or existing-session endpoint attach). */
              cdpUrl: z.string().optional(),
              /** Explicit user data directory for existing-session Chrome MCP attachment. */
              userDataDir: z.string().optional(),
              /** Override the Chrome MCP command for existing-session profiles. */
              mcpCommand: z.string().optional(),
              /** Extra Chrome MCP arguments for existing-session profiles. */
              mcpArgs: z.array(z.string()).optional(),
              /**
               * Profile driver (default: openclaw). "extension" attaches to the user's
               * signed-in browser through the OpenClaw Chrome extension relay.
               */
              driver: z
                .union([
                  z.literal("openclaw"),
                  z.literal("clawd"),
                  z.literal("existing-session"),
                  z.literal("extension"),
                ])
                .optional(),
              /** If true, launch this profile in headless mode. Falls back to browser.headless. */
              headless: z.boolean().optional(),
              /** Browser executable path for this profile. Falls back to browser.executablePath. */
              executablePath: z.string().optional(),
              /** If true, never launch a browser for this profile; only attach. Falls back to browser.attachOnly. */
              attachOnly: z.boolean().optional(),
            })
            .refine(
              (value) =>
                value.driver === "existing-session" ||
                value.driver === "extension" ||
                value.cdpPort ||
                value.cdpUrl,
              {
                message: "Profile must set cdpPort or cdpUrl",
              },
            )
            .refine((value) => value.driver === "existing-session" || !value.userDataDir, {
              message: 'Profile userDataDir is only supported with driver="existing-session"',
            })
            .refine((value) => value.driver !== "extension" || !value.cdpUrl, {
              message:
                'Profile cdpUrl is not supported with driver="extension" (the relay owns the endpoint)',
            })
            .superRefine((value, ctx) => {
              if (value.engine !== "lightpanda") {
                return;
              }
              const endpoint = value.cdpUrl ? URL.parse(value.cdpUrl) : null;
              if (!endpoint || !["ws:", "wss:"].includes(endpoint.protocol)) {
                ctx.addIssue({
                  code: "custom",
                  path: ["cdpUrl"],
                  message: "Lightpanda requires an explicit ws:// or wss:// CDP endpoint",
                });
              }
              if (value.attachOnly !== true) {
                ctx.addIssue({
                  code: "custom",
                  path: ["attachOnly"],
                  message: "Lightpanda requires attachOnly: true; OpenClaw does not launch it",
                });
              }
              if (value.driver !== undefined && value.driver !== "openclaw") {
                ctx.addIssue({
                  code: "custom",
                  path: ["driver"],
                  message: 'Lightpanda requires the default "openclaw" CDP driver',
                });
              }
              for (const key of [
                "cdpPort",
                "userDataDir",
                "mcpCommand",
                "mcpArgs",
                "headless",
                "executablePath",
              ] as const) {
                if (value[key] !== undefined) {
                  ctx.addIssue({
                    code: "custom",
                    path: [key],
                    message: `Lightpanda does not support the profile ${key} setting`,
                  });
                }
              }
            }),
        )
        .optional(),
      /**
       * Additional Chrome launch arguments.
       * Useful for stealth flags, window size overrides, or custom user-agent strings.
       * Example: ["--window-size=1920,1080", "--disable-infobars"]
       */
      extraArgs: z.array(z.string()).optional(),
      /** Best-effort cleanup policy for tabs opened by primary-agent browser sessions. */
      tabCleanup: z
        .strictObject({
          /** Enable best-effort cleanup for tracked primary-agent browser tabs. Default: true */
          enabled: z.boolean().optional(),
        })
        .optional(),
      /** Chrome extension relay authentication compatibility settings. */
      extensionRelay: z
        .strictObject({
          /** Temporarily accept legacy relay bearer/basic/subprotocol auth. Default: true. */
          allowLegacyAuth: z.boolean().optional(),
        })
        .optional(),
    })
    .superRefine((value, ctx) => {
      const endpoints = new Map<string, { name: string; engine?: string }>();
      for (const [name, profile] of Object.entries(value.profiles ?? {})) {
        const endpoint = profile.cdpUrl ? URL.parse(profile.cdpUrl) : null;
        if (!endpoint) {
          continue;
        }
        const key = endpoint.toString().replace(/\/$/, "");
        const previous = endpoints.get(key);
        if (previous && (previous.engine === "lightpanda" || profile.engine === "lightpanda")) {
          ctx.addIssue({
            code: "custom",
            path: ["profiles", name, "cdpUrl"],
            message: `Lightpanda requires a dedicated CDP endpoint; also used by profile "${previous.name}"`,
          });
        }
        endpoints.set(key, { name, engine: profile.engine });
      }
    })
    .optional(),
  ui: z
    .strictObject({
      seamColor: HexColorSchema.optional(),
      // Operator display prefs. Canonical here (agent-writable via approval,
      // synced across devices); the Control UI mirrors them into local
      // storage for instant boot and offline fallback.
      prefs: z
        .strictObject({
          theme: z
            .union([
              z.literal("claw"),
              z.literal("knot"),
              z.literal("dash"),
              z.literal("absolutely"),
              z.literal("tide"),
              z.literal("beacon"),
              z.literal("phosphor"),
              z.literal("crt"),
              z.literal("manuscript"),
              z.literal("rose"),
              z.literal("miami"),
              z.literal("custom"),
            ])
            .optional(),
          themeMode: z
            .union([z.literal("light"), z.literal("dark"), z.literal("system")])
            .optional(),
          accent: z.union([z.literal("theme"), HexColorSchema.startsWith("#")]).optional(),
          locale: z.string().max(20).optional(),
          chatShowThinking: z.boolean().optional(),
          chatShowToolCalls: z.boolean().optional(),
          chatPersistCommentary: z.boolean().optional(),
          chatSendShortcut: z.union([z.literal("enter"), z.literal("modifier-enter")]).optional(),
          chatFollowUpMode: z.union([z.literal("steer"), z.literal("queue")]).optional(),
          sidebarEntries: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .optional(),
  secrets: SecretsConfigSchema,
  auth: z
    .strictObject({
      profiles: z
        .record(
          z.string(),
          z.strictObject({
            provider: z.string(),
            mode: z.union([
              z.literal("api_key"),
              z.literal("aws-sdk"),
              z.literal("oauth"),
              z.literal("token"),
            ]),
            email: z.string().optional(),
            displayName: z.string().optional(),
          }),
        )
        .optional(),
      order: z.record(z.string(), z.array(z.string())).optional(),
    })
    .optional(),
  accessGroups: AccessGroupsSchema,
  acp: z
    .strictObject({
      enabled: z.boolean().optional(),
      dispatch: z
        .strictObject({
          enabled: z.boolean().optional(),
        })
        .optional(),
      backend: z.string().optional(),
      fallbacks: z.array(z.string()).optional(),
      defaultAgent: z.string().optional(),
      allowedAgents: z.array(z.string()).optional(),
      stream: z
        .strictObject({
          repeatSuppression: z.boolean().optional(),
          deliveryMode: z.union([z.literal("live"), z.literal("final_only")]).optional(),
          tagVisibility: z.record(z.string(), z.boolean()).optional(),
        })
        .optional(),
      runtime: z
        .strictObject({
          installCommand: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  models: ModelsConfigSchema,
  nodeHost: NodeHostSchema,
  agents: AgentsSchema,
  worktreeRoot: z
    .string()
    .trim()
    .min(1)
    .refine(
      (value) =>
        path.isAbsolute(value) ||
        value === "~" ||
        value.startsWith("~/") ||
        value.startsWith(`~${path.sep}`),
      "worktreeRoot must be an absolute path or a path starting with ~",
    )
    .optional(),
  worktreeAcceleration: z.boolean().optional(),
  tools: ToolsSchema,
  security: SecuritySchema,
  bindings: BindingsSchema,
  broadcast: BroadcastSchema,
  attachments: z
    .strictObject({
      ttlHours: z
        .number()
        .int()
        .min(1)
        .max(24 * 7)
        .optional(),
    })
    .optional(),
  messages: MessagesSchema,
  tts: TtsConfigSchema,
  commands: CommandsSchema,
  approvals: ApprovalsSchema,
  session: SessionSchema,
  cron: z
    .strictObject({
      enabled: z.boolean().optional(),
      /** Skip missed recurring slots at startup; one-shot catch-up is unchanged. Default: false. */
      skipMissedJobs: z.boolean().optional(),
      triggers: z
        .strictObject({
          enabled: z.boolean().optional(),
        })
        .optional(),
      /** Bearer token for cron webhook POST delivery. */
      webhookToken: SecretInputSchema.optional().register(sensitive),
      /** SSRF policy for all outbound cron webhook deliveries. */
      webhookSsrfPolicy: SsrFPolicyConfigSchema.optional(),
      /**
       * How long to retain completed cron run sessions before automatic pruning.
       * Accepts a duration string (e.g. "24h", "7d", "1h30m") or `false` to disable pruning.
       * A zero duration (e.g. "0h") also disables pruning; negative durations are invalid.
       * Default: "24h".
       */
      sessionRetention: z.union([z.string(), z.literal(false)]).optional(),
      failureAlert: z
        .strictObject({
          enabled: z.boolean().optional(),
          after: z.number().int().min(1).optional(),
          cooldownMs: z.number().int().min(0).optional(),
          includeSkipped: z.boolean().optional(),
          mode: z.enum(["announce", "webhook"]).optional(),
          accountId: z.string().optional(),
          channel: z.string().optional(),
          to: z.string().optional(),
        })
        .optional(),
    })
    .superRefine((val, ctx) => {
      if (val.sessionRetention !== undefined && val.sessionRetention !== false) {
        try {
          parseDurationMs(normalizeStringifiedOptionalString(val.sessionRetention) ?? "", {
            defaultUnit: "h",
          });
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["sessionRetention"],
            message: "invalid duration (use ms, s, m, h, d)",
          });
        }
      }
    })
    .optional(),
  transcripts: z
    .strictObject({
      enabled: z.boolean().optional(),
      autoStart: z
        .array(
          z.strictObject({
            providerId: z.string().min(1),
            whenOccupied: z.boolean().optional(),
            sessionId: z.string().min(1).optional(),
            title: z.string().min(1).optional(),
            accountId: z.string().min(1).optional(),
            guildId: z.string().min(1).optional(),
            channelId: z.string().min(1).optional(),
            meetingUrl: z.string().min(1).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  hooks: z
    .strictObject({
      enabled: z.boolean().optional(),
      path: z.string().optional(),
      token: z.string().optional().register(sensitive),
      defaultSessionKey: z.string().optional(),
      allowRequestSessionKey: z.boolean().optional(),
      allowedSessionKeyPrefixes: z.array(z.string()).optional(),
      allowedAgentIds: z.array(z.string()).optional(),
      presets: z.array(z.string()).optional(),
      transformsDir: z.string().optional(),
      mappings: z.array(HookMappingSchema).optional(),
      gmail: HooksGmailSchema,
      internal: InternalHooksSchema,
    })
    .superRefine((hooks, ctx) => {
      const hasDefaultSessionKey = hooks.defaultSessionKey?.trim();
      for (const [index, mapping] of (hooks.mappings ?? []).entries()) {
        if (!mapping) {
          continue;
        }
        if (
          (mapping.action ?? "agent") === "agent" &&
          mapping.sessionMode === "persistent" &&
          !mapping.sessionKey?.trim() &&
          !hasDefaultSessionKey &&
          !mapping.transform
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["mappings", index, "sessionKey"],
            message:
              "persistent hook mappings require sessionKey, hooks.defaultSessionKey, or a transform",
          });
        }
      }
    })
    .optional(),
  channels: ChannelsSchema,
  discovery: z
    .strictObject({
      wideArea: z
        .strictObject({
          domain: z.string().optional(),
        })
        .optional(),
      mdns: z
        .strictObject({
          mode: z.enum(["off", "minimal", "full"]).optional(),
        })
        .optional(),
    })
    .optional(),
  talk: TalkSchema.optional(),
  gateway: GatewayConfigSchema,
  cloudWorkers: CloudWorkersConfigSchema,
  desktop: DesktopConfigSchema,
  memory: MemorySchema,
  mcp: McpConfigSchema,
  skills: z
    .strictObject({
      /** Optional bundled-skill allowlist (only affects bundled skills). */
      allowBundled: z.array(z.string()).optional(),
      load: z
        .strictObject({
          /**
           * Additional skill folders to scan (lowest precedence).
           * Each directory should contain skill subfolders with `SKILL.md`.
           */
          extraDirs: z.array(z.string()).optional(),
          /**
           * Real target directories that skill symlinks may resolve into even when they
           * sit outside the configured source root.
           */
          allowSymlinkTargets: z.array(z.string()).optional(),
          /** Watch skill folders for changes and refresh the skills snapshot. */
          watch: z.boolean().optional(),
        })
        .optional(),
      install: z
        .strictObject({
          preferBrew: z.boolean().optional(),
          nodeManager: z
            .union([z.literal("npm"), z.literal("pnpm"), z.literal("yarn"), z.literal("bun")])
            .optional(),
          /** Allow gateway clients to install zip archives staged through skills.upload.*. */
          allowUploadedArchives: z.boolean().optional(),
        })
        .optional(),
      limits: z
        .strictObject({
          /** Max number of immediate child directories to consider under a skills root before treating it as suspicious. */
          maxCandidatesPerRoot: z.number().int().min(1).optional(),
          /** Max number of skills to load per skills source (bundled/managed/workspace/extra). */
          maxSkillsLoadedPerSource: z.number().int().min(1).optional(),
          /** Max number of skills to include in the model-facing skills prompt. */
          maxSkillsInPrompt: z.number().int().min(0).optional(),
          /** Max characters for the model-facing skills prompt block (approx). */
          maxSkillsPromptChars: z.number().int().min(0).optional(),
          /** Max size (bytes) allowed for a SKILL.md file to be considered. */
          maxSkillFileBytes: z.number().int().min(0).optional(),
        })
        .optional(),
      workshop: z
        .strictObject({
          /** Autonomous Skill Workshop behavior controlled separately from user-prompted proposals. */
          autonomous: z
            .strictObject({
              /** Capture policy for durable conversation signals and substantial completed work. */
              mode: z.union([z.literal("off"), z.literal("propose"), z.literal("auto")]).optional(),
            })
            .optional(),
          /** Whether proposal lifecycle actions need explicit approval. */
          approvalPolicy: z.union([z.literal("pending"), z.literal("auto")]).optional(),
          /** Maximum pending/quarantined proposals retained per workspace. */
          maxPending: z.number().int().min(1).optional(),
          /** Maximum generated skill proposal size in bytes. */
          maxSkillBytes: z.number().int().min(1).optional(),
        })
        .optional(),
      entries: z.record(z.string(), SkillEntrySchema).optional(),
    })
    .optional(),
  plugins: z
    .strictObject({
      /** Enable or disable plugin loading. */
      enabled: z.boolean().optional(),
      /** Optional plugin allowlist (plugin ids). */
      allow: z.array(z.string()).optional(),
      /** Optional plugin denylist (plugin ids). */
      deny: z.array(z.string()).optional(),
      load: z
        .strictObject({
          /** Additional plugin/extension paths to load. */
          paths: z.array(z.string()).optional(),
        })
        .optional(),
      slots: z
        .strictObject({
          /** Select which plugin owns the memory slot ("none" disables memory plugins). */
          memory: z.string().optional(),
          /** Select which plugin owns the context-engine slot. */
          contextEngine: z.string().optional(),
        })
        .optional(),
      entries: z.record(z.string(), PluginEntrySchema).optional(),
    })
    .optional(),
  surfaces: z
    .record(
      z.string(),
      z.strictObject({
        silentReply: SilentReplyPolicyConfigSchema.optional(),
      }),
    )
    .optional(),
  proxy: ProxyConfigSchema,
};
