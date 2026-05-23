import { z } from "zod";

const AllowDenyActionSchema = z.union([z.literal("allow"), z.literal("deny")]);

const AllowDenyChatTypeSchema = z
  .union([
    z.literal("direct"),
    z.literal("group"),
    z.literal("channel"),
    /** @deprecated Use `direct` instead. Kept for backward compatibility. */
    z.literal("dm"),
  ])
  .optional();

const AllowDenyPeerEqualsSchema = z.literal("inboundPeer");

export type AllowDenyChannelRuleMatchShape = {
  channel?: string;
  chatType?: "direct" | "group" | "channel" | "dm";
  keyPrefix?: string;
  rawKeyPrefix?: string;
};

export type SessionSendPolicyRuleMatchShape = AllowDenyChannelRuleMatchShape & {
  peerEquals?: "inboundPeer";
  invert?: boolean;
  allOf?: SessionSendPolicyRuleMatchShape[];
  anyOf?: SessionSendPolicyRuleMatchShape[];
};

const AllowDenyChannelRuleMatchSchema: z.ZodType<AllowDenyChannelRuleMatchShape> = z
  .object({
    channel: z.string().optional(),
    chatType: AllowDenyChatTypeSchema,
    keyPrefix: z.string().optional(),
    rawKeyPrefix: z.string().optional(),
  })
  .strict();

function createSessionSendPolicyRuleMatchSchema(
  depth: number,
): z.ZodType<SessionSendPolicyRuleMatchShape> {
  const nestedSchema =
    depth > 0 ? createSessionSendPolicyRuleMatchSchema(depth - 1) : z.object({}).strict();

  return z
    .object({
      channel: z.string().optional(),
      chatType: AllowDenyChatTypeSchema,
      keyPrefix: z.string().optional(),
      rawKeyPrefix: z.string().optional(),
      peerEquals: AllowDenyPeerEqualsSchema.optional(),
      invert: z.boolean().optional(),
      allOf: z.array(nestedSchema).optional(),
      anyOf: z.array(nestedSchema).optional(),
    })
    .strict();
}

const SessionSendPolicyRuleMatchSchema = createSessionSendPolicyRuleMatchSchema(8);

function createAllowDenyRulesSchema<MatchShape>(matchSchema: z.ZodType<MatchShape>) {
  return z
    .object({
      default: AllowDenyActionSchema.optional(),
      rules: z
        .array(
          z
            .object({
              action: AllowDenyActionSchema,
              match: matchSchema.optional(),
            })
            .strict(),
        )
        .optional(),
    })
    .strict()
    .optional();
}

export function createAllowDenyChannelRulesSchema() {
  return createAllowDenyRulesSchema(AllowDenyChannelRuleMatchSchema);
}

export function createSessionSendPolicySchema() {
  return createAllowDenyRulesSchema(SessionSendPolicyRuleMatchSchema);
}
