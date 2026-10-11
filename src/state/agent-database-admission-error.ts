import { resolveGlobalSingleton } from "../shared/global-singleton.js";

/** A database owner refused new work; an admitted command's failure is never classified here. */
export const AgentDatabaseExecutionAdmissionClosedError = resolveGlobalSingleton(
  Symbol.for("openclaw.agentDatabaseExecutionAdmissionClosedError"),
  () => class AdmissionClosedError extends Error {},
);

/** A receipt lost its publication race; fresh admission can obtain current proof. */
export const AgentDatabaseSchemaAdmissionChangedError = resolveGlobalSingleton(
  Symbol.for("openclaw.agentDatabaseSchemaAdmissionChangedError"),
  () =>
    class SchemaAdmissionChangedError extends Error {
      constructor() {
        super("Agent schema admission changed before publication; retry the operation");
      }
    },
);

export const AgentDatabaseSchemaAdmissionInvalidError = resolveGlobalSingleton(
  Symbol.for("openclaw.agentDatabaseSchemaAdmissionInvalidError"),
  () =>
    class SchemaAdmissionInvalidError extends Error {
      constructor() {
        super("Invalid agent schema admission receipt");
      }
    },
);
