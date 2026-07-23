// Defines core provider schema fragments for config parsing.
import { isValidInboundPathRootPattern } from "@openclaw/media-core/inbound-path-policy";
import { z } from "zod";
import { buildGroupEntrySchema } from "../channels/plugins/config-schema.js";
import { isSafeScpRemoteHost } from "../infra/scp-host.js";
import {
  normalizeCommandDescription,
  normalizeSlashCommandName,
  resolveCustomCommands,
} from "../shared/custom-command-config.js";
import { ToolPolicySchema } from "./zod-schema.agent-runtime.js";
import {
  ChannelSendReadReceiptsSchema,
  buildChannelExecApprovalsSchema,
  buildChannelReactionShape,
  buildCommonChannelAccountShape,
  ChannelPreviewStreamingConfigSchema,
  ChannelStreamingPreviewSchema,
} from "./zod-schema.channel-messaging-common.js";
import {
  ChannelDeliveryStreamingConfigSchema,
  DmPolicySchema,
  ExecutableTokenSchema,
  GroupPolicySchema,
  ProviderCommandsSchema,
  SecretInputSchema,
  requireAllowlistAllowFrom,
  requireOpenAllowFrom,
} from "./zod-schema.core.js";
import { validateTelegramWebhookSecretRequirements } from "./zod-schema.secret-input-validation.js";
import { sensitive } from "./zod-schema.sensitive.js";

const ToolPolicyBySenderSchema = z.record(z.string(), ToolPolicySchema).optional();

const TelegramInlineButtonsScopeSchema = z.enum(["off", "dm", "group", "all", "allowlist"]);
const TelegramCapabilitiesSchema = z.union([
  z.array(z.string()),
  z
    .object({
      inlineButtons: TelegramInlineButtonsScopeSchema.optional(),
    })
    .strict(),
]);
const TelegramPreviewStreamingConfigSchema = ChannelPreviewStreamingConfigSchema.extend({
  preview: ChannelStreamingPreviewSchema.optional(),
}).strict();
const TelegramErrorPolicySchema = z.enum(["always", "once", "silent"]).optional();
const TelegramCommandNamePattern = /^[a-z0-9_]{1,32}$/;
const TelegramCustomCommandConfig = {
  label: "Telegram",
  pattern: TelegramCommandNamePattern,
  patternDescription: "use a-z, 0-9, underscore; max 32 chars",
} as const;
const TelegramTopicSchema = z
  .object({
    requireMention: z.boolean().optional(),
    ingest: z.boolean().optional(),
    disableAudioPreflight: z.boolean().optional(),
    groupPolicy: GroupPolicySchema.optional(),
    skills: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    systemPrompt: z.string().optional(),
    agentId: z.string().optional(),
    errorPolicy: TelegramErrorPolicySchema,
  })
  .strict();

const TelegramGroupSchema = buildGroupEntrySchema({
  ingest: z.boolean().optional(),
  disableAudioPreflight: z.boolean().optional(),
  groupPolicy: GroupPolicySchema.optional(),
  topics: z.record(z.string(), TelegramTopicSchema.optional()).optional(),
  errorPolicy: TelegramErrorPolicySchema,
});

const AutoTopicLabelSchema = z
  .union([
    z.boolean(),
    z
      .object({
        enabled: z.boolean().optional(),
        prompt: z.string().optional(),
      })
      .strict(),
  ])
  .optional();

const TelegramDirectSchema = z
  .object({
    dmPolicy: DmPolicySchema.optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
    skills: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    systemPrompt: z.string().optional(),
    topics: z.record(z.string(), TelegramTopicSchema.optional()).optional(),
    errorPolicy: TelegramErrorPolicySchema,
    requireTopic: z.boolean().optional(),
    autoTopicLabel: AutoTopicLabelSchema,
  })
  .strict();

const TelegramCustomCommandSchema = z
  .object({
    command: z.string().overwrite(normalizeSlashCommandName),
    description: z.string().overwrite(normalizeCommandDescription),
  })
  .strict();

const validateTelegramCustomCommands = (
  value: { customCommands?: Array<{ command?: string; description?: string }> },
  ctx: z.RefinementCtx,
) => {
  if (!value.customCommands || value.customCommands.length === 0) {
    return;
  }
  const { issues } = resolveCustomCommands({
    commands: value.customCommands,
    checkReserved: false,
    checkDuplicates: false,
    config: TelegramCustomCommandConfig,
  });
  for (const issue of issues) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["customCommands", issue.index, issue.field],
      message: issue.message,
    });
  }
};

const TelegramAccountSchemaBase = z
  .object({
    ...buildCommonChannelAccountShape({
      useDefaults: true,
      capabilities: TelegramCapabilitiesSchema.optional(),
      defaultTo: z.union([z.string(), z.number()]).optional(),
      streaming: TelegramPreviewStreamingConfigSchema.optional(),
    }),
    execApprovals: buildChannelExecApprovalsSchema(z.union([z.string(), z.number()])),
    commands: ProviderCommandsSchema,
    customCommands: z.array(TelegramCustomCommandSchema).optional(),
    botToken: SecretInputSchema.optional().register(sensitive),
    tokenFile: z.string().optional(),
    groups: z.record(z.string(), TelegramGroupSchema.optional()).optional(),
    direct: z.record(z.string(), TelegramDirectSchema.optional()).optional(),
    richMessages: z.boolean().optional(),
    network: z
      .object({
        autoSelectFamily: z.boolean().optional(),
        dnsResultOrder: z.enum(["ipv4first", "verbatim"]).optional(),
        dangerouslyAllowPrivateNetwork: z
          .boolean()
          .optional()
          .describe(
            "Dangerous opt-in for trusted Telegram fake-IP or transparent-proxy environments where api.telegram.org resolves to private/internal/special-use addresses during media downloads.",
          ),
      })
      .strict()
      .optional(),
    proxy: z.string().optional(),
    webhookUrl: z
      .string()
      .optional()
      .describe(
        "Public HTTPS webhook URL registered with Telegram for inbound updates. This must be internet-reachable and requires channels.telegram.webhookSecret.",
      ),
    webhookSecret: SecretInputSchema.optional()
      .describe(
        "Secret token sent to Telegram during webhook registration and verified on inbound webhook requests. Telegram returns this value for verification; this is not the gateway auth token and not the bot token.",
      )
      .register(sensitive),
    webhookPath: z
      .string()
      .optional()
      .describe(
        "Local webhook route path served by the gateway listener. Defaults to /telegram-webhook.",
      ),
    webhookHost: z
      .string()
      .optional()
      .describe(
        "Local bind host for the webhook listener. Defaults to 127.0.0.1; keep loopback unless you intentionally expose direct ingress.",
      ),
    webhookPort: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Local bind port for the webhook listener. Defaults to 8787; set to 0 to let the OS assign an ephemeral port.",
      ),
    webhookCertPath: z
      .string()
      .optional()
      .describe(
        "Path to the self-signed certificate (PEM) to upload to Telegram during webhook registration. Required for self-signed certs (direct IP or no domain).",
      ),
    actions: z
      .object({
        reactions: z.boolean().optional(),
        sendMessage: z.boolean().optional(),
        poll: z.boolean().optional(),
        deleteMessage: z.boolean().optional(),
        editMessage: z.boolean().optional(),
        sticker: z.boolean().optional(),
        createForumTopic: z.boolean().optional(),
        editForumTopic: z.boolean().optional(),
      })
      .strict()
      .optional(),
    threadBindings: z
      .object({
        enabled: z.boolean().optional(),
        idleHours: z.number().nonnegative().optional(),
        maxAgeHours: z.number().nonnegative().optional(),
        spawnSessions: z.boolean().optional(),
        defaultSpawnContext: z.enum(["isolated", "fork"]).optional(),
      })
      .strict()
      .optional(),
    ...buildChannelReactionShape({
      notificationModes: ["off", "own", "all"],
      reactionLevels: ["off", "ack", "minimal", "extensive"],
      ackReaction: z.string().optional(),
    }),
    linkPreview: z.boolean().optional(),
    silentErrorReplies: z.boolean().optional(),
    errorPolicy: TelegramErrorPolicySchema,
    apiRoot: z.string().url().optional(),
    trustedLocalFileRoots: z
      .array(z.string())
      .optional()
      .describe(
        "Trusted local filesystem roots for self-hosted Telegram Bot API absolute file_path values. Only absolute paths under these roots are read directly; all other absolute paths are rejected.",
      ),
    autoTopicLabel: AutoTopicLabelSchema,
  })
  .strict();

const TelegramAccountSchema = TelegramAccountSchemaBase.superRefine((value, ctx) => {
  // Account-level schemas skip allowFrom validation because accounts inherit
  // allowFrom from the parent channel config at runtime (resolveTelegramAccount
  // shallow-merges top-level and account values in src/telegram/accounts.ts).
  // Validation is enforced at the top-level TelegramConfigSchema instead.
  validateTelegramCustomCommands(value, ctx);
});

export const TelegramConfigSchema = TelegramAccountSchemaBase.extend({
  accounts: z.record(z.string(), TelegramAccountSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.telegram.dmPolicy="open" requires channels.telegram.allowFrom to include "*"',
  });
  requireAllowlistAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.telegram.dmPolicy="allowlist" requires channels.telegram.allowFrom to contain at least one sender ID',
  });
  validateTelegramCustomCommands(value, ctx);

  if (value.accounts) {
    for (const [accountId, account] of Object.entries(value.accounts)) {
      if (!account) {
        continue;
      }
      const effectivePolicy = account.dmPolicy ?? value.dmPolicy;
      const effectiveAllowFrom = account.allowFrom ?? value.allowFrom;
      requireOpenAllowFrom({
        policy: effectivePolicy,
        allowFrom: effectiveAllowFrom,
        ctx,
        path: ["accounts", accountId, "allowFrom"],
        message:
          'channels.telegram.accounts.*.dmPolicy="open" requires channels.telegram.accounts.*.allowFrom (or channels.telegram.allowFrom) to include "*"',
      });
      requireAllowlistAllowFrom({
        policy: effectivePolicy,
        allowFrom: effectiveAllowFrom,
        ctx,
        path: ["accounts", accountId, "allowFrom"],
        message:
          'channels.telegram.accounts.*.dmPolicy="allowlist" requires channels.telegram.accounts.*.allowFrom (or channels.telegram.allowFrom) to contain at least one sender ID',
      });
    }
  }

  if (!value.accounts) {
    validateTelegramWebhookSecretRequirements(value, ctx);
    return;
  }
  for (const [accountId, account] of Object.entries(value.accounts)) {
    if (!account) {
      continue;
    }
    if (account.enabled === false) {
      continue;
    }
    const effectiveDmPolicy = account.dmPolicy ?? value.dmPolicy;
    const effectiveAllowFrom = Array.isArray(account.allowFrom)
      ? account.allowFrom
      : value.allowFrom;
    requireOpenAllowFrom({
      policy: effectiveDmPolicy,
      allowFrom: effectiveAllowFrom,
      ctx,
      path: ["accounts", accountId, "allowFrom"],
      message:
        'channels.telegram.accounts.*.dmPolicy="open" requires channels.telegram.allowFrom or channels.telegram.accounts.*.allowFrom to include "*"',
    });
    requireAllowlistAllowFrom({
      policy: effectiveDmPolicy,
      allowFrom: effectiveAllowFrom,
      ctx,
      path: ["accounts", accountId, "allowFrom"],
      message:
        'channels.telegram.accounts.*.dmPolicy="allowlist" requires channels.telegram.allowFrom or channels.telegram.accounts.*.allowFrom to contain at least one sender ID',
    });
  }
  validateTelegramWebhookSecretRequirements(value, ctx);
});

const IMessageActionSchema = z
  .object({
    reactions: z.boolean().optional(),
    edit: z.boolean().optional(),
    unsend: z.boolean().optional(),
    reply: z.boolean().optional(),
    sendWithEffect: z.boolean().optional(),
    renameGroup: z.boolean().optional(),
    setGroupIcon: z.boolean().optional(),
    addParticipant: z.boolean().optional(),
    removeParticipant: z.boolean().optional(),
    leaveGroup: z.boolean().optional(),
    sendAttachment: z.boolean().optional(),
    polls: z.boolean().optional(),
  })
  .strict()
  .optional();

const IMessageAccountSchemaBase = z
  .object({
    ...buildCommonChannelAccountShape({
      useDefaults: true,
      omit: ["mentionPatterns", "replyToMode"],
      streaming: ChannelDeliveryStreamingConfigSchema.optional(),
      mediaMaxMb: z.number().int().positive().optional(),
    }),
    cliPath: ExecutableTokenSchema.optional(),
    dbPath: z.string().optional(),
    remoteHost: z
      .string()
      .refine(isSafeScpRemoteHost, "expected SSH host or user@host (no spaces/options)")
      .optional(),
    actions: IMessageActionSchema,
    service: z.union([z.literal("imessage"), z.literal("sms"), z.literal("auto")]).optional(),
    sendTransport: z.enum(["auto", "bridge", "applescript"]).optional(),
    region: z.string().optional(),
    includeAttachments: z.boolean().optional(),
    attachmentRoots: z
      .array(z.string().refine(isValidInboundPathRootPattern, "expected absolute path root"))
      .optional(),
    remoteAttachmentRoots: z
      .array(z.string().refine(isValidInboundPathRootPattern, "expected absolute path root"))
      .optional(),
    probeTimeoutMs: z.number().int().positive().optional(),
    sendReadReceipts: ChannelSendReadReceiptsSchema,
    ...buildChannelReactionShape({ notificationModes: ["off", "own", "all"] }),
    catchup: z
      .object({
        enabled: z.boolean().optional(),
        maxAgeMinutes: z.number().int().min(1).max(720).optional(),
        perRunLimit: z.number().int().min(1).max(500).optional(),
        firstRunLookbackMinutes: z.number().int().min(1).max(720).optional(),
        maxFailureRetries: z.number().int().min(1).max(1000).optional(),
      })
      .strict()
      .optional(),
    groups: z
      .record(
        z.string(),
        buildGroupEntrySchema(undefined, {
          omit: ["skills", "enabled", "allowFrom"],
        }).optional(),
      )
      .optional(),
  })
  .strict();

export const IMessageConfigSchema = IMessageAccountSchemaBase.extend({
  // Account-level schemas skip allowFrom validation because accounts inherit
  // allowFrom from the parent channel config at runtime.
  accounts: z.record(z.string(), IMessageAccountSchemaBase.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.imessage.dmPolicy="open" requires channels.imessage.allowFrom to include "*"',
  });
  requireAllowlistAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.imessage.dmPolicy="allowlist" requires channels.imessage.allowFrom to contain at least one sender ID',
  });

  if (!value.accounts) {
    return;
  }
  for (const [accountId, account] of Object.entries(value.accounts)) {
    if (!account) {
      continue;
    }
    const effectivePolicy = account.dmPolicy ?? value.dmPolicy;
    const effectiveAllowFrom = account.allowFrom ?? value.allowFrom;
    requireOpenAllowFrom({
      policy: effectivePolicy,
      allowFrom: effectiveAllowFrom,
      ctx,
      path: ["accounts", accountId, "allowFrom"],
      message:
        'channels.imessage.accounts.*.dmPolicy="open" requires channels.imessage.accounts.*.allowFrom (or channels.imessage.allowFrom) to include "*"',
    });
    requireAllowlistAllowFrom({
      policy: effectivePolicy,
      allowFrom: effectiveAllowFrom,
      ctx,
      path: ["accounts", accountId, "allowFrom"],
      message:
        'channels.imessage.accounts.*.dmPolicy="allowlist" requires channels.imessage.accounts.*.allowFrom (or channels.imessage.allowFrom) to contain at least one sender ID',
    });
  }
});
