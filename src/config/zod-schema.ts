import { z } from "zod";
import { parseByteSize } from "../cli/parse-bytes.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { ToolsSchema } from "./zod-schema.agent-runtime.js";
import { AgentsSchema, AudioSchema, BindingsSchema, BroadcastSchema } from "./zod-schema.agents.js";
import { ApprovalsSchema } from "./zod-schema.approvals.js";
import { HexColorSchema, ModelsConfigSchema } from "./zod-schema.core.js";
import { HookMappingSchema, HooksGmailSchema, InternalHooksSchema } from "./zod-schema.hooks.js";
import { InstallRecordShape } from "./zod-schema.installs.js";
import { ChannelsSchema } from "./zod-schema.providers.js";
import { sensitive } from "./zod-schema.sensitive.js";
import {
  CommandsSchema,
  MessagesSchema,
  SessionSchema,
  SessionSendPolicySchema,
} from "./zod-schema.session.js";

const BrowserSnapshotDefaultsSchema = z
  .object({
    mode: z.literal("efficient").optional(),
  })
  .strict()
  .optional();

const NodeHostSchema = z
  .object({
    browserProxy: z
      .object({
        enabled: z.boolean().optional(),
        allowProfiles: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

const MemoryQmdPathSchema = z
  .object({
    path: z.string(),
    name: z.string().optional(),
    pattern: z.string().optional(),
  })
  .strict();

const MemoryQmdSessionSchema = z
  .object({
    enabled: z.boolean().optional(),
    exportDir: z.string().optional(),
    retentionDays: z.number().int().nonnegative().optional(),
  })
  .strict();

const MemoryQmdUpdateSchema = z
  .object({
    interval: z.string().optional(),
    debounceMs: z.number().int().nonnegative().optional(),
    onBoot: z.boolean().optional(),
    waitForBootSync: z.boolean().optional(),
    embedInterval: z.string().optional(),
    commandTimeoutMs: z.number().int().nonnegative().optional(),
    updateTimeoutMs: z.number().int().nonnegative().optional(),
    embedTimeoutMs: z.number().int().nonnegative().optional(),
  })
  .strict();

const MemoryQmdLimitsSchema = z
  .object({
    maxResults: z.number().int().positive().optional(),
    maxSnippetChars: z.number().int().positive().optional(),
    maxInjectedChars: z.number().int().positive().optional(),
    timeoutMs: z.number().int().nonnegative().optional(),
  })
  .strict();

const MemoryQmdMcporterSchema = z
  .object({
    enabled: z.boolean().optional(),
    serverName: z.string().optional(),
    startDaemon: z.boolean().optional(),
  })
  .strict();

const LoggingLevelSchema = z.union([
  z.literal("silent"),
  z.literal("fatal"),
  z.literal("error"),
  z.literal("warn"),
  z.literal("info"),
  z.literal("debug"),
  z.literal("trace"),
]);

const MemoryQmdSchema = z
  .object({
    command: z.string().optional(),
    mcporter: MemoryQmdMcporterSchema.optional(),
    searchMode: z.union([z.literal("query"), z.literal("search"), z.literal("vsearch")]).optional(),
    includeDefaultMemory: z.boolean().optional(),
    paths: z.array(MemoryQmdPathSchema).optional(),
    sessions: MemoryQmdSessionSchema.optional(),
    update: MemoryQmdUpdateSchema.optional(),
    limits: MemoryQmdLimitsSchema.optional(),
    scope: SessionSendPolicySchema.optional(),
  })
  .strict();

const MemorySchema = z
  .object({
    backend: z.union([z.literal("builtin"), z.literal("qmd")]).optional(),
    citations: z.union([z.literal("auto"), z.literal("on"), z.literal("off")]).optional(),
    qmd: MemoryQmdSchema.optional(),
  })
  .strict()
  .optional();

const HttpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "Expected http:// or https:// URL");

export const OpenClawSchema = z
  .object({
    $schema: z.string().optional(),
    meta: z
      .object({
        lastTouchedVersion: z.string().optional(),
        // Accept any string unchanged (backwards-compatible) and coerce numeric Unix
        // timestamps to ISO strings (agent file edits may write Date.now()).
        lastTouchedAt: z
          .union([
            z.string(),
            z.number().transform((n, ctx) => {
              const d = new Date(n);
              if (Number.isNaN(d.getTime())) {
                ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid timestamp" });
                return z.NEVER;
              }
              return d.toISOString();
            }),
          ])
          .optional(),
      })
      .strict()
      .optional(),
    env: z
      .object({
        shellEnv: z
          .object({
            enabled: z.boolean().optional(),
            timeoutMs: z.number().int().nonnegative().optional(),
          })
          .strict()
          .optional(),
        vars: z.record(z.string(), z.string()).optional(),
      })
      .catchall(z.string())
      .optional(),
    wizard: z
      .object({
        lastRunAt: z.string().optional(),
        lastRunVersion: z.string().optional(),
        lastRunCommit: z.string().optional(),
        lastRunCommand: z.string().optional(),
        lastRunMode: z.union([z.literal("local"), z.literal("remote")]).optional(),
      })
      .strict()
      .optional(),
    diagnostics: z
      .object({
        enabled: z.boolean().optional(),
        flags: z.array(z.string()).optional(),
        otel: z
          .object({
            enabled: z.boolean().optional(),
            endpoint: z.string().optional(),
            protocol: z.union([z.literal("http/protobuf"), z.literal("grpc")]).optional(),
            headers: z.record(z.string(), z.string()).optional(),
            serviceName: z.string().optional(),
            traces: z.boolean().optional(),
            metrics: z.boolean().optional(),
            logs: z.boolean().optional(),
            sampleRate: z.number().min(0).max(1).optional(),
            flushIntervalMs: z.number().int().nonnegative().optional(),
          })
          .strict()
          .optional(),
        cacheTrace: z
          .object({
            enabled: z.boolean().optional(),
            filePath: z.string().optional(),
            includeMessages: z.boolean().optional(),
            includePrompt: z.boolean().optional(),
            includeSystem: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    logging: z
      .object({
        level: LoggingLevelSchema.optional(),
        file: z.string().optional(),
        maxFileBytes: z.number().int().positive().optional(),
        consoleLevel: LoggingLevelSchema.optional(),
        consoleStyle: z
          .union([z.literal("pretty"), z.literal("compact"), z.literal("json")])
          .optional(),
        redactSensitive: z.union([z.literal("off"), z.literal("tools")]).optional(),
        redactPatterns: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    update: z
      .object({
        channel: z.union([z.literal("stable"), z.literal("beta"), z.literal("dev")]).optional(),
        checkOnStart: z.boolean().optional(),
        auto: z
          .object({
            enabled: z.boolean().optional(),
            stableDelayHours: z.number().nonnegative().max(168).optional(),
            stableJitterHours: z.number().nonnegative().max(168).optional(),
            betaCheckIntervalHours: z.number().positive().max(24).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    browser: z
      .object({
        enabled: z.boolean().optional(),
        evaluateEnabled: z.boolean().optional(),
        cdpUrl: z.string().optional(),
        remoteCdpTimeoutMs: z.number().int().nonnegative().optional(),
        remoteCdpHandshakeTimeoutMs: z.number().int().nonnegative().optional(),
        color: z.string().optional(),
        executablePath: z.string().optional(),
        headless: z.boolean().optional(),
        noSandbox: z.boolean().optional(),
        attachOnly: z.boolean().optional(),
        defaultProfile: z.string().optional(),
        snapshotDefaults: BrowserSnapshotDefaultsSchema,
        ssrfPolicy: z
          .object({
            allowPrivateNetwork: z.boolean().optional(),
            dangerouslyAllowPrivateNetwork: z.boolean().optional(),
            allowedHostnames: z.array(z.string()).optional(),
            hostnameAllowlist: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        profiles: z
          .record(
            z
              .string()
              .regex(/^[a-z0-9-]+$/, "Profile names must be alphanumeric with hyphens only"),
            z
              .object({
                cdpPort: z.number().int().min(1).max(65535).optional(),
                cdpUrl: z.string().optional(),
                driver: z.union([z.literal("clawd"), z.literal("extension")]).optional(),
                color: HexColorSchema,
              })
              .strict()
              .refine((value) => value.cdpPort || value.cdpUrl, {
                message: "Profile must set cdpPort or cdpUrl",
              }),
          )
          .optional(),
      })
      .strict()
      .optional(),
    ui: z
      .object({
        seamColor: HexColorSchema.optional(),
        assistant: z
          .object({
            name: z.string().max(50).optional(),
            avatar: z.string().max(200).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    auth: z
      .object({
        profiles: z
          .record(
            z.string(),
            z
              .object({
                provider: z.string(),
                mode: z.union([z.literal("api_key"), z.literal("oauth"), z.literal("token")]),
                email: z.string().optional(),
              })
              .strict(),
          )
          .optional(),
        order: z.record(z.string(), z.array(z.string())).optional(),
        cooldowns: z
          .object({
            billingBackoffHours: z.number().positive().optional(),
            billingBackoffHoursByProvider: z.record(z.string(), z.number().positive()).optional(),
            billingMaxHours: z.number().positive().optional(),
            failureWindowHours: z.number().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    acp: z
      .object({
        enabled: z.boolean().optional(),
        dispatch: z
          .object({
            enabled: z.boolean().optional(),
          })
          .strict()
          .optional(),
        backend: z.string().optional(),
        defaultAgent: z.string().optional(),
        allowedAgents: z.array(z.string()).optional(),
        maxConcurrentSessions: z.number().int().positive().optional(),
        stream: z
          .object({
            coalesceIdleMs: z.number().int().nonnegative().optional(),
            maxChunkChars: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
        runtime: z
          .object({
            ttlMinutes: z.number().int().positive().optional(),
            installCommand: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    models: ModelsConfigSchema,
    nodeHost: NodeHostSchema,
    agents: AgentsSchema,
    tools: ToolsSchema,
    bindings: BindingsSchema,
    broadcast: BroadcastSchema,
    audio: AudioSchema,
    media: z
      .object({
        preserveFilenames: z.boolean().optional(),
      })
      .strict()
      .optional(),
    messages: MessagesSchema,
    commands: CommandsSchema,
    approvals: ApprovalsSchema,
    session: SessionSchema,
    cron: z
      .object({
        enabled: z.boolean().optional(),
        store: z.string().optional(),
        maxConcurrentRuns: z.number().int().positive().optional(),
        webhook: HttpUrlSchema.optional(),
        webhookToken: z.string().optional().register(sensitive),
        sessionRetention: z.union([z.string(), z.literal(false)]).optional(),
        runLog: z
          .object({
            maxBytes: z.union([z.string(), z.number()]).optional(),
            keepLines: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .superRefine((val, ctx) => {
        if (val.sessionRetention !== undefined && val.sessionRetention !== false) {
          try {
            parseDurationMs(String(val.sessionRetention).trim(), { defaultUnit: "h" });
          } catch {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["sessionRetention"],
              message: "invalid duration (use ms, s, m, h, d)",
            });
          }
        }
        if (val.runLog?.maxBytes !== undefined) {
          try {
            parseByteSize(String(val.runLog.maxBytes).trim(), { defaultUnit: "b" });
          } catch {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["runLog", "maxBytes"],
              message: "invalid size (use b, kb, mb, gb, tb)",
            });
          }
        }
      })
      .optional(),
    hooks: z
      .object({
        enabled: z.boolean().optional(),
        path: z.string().optional(),
        token: z.string().optional().register(sensitive),
        defaultSessionKey: z.string().optional(),
        allowRequestSessionKey: z.boolean().optional(),
        allowedSessionKeyPrefixes: z.array(z.string()).optional(),
        allowedAgentIds: z.array(z.string()).optional(),
        maxBodyBytes: z.number().int().positive().optional(),
        presets: z.array(z.string()).optional(),
        transformsDir: z.string().optional(),
        mappings: z.array(HookMappingSchema).optional(),
        gmail: HooksGmailSchema,
        internal: InternalHooksSchema,
      })
      .strict()
      .optional(),
    web: z
      .object({
        enabled: z.boolean().optional(),
        heartbeatSeconds: z.number().int().positive().optional(),
        reconnect: z
          .object({
            initialMs: z.number().positive().optional(),
            maxMs: z.number().positive().optional(),
            factor: z.number().positive().optional(),
            jitter: z.number().min(0).max(1).optional(),
            maxAttempts: z.number().int().min(0).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    channels: ChannelsSchema,
    discovery: z
      .object({
        wideArea: z
          .object({
            enabled: z.boolean().optional(),
          })
          .strict()
          .optional(),
        mdns: z
          .object({
            mode: z.enum(["off", "minimal", "full"]).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    canvasHost: z
      .object({
        enabled: z.boolean().optional(),
        root: z.string().optional(),
        port: z.number().int().positive().optional(),
        liveReload: z.boolean().optional(),
      })
      .strict()
      .optional(),
    talk: z
      .object({
        provider: z.string().optional(),
        providers: z
          .record(
            z.string(),
            z
              .object({
                voiceId: z.string().optional(),
                voiceAliases: z.record(z.string(), z.string()).optional(),
                modelId: z.string().optional(),
                outputFormat: z.string().optional(),
                apiKey: z.string().optional().register(sensitive),
              })
              .catchall(z.unknown()),
          )
          .optional(),
        voiceId: z.string().optional(),
        voiceAliases: z.record(z.string(), z.string()).optional(),
        modelId: z.string().optional(),
        outputFormat: z.string().optional(),
        apiKey: z.string().optional().register(sensitive),
        interruptOnSpeech: z.boolean().optional(),
      })
      .strict()
      .optional(),
    gateway: z
      .object({
        port: z.number().int().positive().optional(),
        mode: z.union([z.literal("local"), z.literal("remote")]).optional(),
        bind: z
          .union([
            z.literal("auto"),
            z.literal("lan"),
            z.literal("loopback"),
            z.literal("custom"),
            z.literal("tailnet"),
          ])
          .optional(),
        customBindHost: z.string().optional(),
        controlUi: z
          .object({
            enabled: z.boolean().optional(),
            basePath: z.string().optional(),
            root: z.string().optional(),
            allowedOrigins: z.array(z.string()).optional(),
            dangerouslyAllowHostHeaderOriginFallback: z.boolean().optional(),
            allowInsecureAuth: z.boolean().optional(),
            dangerouslyDisableDeviceAuth: z.boolean().optional(),
          })
          .strict()
          .optional(),
        auth: z
          .object({
            mode: z
              .union([
                z.literal("none"),
                z.literal("token"),
                z.literal("password"),
                z.literal("trusted-proxy"),
              ])
              .optional(),
            token: z.string().optional().register(sensitive),
            password: z.string().optional().register(sensitive),
            allowTailscale: z.boolean().optional(),
            rateLimit: z
              .object({
                maxAttempts: z.number().optional(),
                windowMs: z.number().optional(),
                lockoutMs: z.number().optional(),
                exemptLoopback: z.boolean().optional(),
              })
              .strict()
              .optional(),
            trustedProxy: z
              .object({
                userHeader: z.string().min(1, "userHeader is required for trusted-proxy mode"),
                requiredHeaders: z.array(z.string()).optional(),
                allowUsers: z.array(z.string()).optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        trustedProxies: z.array(z.string()).optional(),
        allowRealIpFallback: z.boolean().optional(),
        tools: z
          .object({
            deny: z.array(z.string()).optional(),
            allow: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        channelHealthCheckMinutes: z.number().int().min(0).optional(),
        tailscale: z
          .object({
            mode: z.union([z.literal("off"), z.literal("serve"), z.literal("funnel")]).optional(),
            resetOnExit: z.boolean().optional(),
          })
          .strict()
          .optional(),
        remote: z
          .object({
            url: z.string().optional(),
            transport: z.union([z.literal("ssh"), z.literal("direct")]).optional(),
            token: z.string().optional().register(sensitive),
            password: z.string().optional().register(sensitive),
            tlsFingerprint: z.string().optional(),
            sshTarget: z.string().optional(),
            sshIdentity: z.string().optional(),
          })
          .strict()
          .optional(),
        reload: z
          .object({
            mode: z
              .union([
                z.literal("off"),
                z.literal("restart"),
                z.literal("hot"),
                z.literal("hybrid"),
              ])
              .optional(),
            debounceMs: z.number().int().min(0).optional(),
          })
          .strict()
          .optional(),
        tls: z
          .object({
            enabled: z.boolean().optional(),
            autoGenerate: z.boolean().optional(),
            certPath: z.string().optional(),
            keyPath: z.string().optional(),
            caPath: z.string().optional(),
          })
          .optional(),
        http: z
          .object({
            endpoints: z
              .object({
                chatCompletions: z
                  .object({
                    enabled: z.boolean().optional(),
                  })
                  .strict()
                  .optional(),
                responses: z
                  .object({
                    enabled: z.boolean().optional(),
                    maxBodyBytes: z.number().int().positive().optional(),
                    maxUrlParts: z.number().int().nonnegative().optional(),
                    files: z
                      .object({
                        allowUrl: z.boolean().optional(),
                        urlAllowlist: z.array(z.string()).optional(),
                        allowedMimes: z.array(z.string()).optional(),
                        maxBytes: z.number().int().positive().optional(),
                        maxChars: z.number().int().positive().optional(),
                        maxRedirects: z.number().int().nonnegative().optional(),
                        timeoutMs: z.number().int().positive().optional(),
                        pdf: z
                          .object({
                            maxPages: z.number().int().positive().optional(),
                            maxPixels: z.number().int().positive().optional(),
                            minTextChars: z.number().int().nonnegative().optional(),
                          })
                          .strict()
                          .optional(),
                      })
                      .strict()
                      .optional(),
                    images: z
                      .object({
                        allowUrl: z.boolean().optional(),
                        urlAllowlist: z.array(z.string()).optional(),
                        allowedMimes: z.array(z.string()).optional(),
                        maxBytes: z.number().int().positive().optional(),
                        maxRedirects: z.number().int().nonnegative().optional(),
                        timeoutMs: z.number().int().positive().optional(),
                      })
                      .strict()
                      .optional(),
                  })
                  .strict()
                  .optional(),
              })
              .strict()
              .optional(),
            securityHeaders: z
              .object({
                strictTransportSecurity: z.union([z.string(), z.literal(false)]).optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        nodes: z
          .object({
            browser: z
              .object({
                mode: z
                  .union([z.literal("auto"), z.literal("manual"), z.literal("off")])
                  .optional(),
                node: z.string().optional(),
              })
              .strict()
              .optional(),
            allowCommands: z.array(z.string()).optional(),
            denyCommands: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    memory: MemorySchema,
    skills: z
      .object({
        allowBundled: z.array(z.string()).optional(),
        load: z
          .object({
            extraDirs: z.array(z.string()).optional(),
            watch: z.boolean().optional(),
            watchDebounceMs: z.number().int().min(0).optional(),
          })
          .strict()
          .optional(),
        install: z
          .object({
            preferBrew: z.boolean().optional(),
            nodeManager: z
              .union([z.literal("npm"), z.literal("pnpm"), z.literal("yarn"), z.literal("bun")])
              .optional(),
          })
          .strict()
          .optional(),
        limits: z
          .object({
            maxCandidatesPerRoot: z.number().int().min(1).optional(),
            maxSkillsLoadedPerSource: z.number().int().min(1).optional(),
            maxSkillsInPrompt: z.number().int().min(0).optional(),
            maxSkillsPromptChars: z.number().int().min(0).optional(),
            maxSkillFileBytes: z.number().int().min(0).optional(),
          })
          .strict()
          .optional(),
        entries: z
          .record(
            z.string(),
            z
              .object({
                enabled: z.boolean().optional(),
                apiKey: z.string().optional().register(sensitive),
                env: z.record(z.string(), z.string()).optional(),
                config: z.record(z.string(), z.unknown()).optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
    plugins: z
      .object({
        enabled: z.boolean().optional(),
        allow: z.array(z.string()).optional(),
        deny: z.array(z.string()).optional(),
        load: z
          .object({
            paths: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        slots: z
          .object({
            memory: z.string().optional(),
          })
          .strict()
          .optional(),
        entries: z
          .record(
            z.string(),
            z
              .object({
                enabled: z.boolean().optional(),
                config: z.record(z.string(), z.unknown()).optional(),
              })
              .strict(),
          )
          .optional(),
        installs: z
          .record(
            z.string(),
            z
              .object({
                ...InstallRecordShape,
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const agents = cfg.agents?.list ?? [];
    if (agents.length === 0) {
      return;
    }
    const agentIds = new Set(agents.map((agent) => agent.id));

    const broadcast = cfg.broadcast;
    if (!broadcast) {
      return;
    }

    for (const [peerId, ids] of Object.entries(broadcast)) {
      if (peerId === "strategy") {
        continue;
      }
      if (!Array.isArray(ids)) {
        continue;
      }
      for (let idx = 0; idx < ids.length; idx += 1) {
        const agentId = ids[idx];
        if (!agentIds.has(agentId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["broadcast", peerId, idx],
            message: `Unknown agent id "${agentId}" (not in agents.list).`,
          });
        }
      }
    }
  });
