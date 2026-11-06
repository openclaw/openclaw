import { z } from "zod";

const AllowDenyActionSchema = z.union([z.literal("allow"), z.literal("deny")]);

const AllowDenyChatTypeSchema = z
  .union([z.literal("direct"), z.literal("group"), z.literal("channel")])
  .optional();

export function createAllowDenyChannelRulesSchema() {
  return z
    .strictObject({
      default: AllowDenyActionSchema.optional(),
      rules: z
        .array(
          z.strictObject({
            action: AllowDenyActionSchema,
            match: z
              .strictObject({
                channel: z.string().optional(),
                chatType: AllowDenyChatTypeSchema,
                keyPrefix: z.string().optional(),
                rawKeyPrefix: z.string().optional(),
              })
              .optional(),
          }),
        )
        .optional(),
    })
    .optional();
}
