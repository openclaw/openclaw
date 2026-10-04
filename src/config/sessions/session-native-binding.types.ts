import type { DatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import type { PluginStateNativeBindingPlan } from "../../plugin-state/plugin-state-native-binding.types.js";
import type { OpenClawStateWorkerErrorPayload } from "../../state/openclaw-state-worker-error.js";
import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";
import type {
  SqliteSessionReclamationPlan,
  SqliteSessionReclamationResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import type { SessionEntryPatchReceipt } from "./session-entry-patch.types.js";
import type { SessionEntry } from "./types.js";

export type SessionNativeBindingParticipants = {
  operationId: string;
  sharedSource: DatabasePathIdentity;
  participants: readonly {
    sessionKey: string;
    entry: SessionEntry;
    binding?: PluginStateNativeBindingPlan;
  }[];
};

export type SessionNativeBindingDeletion = SessionNativeBindingParticipants & {
  plan: Extract<SqliteSessionReclamationPlan, { kind: "entry" }>;
};

export type SessionNativeBindingReceipt = {
  kind: "session-native-binding";
  operationId: string;
  agent: "pending" | "committed" | "rolled-back";
  bindings: ("pending" | "absent" | "deleted" | "restored")[];
  receipt?: SessionEntryPatchReceipt;
  compensationFailure?: OpenClawStateWorkerErrorPayload;
};

export type SessionNativeBindingCandidate = {
  kind: "session-native-binding-deletion";
  result: Extract<SqliteSessionReclamationResult, { kind: "entry" }>;
  publication?: SessionEntryReplacementPublication;
};
