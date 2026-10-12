import type {
  MentionStoreHead,
  MentionStoreSnapshot,
  MentionStoreSource,
} from "./mention-inbox-store.js";

export type MentionMutation = {
  expectedHead: MentionStoreHead;
  nextSequence: number;
  changes: Array<[string, MentionStoreSource | undefined]>;
};

export type MentionMutationResult =
  | { kind: "conflict"; snapshot: MentionStoreSnapshot }
  | { kind: "committed"; head: MentionStoreHead };

export type MentionReadOperations = {
  "mentions.snapshot": {
    input: number;
    output: { type: "mentions.snapshot"; snapshot: MentionStoreSnapshot | undefined };
  };
};
