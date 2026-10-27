import * as json from "../../lib/snapshot-json.ts";

export const CHAT_HEADER_VIEWER_LIMIT = 3;
export const chatHeaderSharingSnapshotSchema = json.enumeration([
  "shared",
  "read-only",
  "suggest",
  "draft",
  "public",
]);
export type ChatHeaderSharingSnapshot = json.SnapshotValue<typeof chatHeaderSharingSnapshotSchema>;
export const chatHeaderViewersSnapshotSchema = json.object({
  users: json.array(
    json.object({
      id: json.text,
      profileId: json.optional(json.text),
      name: json.optional(json.text),
      email: json.optional(json.text),
      avatarUrl: json.optional(json.text),
    }),
    CHAT_HEADER_VIEWER_LIMIT,
  ),
  totalCount: json.refine(json.number, (count) => Number.isSafeInteger(count) && count >= 0),
  ownerViewing: json.boolean,
});

export type ChatHeaderViewersSnapshot = json.SnapshotValue<typeof chatHeaderViewersSnapshotSchema>;
