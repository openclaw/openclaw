import { isPromise } from "node:util/types";
import type { Transferable } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assertWorkspaceFilesystemEvidence } from "../agents/workspace-state-guard.js";
import { assertSessionStoreReadCandidate } from "../config/sessions/session-store-read-candidates.js";
import type { SearchSchema } from "../infra/database-engine/contract.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import {
  SQLITE_WORKER_PREPARE_COMMAND,
  type SqliteWorkerPreparedBackend,
  type SqliteWorkerCommand,
  type SqliteWorkerOperations,
} from "../infra/sqlite-worker-contract.js";
import {
  requestSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionRequest,
} from "../infra/sqlite-worker-operation-admission.js";
import { currentSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-settlement.js";
import { assertSqliteWorkerRequestCustody } from "../infra/sqlite-writer-admission-client.js";
import { admitAgentEngineSearchExtensions } from "./openclaw-agent-db-engine.js";
import type { readOpenClawAgentDatabaseIdentity } from "./openclaw-agent-db-identity.js";
import type {
  AgentDatabaseExecutionFileIdentity,
  AgentDatabaseFileExecutionIdentity,
} from "./openclaw-agent-execution-identity.types.js";
import type { readAgentDatabaseRequestPreparation } from "./openclaw-agent-execution-preparation.js";

/** Request-local physical facts stay on the native side of every live host grant. */
export function bindAgentDatabasePhysicalSources(
  preparation: ReturnType<typeof readAgentDatabaseRequestPreparation>,
): void {
  const { readCustody: custody, workspaceEvidence } = preparation;
  const operation = currentSqliteWorkerOperationAdmission.getStore();
  if (!operation) {
    throw new Error("Agent source custody requires its native operation");
  }
  if (custody || workspaceEvidence?.length) {
    operation.owner.assertPhysicalSourceCurrent = () => {
      for (const source of custody ?? []) {
        assertSessionStoreReadCandidate(source.sourcePath, source.candidates);
      }
      for (const evidence of workspaceEvidence ?? []) {
        assertWorkspaceFilesystemEvidence(evidence);
      }
    };
  }
  assertSqliteWorkerRequestCustody(operation.owner);
}

/** Initial native acceptance binds the file before its identity can be published to the host. */
export function acceptAgentDatabaseNativeFile(
  input: { databasePath: string; expectedIdentity?: AgentDatabaseExecutionFileIdentity },
  admittedIdentity: string,
  admittedBirthtime: string | undefined,
  native: ReturnType<typeof readOpenClawAgentDatabaseIdentity>,
): AgentDatabaseFileExecutionIdentity {
  const key = `file:${native.identity}`;
  if (
    admittedIdentity.startsWith("file:") &&
    (key !== admittedIdentity ||
      (admittedBirthtime !== undefined && native.birthtime !== admittedBirthtime))
  ) {
    throw new Error("Agent writer differs from its admitted physical file");
  }
  if (input.expectedIdentity && native.identity !== input.expectedIdentity.physicalIdentity) {
    throw new Error("Agent writer differs from its expected physical file");
  }
  const operation = currentSqliteWorkerOperationAdmission.getStore();
  if (operation) {
    operation.owner.databaseIdentity ??= {
      databasePath: input.databasePath,
      key,
      birthtime: native.birthtime,
    };
  }
  return {
    kind: "file",
    physicalIdentity: native.identity,
    birthtime: native.birthtime,
    incarnation: native.incarnation,
    nativeLocation: native.filename,
  };
}

export type AgentDatabaseAdmissionRestriction = (
  request: SqliteWorkerAdmissionRequest,
  dispatch: (request: SqliteWorkerAdmissionRequest) => void,
) => void;

/** A domain restriction must obtain exactly one grant for the original native stage. */
export function requestRestrictedAgentDatabaseAdmission(
  request: SqliteWorkerAdmissionRequest,
  restriction?: AgentDatabaseAdmissionRestriction,
  transferList?: Transferable[],
): void {
  const { stage } = request;
  let admitted = false;
  const dispatch = (restricted: SqliteWorkerAdmissionRequest) => {
    if (admitted || restricted.stage !== stage) {
      throw new Error("Agent admission restriction changed its native stage");
    }
    requestSqliteWorkerOperationAdmission(restricted, transferList);
    admitted = true;
  };
  if (restriction) {
    restriction(request, dispatch);
  } else {
    dispatch(request);
  }
  if (!admitted) {
    throw new Error("Agent admission restriction omitted its native grant");
  }
}

export type AgentDatabaseDomainOperations = {
  "database.domain.bind": {
    input: { id: string; moduleUrl: string; input: unknown };
    output: void;
  };
  "database.domain.execute": {
    input: { id: string; command: SqliteWorkerCommand<SqliteWorkerOperations> };
    output: unknown;
  };
  "database.domain.publish": {
    input: {
      id: string;
      moduleUrl: string;
      input: unknown;
      command: SqliteWorkerCommand<SqliteWorkerOperations>;
    };
    output: unknown;
  };
  "database.domain.close": { input: { id: string }; output: void };
};

/** One admitted publication scope borrows the canonical connection; it never owns its close. */
export function createAgentDatabaseDomainOwner(context: {
  databasePath: string;
  assertCurrent(): EngineConnection;
  assertCleanupCurrent(): void;
  admit(
    stage: "prepare" | "transaction" | "commit",
    requestAdmission?: AgentDatabaseAdmissionRestriction,
    transferList?: Transferable[],
  ): void;
}) {
  let binding:
    | {
        id: string;
        backend: SqliteWorkerPreparedBackend<SqliteWorkerOperations>;
        authority: { active: boolean };
      }
    | undefined;
  let prepared: { id: string; factory: (input: unknown, context: unknown) => unknown } | undefined;
  let failedBinding = false;

  const requireBinding = (id: string) => {
    if (!binding || binding.id !== id || !binding.authority.active) {
      throw new Error("Agent database operation lost its bound publication scope");
    }
    return binding;
  };

  const bind = (input: AgentDatabaseDomainOperations["database.domain.bind"]["input"]) => {
    const database = context.assertCurrent();
    if (!prepared || prepared.id !== input.id || binding) {
      throw new Error("Agent publication module was not prepared for this scope");
    }
    const factory = prepared.factory;
    prepared = undefined;
    failedBinding = true;
    const authority = { active: true };
    try {
      const backend = factory(input.input, {
        databasePath: context.databasePath,
        database,
        admitSearchExtensions: (definitions: Readonly<Record<string, SearchSchema>>) => {
          if (!authority.active) {
            throw new Error("Agent publication cleanup cannot admit search extensions");
          }
          admitAgentEngineSearchExtensions(database, definitions, (stage) => {
            context.assertCurrent();
            context.admit(stage);
          });
        },
        admit: (
          stage: "prepare" | "transaction" | "commit",
          requestAdmission?: AgentDatabaseAdmissionRestriction,
          transferList?: Transferable[],
        ) => {
          if (!authority.active) {
            throw new Error("Agent publication cleanup cannot admit a transaction");
          }
          context.admit(stage, requestAdmission, transferList);
        },
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
        id: input.id,
        // SAFETY: Factory methods were checked above; the paired module owns command decoding.
        backend: backend as SqliteWorkerPreparedBackend<SqliteWorkerOperations>,
        authority,
      };
      failedBinding = false;
    } catch (error) {
      authority.active = false;
      throw error;
    }
  };
  const prepareCommand = async (
    input: AgentDatabaseDomainOperations["database.domain.execute"]["input"],
  ) => {
    const current = requireBinding(input.id);
    const loading = current.backend[SQLITE_WORKER_PREPARE_COMMAND]?.(input.command.type);
    if (loading) {
      await loading;
    }
    await current.backend.prepare?.(input.command);
  };
  const closeBinding = () => {
    if (!binding) {
      return;
    }
    binding.authority.active = false;
    const closed = binding.backend.close();
    if (closed !== undefined) {
      void closed.catch(() => {});
      throw new Error("Connection-bound publication cleanup must remain synchronous");
    }
    binding = undefined;
  };

  return {
    async prepare(command: SqliteWorkerCommand<AgentDatabaseDomainOperations>) {
      if (command.type === "database.domain.bind" || command.type === "database.domain.publish") {
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
        await prepareCommand(command.input);
      }
    },
    async preparePublication(
      input: AgentDatabaseDomainOperations["database.domain.publish"]["input"],
    ) {
      bind(input);
      requireBinding(input.id).backend.assertSettled?.();
      // End the synchronous factory admission before invoking either asynchronous preparation hook.
      await Promise.resolve();
      await prepareCommand(input);
    },
    cleanupPublication(id: string) {
      if (binding?.id === id) {
        context.assertCleanupCurrent();
        closeBinding();
      }
    },
    execute(command: SqliteWorkerCommand<AgentDatabaseDomainOperations>): unknown {
      if (command.type === "database.domain.bind") {
        bind(command.input);
        return undefined;
      }
      context.assertCurrent();
      const current = requireBinding(command.input.id);
      if (command.type === "database.domain.close") {
        closeBinding();
        return undefined;
      }
      return current.backend.execute(command.input.command);
    },
    assertSettled() {
      prepared = undefined;
      if (failedBinding) {
        throw new Error("Agent publication binding did not settle");
      }
      if (binding && !binding.authority.active) {
        throw new Error("Agent publication cleanup did not settle");
      }
      binding?.backend.assertSettled?.();
    },
    close() {
      closeBinding();
      prepared = undefined;
    },
  };
}
