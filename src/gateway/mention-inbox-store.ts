import { z } from "zod";
import { MAX_HUMAN_MENTIONS } from "../../packages/gateway-protocol/src/index.js";
import {
  getOrLoadSqliteDatabaseAdmissionForPath,
  type SqliteDatabaseAdmissionKey,
} from "../infra/sqlite-database-admission.js";

export const MENTION_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const MAX_MENTION_SOURCES = 10_000;

const reference = z.string().min(1).max(256);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const mentionStoreHeadSchema = z.object({ revision: timestamp, nextSequence: timestamp });
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
export type MentionStoreSnapshot = {
  head: MentionStoreHead;
  sources: MentionStoreSource[];
};

export const mentionStoreHeadAdmission: SqliteDatabaseAdmissionKey<MentionStoreHead> = {
  name: "state.mention-head",
  read: (value) => mentionStoreHeadSchema.safeParse(value).data,
};

export function getMentionStoreHeadAdmission(databasePath: string): MentionStoreHead | undefined {
  return getOrLoadSqliteDatabaseAdmissionForPath(
    databasePath,
    mentionStoreHeadAdmission,
    () => undefined,
  );
}
