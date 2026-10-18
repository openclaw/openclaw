import { threadId } from "node:worker_threads";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

export type DatabaseProcessRole = "gateway" | "cli-oneshot";

const processRole = resolveGlobalSingleton(
  Symbol.for("openclaw.databaseProcessRole"),
  (): { role?: DatabaseProcessRole } => ({}),
);

/** Entry points install this once; embedded Gateways cannot inherit a CLI exception. */
export function installDatabaseProcessRole(role: DatabaseProcessRole): void {
  if (processRole.role && processRole.role !== role) {
    throw new Error(`Database process role is already ${processRole.role}; cannot become ${role}`);
  }
  processRole.role ??= role;
}

let admissionDepth = 0;

/** Temporarily admit synchronous boot and migration SQL on the Gateway main thread. */
export function withEngineStoreAdmission<T>(operation: () => T): T {
  admissionDepth += 1;
  try {
    const result = operation();
    if (isPromiseLike(result)) {
      throw new Error("Database engine admission must remain synchronous");
    }
    return result;
  } finally {
    admissionDepth -= 1;
  }
}

export function assertEngineStoreExecutionAllowed(): void {
  if (threadId === 0 && admissionDepth === 0 && processRole.role !== "cli-oneshot") {
    throw new Error(
      "PostgreSQL connections must run in a worker; only synchronous admission, migrations, and CLI one-shots may run on the main thread",
    );
  }
}
