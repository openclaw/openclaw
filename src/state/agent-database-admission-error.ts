import { resolveGlobalSingleton } from "../shared/global-singleton.js";

/** A database owner refused new work; an admitted command's failure is never classified here. */
export const AgentDatabaseExecutionAdmissionClosedError = resolveGlobalSingleton(
  Symbol.for("openclaw.agentDatabaseExecutionAdmissionClosedError"),
  () => class AdmissionClosedError extends Error {},
);
