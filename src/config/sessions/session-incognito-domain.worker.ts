import { randomUUID } from "node:crypto";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import type { SqliteWorkerOperations } from "../../infra/sqlite-worker-contract.js";
import {
  runWithSqliteWorkerStateContext,
  type SqliteWorkerStateContext,
} from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { createAgentDatabaseDomainOwner } from "../../state/openclaw-agent-execution-domain.js";

/** Prepared domain modules borrow the actor connection for one synchronous command. */
export function createIncognitoDomainWorker<Operations extends SqliteWorkerOperations>(
  database: OpenClawAgentDatabase,
  admit: (stage: "transaction" | "commit") => void,
  environment?: SqliteWorkerStateContext["environment"],
) {
  const domain = createAgentDatabaseDomainOwner({
    databasePath: database.path,
    assertCurrent: () => database.db,
    assertCleanupCurrent() {},
    admit,
  });
  let binding: { id: string; moduleUrl: string; input: unknown } | undefined;
  return {
    async prepare(module: Parameters<typeof resolveRuntimeWorkerUrl>[0], input?: unknown) {
      binding = { id: randomUUID(), moduleUrl: resolveRuntimeWorkerUrl(module).href, input };
      await domain.prepare({ type: "database.domain.bind", input: binding });
    },
    run<Value>(operation: () => Value): Value {
      const bound = binding;
      try {
        if (bound) {
          const bind = () => domain.execute({ type: "database.domain.bind", input: bound });
          if (environment) {
            runWithSqliteWorkerStateContext({ environment }, bind);
          } else {
            bind();
          }
        }
        return operation();
      } finally {
        if (bound) {
          domain.assertSettled();
          domain.execute({ type: "database.domain.close", input: { id: bound.id } });
          binding = undefined;
        }
      }
    },
    execute<Key extends keyof Operations & string>(command: {
      type: Key;
      input: Operations[Key]["input"];
    }): Operations[Key]["output"] {
      if (!binding) {
        throw new Error("Incognito domain was not prepared");
      }
      const result = domain.execute({
        type: "database.domain.execute",
        input: { id: binding.id, command },
      });
      // SAFETY: Each caller binds the fixed backend owning these command/result pairs.
      return result as Operations[Key]["output"];
    },
    assertSettled() {
      domain.assertSettled();
      binding = undefined;
    },
    close: () => domain.close(),
  };
}
