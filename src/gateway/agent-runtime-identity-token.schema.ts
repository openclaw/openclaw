// Wire schema for the agent runtime identity token payload. Validation here only
// proves shape; the token module still binds decoded facts to live run authority.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { z } from "zod";
import { normalizeChatType } from "../channels/chat-type.js";
import type { InternalChannelThreadingToolContext } from "../channels/threading-tool-context-internal.js";
import type { AgentRuntimeSessionSpawnContext } from "./agent-runtime-session-spawn-context.js";
import type { CronCreatorAuthorityGrant } from "./cron-creator-authority-grant.types.js";
import type { WorkerSessionTurnClaim } from "./worker-environments/placement-record.js";

export const AGENT_RUNTIME_IDENTITY_TOKEN_KIND = "agent-runtime";

const normalizedRequiredStringSchema = z
  .string()
  .transform(normalizeOptionalString)
  .pipe(z.string());
const ignoredOptionalStringSchema = z.unknown().transform(normalizeOptionalString).optional();
const safeNonNegativeIntegerSchema = z
  .number()
  .refine(Number.isSafeInteger)
  .refine((value) => value >= 0);
const operationalRunInstanceSchema = z.object({
  instanceId: normalizedRequiredStringSchema,
  runId: normalizedRequiredStringSchema,
});
export const gatewayUiCommandTargetSchema = z.object({
  connId: normalizedRequiredStringSchema,
  profileId: normalizedRequiredStringSchema.optional(),
});
const workerTurnClaimSchema = z
  .object({
    sessionId: normalizedRequiredStringSchema,
    claimId: normalizedRequiredStringSchema,
    runId: normalizedRequiredStringSchema,
    placementGeneration: safeNonNegativeIntegerSchema,
    owner: z.object({
      kind: z.literal("worker"),
      environmentId: normalizedRequiredStringSchema,
      ownerEpoch: safeNonNegativeIntegerSchema,
    }),
  })
  .transform((claim): WorkerSessionTurnClaim => ({
    sessionId: claim.sessionId,
    claimId: claim.claimId,
    runId: claim.runId,
    placementGeneration: claim.placementGeneration,
    owner: claim.owner,
  }));
const delegatedAuthoritySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local"),
    lifecycleGeneration: normalizedRequiredStringSchema,
    claimId: normalizedRequiredStringSchema,
    operationalRunInstance: operationalRunInstanceSchema,
  }),
  z.object({
    kind: z.literal("worker"),
    lifecycleGeneration: normalizedRequiredStringSchema,
    claimId: normalizedRequiredStringSchema,
    operationalRunInstance: operationalRunInstanceSchema,
    turnClaim: workerTurnClaimSchema,
  }),
]);
const stringListSchema = z
  .array(z.string())
  .transform((entries) => entries.map((entry) => entry.trim()).filter(Boolean));
const spawnModelAutoSelectionSchema = z.object({
  model: normalizedRequiredStringSchema,
  hasFallbackOrigin: z.boolean(),
});
export const sessionSpawnContextSchema = z
  .object({
    requesterProfileId: normalizedRequiredStringSchema.optional(),
    completionOwnerSessionKey: normalizedRequiredStringSchema.optional(),
    resolvedModel: z
      .object({
        provider: normalizedRequiredStringSchema,
        model: normalizedRequiredStringSchema,
      })
      .optional(),
    inheritedToolPolicy: z.object({
      version: z.literal(1),
      allow: stringListSchema,
      deny: stringListSchema,
    }),
    spawnModelAutoSelection: spawnModelAutoSelectionSchema.optional(),
  })
  .transform((context): AgentRuntimeSessionSpawnContext => ({
    ...(context.requesterProfileId ? { requesterProfileId: context.requesterProfileId } : {}),
    ...(context.completionOwnerSessionKey
      ? { completionOwnerSessionKey: context.completionOwnerSessionKey }
      : {}),
    inheritedToolPolicy: context.inheritedToolPolicy,
    ...(context.resolvedModel ? { resolvedModel: context.resolvedModel } : {}),
    ...(context.spawnModelAutoSelection
      ? { spawnModelAutoSelection: context.spawnModelAutoSelection }
      : {}),
  }));
const cronCreatorAuthorityGrantSchema = z
  .object({
    runId: normalizedRequiredStringSchema,
    token: normalizedRequiredStringSchema,
  })
  .transform((grant): CronCreatorAuthorityGrant => grant);
const messageActionToolContextSchema = z
  .object({
    currentChannelId: ignoredOptionalStringSchema,
    currentChatType: z
      .unknown()
      .transform((value) => normalizeChatType(typeof value === "string" ? value : undefined))
      .optional(),
    currentMessagingTarget: ignoredOptionalStringSchema,
    currentGraphChannelId: ignoredOptionalStringSchema,
    currentChannelProvider: ignoredOptionalStringSchema,
    currentThreadTs: ignoredOptionalStringSchema,
    currentMessageId: z.union([z.string(), z.number()]).optional(),
    currentSourceTurnId: ignoredOptionalStringSchema,
    replyToMode: z.enum(["off", "first", "all", "batched"]).optional(),
    hasRepliedRef: z.object({ value: z.boolean() }).optional(),
    sameChannelThreadRequired: z.boolean().optional().catch(undefined),
    skipCrossContextDecoration: z.boolean().optional().catch(undefined),
  })
  .transform((context): InternalChannelThreadingToolContext => context);
const messageActionContextSchema = z.object({
  expiresAtMs: z.number().finite(),
  turnCapability: normalizedRequiredStringSchema.optional(),
  sourceReplyFinal: z.boolean().optional(),
  sourceReplyToolCallId: normalizedRequiredStringSchema.optional(),
  sessionId: ignoredOptionalStringSchema,
  sourceReplySessionKey: ignoredOptionalStringSchema,
  requesterAccountId: ignoredOptionalStringSchema,
  requesterSenderId: ignoredOptionalStringSchema,
  requesterSenderName: ignoredOptionalStringSchema,
  requesterSenderUsername: ignoredOptionalStringSchema,
  requesterSenderE164: ignoredOptionalStringSchema,
  toolContext: messageActionToolContextSchema.optional(),
});
const cronSelfManagementContextSchema = z.object({
  jobId: normalizedRequiredStringSchema,
  expiresAtMs: z.number().finite(),
});
export const agentRuntimeIdentityTokenPayloadSchema = z.object({
  kind: z.literal(AGENT_RUNTIME_IDENTITY_TOKEN_KIND),
  agentId: z.string(),
  sessionKey: z.string(),
  operationalRunInstance: operationalRunInstanceSchema,
  delegatedAuthority: delegatedAuthoritySchema,
  fullPermission: z.literal(true).optional(),
  approvalOwnerPluginId: z.string().optional().catch(undefined),
  executionIdentity: z.unknown().optional(),
  turnSourceChannel: z.string().optional().catch(undefined),
  turnSourceLocal: z.literal(true).optional(),
  turnSourceTo: z.string().optional().catch(undefined),
  turnSourceAccountId: z.string().optional().catch(undefined),
  turnSourceThreadId: z.union([z.string(), z.number()]).optional().catch(undefined),
  gatewayUiCommandTarget: gatewayUiCommandTargetSchema.optional(),
  messageActionContext: messageActionContextSchema.optional(),
  cronSelfManagementContext: cronSelfManagementContextSchema.optional(),
  cronToolsAllowCapture: z.literal("final-executable-surface").optional(),
  cronExecToolTarget: z
    .object({ host: z.literal("gateway"), ask: z.literal("always").optional() })
    .optional(),
  cronCreatorAuthorityGrant: cronCreatorAuthorityGrantSchema.optional(),
  cronManagementGrant: cronCreatorAuthorityGrantSchema.optional(),
  sessionSpawnContext: sessionSpawnContextSchema.optional(),
  executionLineageHandoffId: normalizedRequiredStringSchema.optional(),
});

/** Shape-validated payload; authority and expiry checks remain with the token owner. */
export type AgentRuntimeIdentityTokenWirePayload = z.infer<
  typeof agentRuntimeIdentityTokenPayloadSchema
>;
