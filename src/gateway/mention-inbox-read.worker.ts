import type { DatabaseSync } from "node:sqlite";
import type {
  OpenClawStateReadCommand,
  OpenClawStateReadReply,
} from "../state/openclaw-state-read.types.js";
import { readHumanMentionPolicyInDatabase } from "./human-mention-policy-read.kernel.js";
import { readMentionStoreSnapshotInDatabase } from "./mention-inbox-store.js";

type MentionReadKind = "mentions.policy" | "mentions.snapshot";

/** Domain reply encoding runs only after the shared reader admits its database. */
export function executeMentionInboxRead(
  db: DatabaseSync,
  command: Extract<OpenClawStateReadCommand, { type: MentionReadKind }>,
): Extract<OpenClawStateReadReply, { type: MentionReadKind }> {
  return command.type === "mentions.policy"
    ? {
        ok: true,
        type: command.type,
        sourceAdmitted: true,
        result: readHumanMentionPolicyInDatabase(db, command.input),
      }
    : {
        ok: true,
        type: command.type,
        sourceAdmitted: true,
        snapshot: readMentionStoreSnapshotInDatabase(command.revision, db),
      };
}
