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
  peerEquals?: "inboundPeer";
  invert?: boolean;
  allOf?: AllowDenyChannelRuleMatchShape[];
  anyOf?: AllowDenyChannelRuleMatchShape[];
};

const AllowDenyChannelRuleMatchSchema: z.ZodType<AllowDenyChannelRuleMatchShape> = z.lazy(() =>
  z
    .object({
      channel: z.string().optional(),
      chatType: AllowDenyChatTypeSchema,
      keyPrefix: z.string().optional(),
      rawKeyPrefix: z.string().optional(),
      peerEquals: AllowDenyPeerEqualsSchema.optional(),
      invert: z.boolean().optional(),
      allOf: z.array(AllowDenyChannelRuleMatchSchema).optional(),
      anyOf: z.array(AllowDenyChannelRuleMatchSchema).optional(),
    })
    .strict(),
);

export function createAllowDenyChannelRulesSchema() {
  return z
    .object({
      default: AllowDenyActionSchema.optional(),
      rules: z
        .array(
          z
            .object({
              action: AllowDenyActionSchema,
              match: AllowDenyChannelRuleMatchSchema.optional(),
            })
            .strict(),
        )
        .optional(),
    })
    .strict()
    .optional();
}
