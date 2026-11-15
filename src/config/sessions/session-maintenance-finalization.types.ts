import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";
import type {
  SqliteSessionReclamationPlan,
  SqliteSessionReclamationResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import type { SessionNativeBindingParticipants } from "./session-native-binding.types.js";

export type SessionMaintenanceFinalizationPlan = Extract<
  SqliteSessionReclamationPlan,
  { kind: "maintenance-finalize" }
>;
export type SessionMaintenanceFinalizationResult = Extract<
  SqliteSessionReclamationResult,
  { kind: "maintenance-finalize" }
>;
export type SessionMaintenanceFinalizationInput = {
  plan: SessionMaintenanceFinalizationPlan;
  nativeBindings?: SessionNativeBindingParticipants;
};
export type SessionMaintenanceFinalizationCommitted = {
  kind: "session-maintenance-finalize";
  result: SessionMaintenanceFinalizationResult;
  publication?: SessionEntryReplacementPublication;
};
