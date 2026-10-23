import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";
import type {
  SqliteSessionReclamationPlan,
  SqliteSessionReclamationResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import type { SessionNativeBindingParticipants } from "./session-native-binding.types.js";

export type SessionEntryDeletionPlan = Extract<SqliteSessionReclamationPlan, { kind: "entry" }>;
export type SessionEntryDeletionResult = Extract<SqliteSessionReclamationResult, { kind: "entry" }>;
export type SessionEntryDeletionInput = {
  plan: SessionEntryDeletionPlan;
  nativeBindings?: SessionNativeBindingParticipants;
};
export type SessionEntryDeletionCommitted = {
  kind: "session-entry-deletion";
  result: SessionEntryDeletionResult;
  publication?: SessionEntryReplacementPublication;
};
