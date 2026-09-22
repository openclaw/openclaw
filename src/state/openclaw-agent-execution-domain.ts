import type { DatabaseSync } from "node:sqlite";
import { isPromise } from "node:util/types";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  SQLITE_WORKER_PREPARE_COMMAND,
  type SqliteWorkerPreparedBackend,
  type SqliteWorkerCommand,
  type SqliteWorkerOperations,
} from "../infra/sqlite-worker-contract.js";

export type AgentDatabaseDomainOperations = {
  "database.domain.bind": {
    input: { id: string; moduleUrl: string; input: unknown };
    output: void;
  };
  "database.domain.execute": {
    input: { id: string; command: SqliteWorkerCommand<SqliteWorkerOperations> };
    output: unknown;
  };
  "database.domain.close": { input: { id: string }; output: void };
};

/** One admitted publication scope borrows the canonical connection; it never owns its close. */
export function createAgentDatabaseDomainOwner(context: {
  databasePath: string;
  assertCurrent(): DatabaseSync;
  admit(stage: "transaction" | "commit"): void;
}) {
  let binding:
    | { id: string; backend: SqliteWorkerPreparedBackend<SqliteWorkerOperations>; closing: boolean }
    | undefined;
  let prepared: { id: string; factory: (input: unknown, context: unknown) => unknown } | undefined;
  let failedBinding = false;

  const requireBinding = (id: string) => {
    if (!binding || binding.id !== id || binding.closing) {
      throw new Error("Agent database operation lost its bound publication scope");
    }
    return binding;
  };

  return {
    async prepare(command: SqliteWorkerCommand<AgentDatabaseDomainOperations>) {
      if (command.type === "database.domain.bind") {
        if (binding || prepared) {
          throw new Error("Agent database already has an admitted publication scope");
        }
        const url = new URL(command.input.moduleUrl);
        if (url.protocol !== "file:" || url.search || url.hash) {
          throw new Error("Agent publication requires a static local module URL");
        }
        const module: unknown = await import(url.href);
        if (!isRecord(module) || typeof module.bindSqliteWorkerBackend !== "function") {
          throw new Error("Agent publication module must export bindSqliteWorkerBackend");
        }
        const factory = module.bindSqliteWorkerBackend;
        prepared = {
          id: command.input.id,
          factory: (input, bindingContext) => factory(input, bindingContext),
        };
      } else if (command.type === "database.domain.execute") {
        const current = requireBinding(command.input.id);
        const loading = current.backend[SQLITE_WORKER_PREPARE_COMMAND]?.(
          command.input.command.type,
        );
        if (loading) {
          await loading;
        }
        await current.backend.prepare?.(command.input.command);
        if (requireBinding(command.input.id) !== current) {
          throw new Error("Agent publication changed during command preparation");
        }
      }
    },
    execute(command: SqliteWorkerCommand<AgentDatabaseDomainOperations>): unknown {
      const database = context.assertCurrent();
      if (command.type === "database.domain.bind") {
        if (!prepared || prepared.id !== command.input.id || binding) {
          throw new Error("Agent publication module was not prepared for this scope");
        }
        const factory = prepared.factory;
        prepared = undefined;
        failedBinding = true;
        const backend = factory(command.input.input, {
          databasePath: context.databasePath,
          database,
          admit: (stage: "transaction" | "commit") => context.admit(stage),
        });
        if (isPromise(backend)) {
          void backend.catch(() => {});
          throw new Error("Connection-bound publication factories must remain synchronous");
        }
        if (
          !isRecord(backend) ||
          typeof backend.execute !== "function" ||
          typeof backend.close !== "function" ||
          typeof backend.assertSettled !== "function" ||
          (SQLITE_WORKER_PREPARE_COMMAND in backend &&
            backend[SQLITE_WORKER_PREPARE_COMMAND] !== undefined &&
            typeof backend[SQLITE_WORKER_PREPARE_COMMAND] !== "function") ||
          (backend.prepare !== undefined && typeof backend.prepare !== "function")
        ) {
          throw new Error("Agent publication module returned an invalid connection-bound backend");
        }
        binding = {
          id: command.input.id,
          // SAFETY: Factory methods were checked above; the paired module owns command decoding.
          backend: backend as SqliteWorkerPreparedBackend<SqliteWorkerOperations>,
          closing: false,
        };
        failedBinding = false;
        return undefined;
      }
      const current = requireBinding(command.input.id);
      if (command.type === "database.domain.close") {
        current.closing = true;
        const closed = current.backend.close();
        if (closed !== undefined) {
          void closed.catch(() => {});
          throw new Error("Connection-bound publication cleanup must remain synchronous");
        }
        binding = undefined;
        return undefined;
      }
      return current.backend.execute(command.input.command);
    },
    assertSettled() {
      prepared = undefined;
      if (failedBinding) {
        throw new Error("Agent publication binding did not settle");
      }
      if (binding?.closing) {
        throw new Error("Agent publication cleanup did not settle");
      }
      binding?.backend.assertSettled?.();
    },
    close() {
      if (binding) {
        binding.closing = true;
        const closed = binding.backend.close();
        if (closed !== undefined) {
          void closed.catch(() => {});
          throw new Error("Connection-bound publication cleanup must remain synchronous");
        }
        binding = undefined;
      }
      prepared = undefined;
    },
  };
}
