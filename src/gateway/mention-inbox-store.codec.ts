import { z } from "zod";
import { MAX_HUMAN_MENTIONS } from "../../packages/gateway-protocol/src/schema/human-mentions.js";

const reference = z.string().min(1).max(256);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const mentionStoreHeadSchema = z.object({ revision: timestamp, nextSequence: timestamp });
const recipientExcerptSchema = z
  .object({
    profileId: reference,
    excerpt: z.string().max(280),
    excerptMention: z.object({
      start: z.number().int().min(0).max(279),
      end: z.number().int().min(1).max(280),
    }),
  })
  .refine(
    ({ excerpt, excerptMention }) =>
      excerptMention.start < excerptMention.end && excerptMention.end <= excerpt.length,
  );
const messageSchema = z.object({
  sessionId: reference,
  content: z.object({
    senderProfileId: reference,
    sessionKey: z.string().min(1).max(512),
    agentId: reference,
    messageId: reference,
    createdAt: timestamp,
    excerpt: z.string().max(280).optional(),
  }),
  recipientExcerpts: z.array(recipientExcerptSchema).max(MAX_HUMAN_MENTIONS).optional(),
});
export const mentionStoreSourceSchema = z.object({
  key: z.string().regex(/^[a-f0-9]{64}$/),
  sequence: timestamp,
  expiresAt: timestamp,
  recipients: z.array(z.tuple([reference, reference.nullable()])).max(MAX_HUMAN_MENTIONS),
  message: messageSchema.optional(),
});

export type MentionStoreHead = z.infer<typeof mentionStoreHeadSchema>;
export type MentionStoreSource = z.infer<typeof mentionStoreSourceSchema>;
export type MentionStoreMessage = z.infer<typeof messageSchema>;
export type MentionStoreExcerpt = Omit<z.infer<typeof recipientExcerptSchema>, "profileId">;
export type MentionStoreSnapshot = {
  head: MentionStoreHead;
  sources: MentionStoreSource[];
};
