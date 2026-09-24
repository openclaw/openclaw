import type { MentionStoreMessage, MentionStoreSnapshot } from "./mention-inbox-store.codec.js";

export type MentionInboxMutation = {
  now: number;
  action:
    | { kind: "maintain" }
    | { kind: "dismiss"; profileId: string; ids: string[] }
    | {
        kind: "record";
        sourceKey: string;
        message: MentionStoreMessage;
        recipients: { profileId: string; id: string | null; excerptProfileId: string }[];
      };
};
export type MentionInboxMutationResult = {
  snapshot: MentionStoreSnapshot;
  createdIds: string[];
  capacityReached: boolean;
};
export type MentionInboxWorkerOperations = {
  "mentions.mutate": { input: MentionInboxMutation; output: MentionInboxMutationResult };
};
