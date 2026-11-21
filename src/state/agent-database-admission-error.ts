import { formatErrorMessage } from "../infra/errors.js";
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
      constructor(stage: "publication" | "handle adoption" = "publication") {
        super(`Agent schema admission changed before ${stage}; retry the operation`);
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

/** Runtime publications kept replacing this one past its retries; the database stayed intact. */
export const AgentDatabaseStartupPublicationError = resolveGlobalSingleton(
  Symbol.for("openclaw.agentDatabaseStartupPublicationError"),
  () =>
    class StartupPublicationError extends Error {
      constructor(cause: unknown) {
        super(formatErrorMessage(cause), { cause });
      }
    },
);
