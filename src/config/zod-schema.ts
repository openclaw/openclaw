import { z } from "zod";
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

const MemoryQmdSchema = z
  .object({
    command: z.string().optional(),
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
        lastTouchedAt: z.string().optional(),
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
        file: z
          .union([
            z.string(),
            z.object({ path: z.string(), rotate: z.boolean().optional() }).strict(),
          ])
          .optional(),
        consoleLevel: z
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
      })
      .strict()
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
        controlUi: z
          .object({
            enabled: z.boolean().optional(),
            basePath: z.string().optional(),
            root: z.string().optional(),
            allowedOrigins: z.array(z.string()).optional(),
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
            hostname: z.string().optional(),
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
        consentGate: z
          .object({
            enabled: z.boolean().optional(),
            gatedTools: z.array(z.string()).optional(),
            observeOnly: z.boolean().optional(),
            storagePath: z.string().optional(),
            trustTierDefault: z.string().optional(),
            trustTierMapping: z.record(z.string(), z.string()).optional(),
            tierToolMatrix: z.record(z.string(), z.array(z.string())).optional(),
            rateLimit: z
              .object({
                maxOpsPerWindow: z.number().int().min(1),
                windowMs: z.number().int().min(1),
              })
              .strict()
              .optional(),
            anomaly: z
              .object({
                weightsByReason: z.record(z.string(), z.number()).optional(),
                quarantineThreshold: z.number().min(0).optional(),
                cascadeRevokeOnQuarantine: z.boolean().optional(),
              })
              .strict()
              .optional(),
            provider: z.union([z.literal("native"), z.literal("external")]).optional(),
            audit: z
              .object({
                enabled: z.boolean().optional(),
                destination: z.string().optional(),
                redactSecrets: z.boolean().optional(),
              })
              .strict()
              .optional(),
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
    security: z
      .object({
        pentest: z
          .object({
            enabled: z.boolean().optional(),
            workspace: z.string().optional(),
            tools: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        defense: z
          .object({
            enabled: z.boolean().optional(),
            workspace: z.string().optional(),
            siem: z
              .object({
                provider: z
                  .union([
                    z.literal("splunk"),
                    z.literal("elastic"),
                    z.literal("sentinel"),
                    z.literal("crowdstrike"),
                  ])
                  .optional(),
                endpoint: z.string().optional(),
                apiKey: z.string().optional().register(sensitive),
                index: z.string().optional(),
              })
              .strict()
              .optional(),
            threatHunting: z
              .object({
                enabled: z.boolean().optional(),
                schedules: z.array(z.string()).optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        soc: z
          .object({
            enabled: z.boolean().optional(),
            alerting: z
              .object({
                enabled: z.boolean().optional(),
                channels: z.array(z.string()).optional(),
              })
              .strict()
              .optional(),
            caseManagement: z
              .object({
                enabled: z.boolean().optional(),
                provider: z.string().optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        automation: z
          .object({
            enabled: z.boolean().optional(),
            workspace: z.string().optional(),
            threatModelUpdate: z
              .object({
                enabled: z.boolean().optional(),
                schedule: z.string().optional(),
                sources: z.array(z.string()).optional(),
              })
              .strict()
              .optional(),
            redTeamExercise: z
              .object({
                enabled: z.boolean().optional(),
                schedule: z.string().optional(),
                actors: z.array(z.string()).optional(),
              })
              .strict()
              .optional(),
            vulnerabilityTesting: z
              .object({
                enabled: z.boolean().optional(),
                schedule: z.string().optional(),
                products: z.array(z.string()).optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        threatHunting: z
          .object({
            enabled: z.boolean().optional(),
            proactiveHunting: z
              .object({
                enabled: z.boolean().optional(),
                actors: z.array(z.string()).optional(),
                schedule: z.string().optional(),
                sources: z.array(z.string()).optional(),
              })
              .strict()
              .optional(),
            anomalyDetection: z
              .object({
                enabled: z.boolean().optional(),
                livingOffTheLand: z.boolean().optional(),
                timeBasedAnomalies: z.boolean().optional(),
              })
              .strict()
              .optional(),
            sectorTracking: z
              .object({
                enabled: z.boolean().optional(),
                sectors: z.array(z.string()).optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        speedAutomation: z
          .object({
            enabled: z.boolean().optional(),
            vulnerabilityTesting: z
              .object({
                instantTest: z.boolean().optional(),
                patchValidation: z.boolean().optional(),
              })
              .strict()
              .optional(),
            attackResponse: z
              .object({
                automatedContainment: z.boolean().optional(),
                incidentGeneration: z.boolean().optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        webSecurity: z
          .object({
            enabled: z.boolean().optional(),
            browserTesting: z
              .object({
                enabled: z.boolean().optional(),
                headless: z.boolean().optional(),
              })
              .strict()
              .optional(),
            proxyTesting: z
              .object({
                enabled: z.boolean().optional(),
                proxyPort: z.number().int().min(1).max(65535).optional(),
              })
              .strict()
              .optional(),
            xssTesting: z
              .object({
                enabled: z.boolean().optional(),
                payloads: z.array(z.string()).optional(),
              })
              .strict()
              .optional(),
            sqliTesting: z
              .object({
                enabled: z.boolean().optional(),
                payloads: z.array(z.string()).optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        llmSecurity: z
          .object({
            enabled: z.boolean().optional(),
            workspace: z.string().optional(),
            promptInjection: z
              .object({
                enabled: z.boolean().optional(),
                detectionEnabled: z.boolean().optional(),
                testInterval: z.string().optional(),
              })
              .strict()
              .optional(),
            jailbreakTesting: z
              .object({
                enabled: z.boolean().optional(),
                automatedRedTeam: z.boolean().optional(),
                testCategories: z.array(z.string()).optional(),
              })
              .strict()
              .optional(),
            ragSecurity: z
              .object({
                enabled: z.boolean().optional(),
                poisoningDetection: z.boolean().optional(),
                integrityValidation: z.boolean().optional(),
              })
              .strict()
              .optional(),
            defenseValidation: z
              .object({
                enabled: z.boolean().optional(),
                guardrailTesting: z.boolean().optional(),
                architecturalValidation: z.boolean().optional(),
                cotMonitoring: z.boolean().optional(),
              })
              .strict()
              .optional(),
            attackLibraries: z
              .object({
                promptInjection: z.array(z.string()).optional(),
                jailbreak: z.array(z.string()).optional(),
                ragPoisoning: z.array(z.string()).optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        cognitiveSecurity: z
          .object({
            enabled: z.boolean().optional(),
            workspace: z.string().optional(),
            threatDetection: z
              .object({
                enabled: z.boolean().optional(),
                realTimeDetection: z.boolean().optional(),
                detectionTypes: z.array(z.string()).optional(),
              })
              .strict()
              .optional(),
            decisionIntegrity: z
              .object({
                enabled: z.boolean().optional(),
                oodaLoopEnabled: z.boolean().optional(),
                policyChecks: z.boolean().optional(),
                riskThreshold: z.number().min(0).max(1).optional(),
              })
              .strict()
              .optional(),
            escalationControl: z
              .object({
                enabled: z.boolean().optional(),
                maxChainDepth: z.number().int().nonnegative().optional(),
                maxCumulativeRisk: z.number().min(0).max(1).optional(),
                maxUncertainty: z.number().min(0).max(1).optional(),
              })
              .strict()
              .optional(),
            provenanceTracking: z
              .object({
                enabled: z.boolean().optional(),
                trackAllInputs: z.boolean().optional(),
                integrityScoring: z.boolean().optional(),
              })
              .strict()
              .optional(),
            gracefulDegradation: z
              .object({
                enabled: z.boolean().optional(),
                autoModeSwitching: z.boolean().optional(),
                riskThresholds: z
                  .object({
                    normal: z.number().min(0).max(1).optional(),
                    guarded: z.number().min(0).max(1).optional(),
                    restricted: z.number().min(0).max(1).optional(),
                    safe: z.number().min(0).max(1).optional(),
                  })
                  .strict()
                  .optional(),
              })
              .strict()
              .optional(),
            resilienceSimulation: z
              .object({
                enabled: z.boolean().optional(),
                schedule: z.string().optional(),
                scenarioTypes: z.array(z.string()).optional(),
              })
              .strict()
              .optional(),
            trustTrajectory: z
              .object({
                enabled: z.boolean().optional(),
                timeWindow: z.number().int().nonnegative().optional(),
                trackingEnabled: z.boolean().optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        adversaryRecommender: z
          .object({
            enabled: z.boolean().optional(),
            workspace: z.string().optional(),
            attackGeneration: z
              .object({
                enabled: z.boolean().optional(),
                testCount: z.number().int().nonnegative().optional(),
                attackFamilies: z.array(z.string()).optional(),
              })
              .strict()
              .optional(),
            optimization: z
              .object({
                enabled: z.boolean().optional(),
                maxIterations: z.number().int().nonnegative().optional(),
                mutationStrategies: z.array(z.string()).optional(),
              })
              .strict()
              .optional(),
            benchmarking: z
              .object({
                enabled: z.boolean().optional(),
                schedule: z.string().optional(),
                regressionThreshold: z.number().min(0).max(1).optional(),
              })
              .strict()
              .optional(),
            heartbeatIntegration: z
              .object({
                enabled: z.boolean().optional(),
                runOnHeartbeat: z.boolean().optional(),
                testCount: z.number().int().nonnegative().optional(),
              })
              .strict()
              .optional(),
            coverage: z
              .object({
                trackTechniqueCoverage: z.boolean().optional(),
                trackSurfaceCoverage: z.boolean().optional(),
                trackSeverityWeighted: z.boolean().optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        swarmAgents: z
          .object({
            enabled: z.boolean().optional(),
            workspace: z.string().optional(),
            redTeamSwarm: z
              .object({
                enabled: z.boolean().optional(),
                defaultSwarmSize: z.number().int().positive().optional(),
                agents: z.array(z.string()).optional(),
              })
              .strict()
              .optional(),
            blueTeamSwarm: z
              .object({
                enabled: z.boolean().optional(),
                defaultSwarmSize: z.number().int().positive().optional(),
                agents: z.array(z.string()).optional(),
              })
              .strict()
              .optional(),
            collaboration: z
              .object({
                enabled: z.boolean().optional(),
                defaultMode: z
                  .union([
                    z.literal("sequential"),
                    z.literal("parallel"),
                    z.literal("consensus"),
                  ])
                  .optional(),
                communicationProtocol: z
                  .union([
                    z.literal("broadcast"),
                    z.literal("hierarchical"),
                    z.literal("peer_to_peer"),
                  ])
                  .optional(),
              })
              .strict()
              .optional(),
            swarmVsSwarm: z
              .object({
                enabled: z.boolean().optional(),
                schedule: z.string().optional(),
                duration: z.number().int().nonnegative().optional(),
              })
              .strict()
              .optional(),
            integration: z
              .object({
                arrIntegration: z.boolean().optional(),
                cognitiveIntegration: z.boolean().optional(),
                heartbeatIntegration: z.boolean().optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
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
