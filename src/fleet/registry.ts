import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import path from "node:path";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-coordinator.js";
import type { SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type {
  FleetCellOperationName,
  FleetCellRecord,
  FleetRegistryWriteOperations,
  ReserveFleetCellParams,
} from "./registry.types.js";

export type { FleetCellOperationName, FleetCellRecord } from "./registry.types.js";

type FleetOperationScope = Pick<SqliteWorkerStore<FleetRegistryWriteOperations>, "execute"> & {
  context: OpenClawStateWorkerContext;
  tenantId: string;
  owner: string;
  assertCurrent(): void;
};
const fleetOperationScopes = resolveGlobalSingleton(
  Symbol.for("openclaw.fleetOperationScopes"),
  () => new AsyncLocalStorage<FleetOperationScope>(),
);

async function writeFleetCell<
  Key extends "fleet.cell.reserve" | "fleet.cell.updateImage" | "fleet.cell.delete",
>(
  env: NodeJS.ProcessEnv,
  command: { type: Key; input: FleetRegistryWriteOperations[Key]["input"] },
): Promise<FleetRegistryWriteOperations[Key]["output"]> {
  const scope = fleetOperationScopes.getStore();
  if (scope) {
    scope.assertCurrent();
    if (
      scope.tenantId !== command.input.tenantId ||
      scope.context.admission.databasePath !== path.resolve(resolveOpenClawStateSqlitePath(env))
    ) {
      throw new Error("Fleet operation does not own the requested cell database");
    }
    return await scope.execute({
      type: command.type,
      input: { ...command.input, operationOwner: scope.owner },
    });
  }
  return await writeFleetRegistry(captureOpenClawStateWorkerContext({ env }), command);
}

async function writeFleetRegistry<Key extends keyof FleetRegistryWriteOperations>(
  context: OpenClawStateWorkerContext,
  command: { type: Key; input: FleetRegistryWriteOperations[Key]["input"] },
): Promise<FleetRegistryWriteOperations[Key]["output"]> {
  const { executeOpenClawStateWorker } = await import("../state/openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, command);
}

type FleetCellOperationLease = {
  heartbeat: (nowMs?: number) => Promise<void>;
  release: () => Promise<void>;
  owner: string;
};

/** CLI reads remain noncreating and never join Gateway writable lifecycle admission (#101290). */
export async function listFleetCells(
  env: NodeJS.ProcessEnv = process.env,
): Promise<FleetCellRecord[]> {
  const reply = await executeExistingOpenClawStateRead({ env }, { type: "fleet.list" });
  if (!reply) {
    return [];
  }
  if (!reply.ok || reply.type !== "fleet.list") {
    throw new Error("Unexpected Fleet registry list result");
  }
  return reply.cells;
}

export async function getFleetCell(
  env: NodeJS.ProcessEnv,
  tenantId: string,
): Promise<FleetCellRecord | undefined> {
  const reply = await executeExistingOpenClawStateRead({ env }, { type: "fleet.get", tenantId });
  if (!reply) {
    return undefined;
  }
  if (!reply.ok || reply.type !== "fleet.get") {
    throw new Error("Unexpected Fleet registry lookup result");
  }
  return reply.cell;
}

export async function reserveFleetCell(
  env: NodeJS.ProcessEnv,
  params: ReserveFleetCellParams,
): Promise<FleetCellRecord> {
  return await writeFleetCell(env, {
    type: "fleet.cell.reserve",
    input: { ...params },
  });
}

export async function updateFleetCellImage(
  env: NodeJS.ProcessEnv,
  tenantId: string,
  image: string,
): Promise<void> {
  await writeFleetCell(env, {
    type: "fleet.cell.updateImage",
    input: { tenantId, image },
  });
}

export async function deleteFleetCell(env: NodeJS.ProcessEnv, tenantId: string): Promise<void> {
  await writeFleetCell(env, { type: "fleet.cell.delete", input: { tenantId } });
}

export async function withFleetCellOperationLease<T>(
  params: {
    env: NodeJS.ProcessEnv;
    tenantId: string;
    operation: FleetCellOperationName;
    owner?: string;
    nowMs?: number;
  },
  operation: (lease: FleetCellOperationLease) => Promise<T>,
): Promise<T> {
  const context = captureOpenClawStateWorkerContext({ env: params.env });
  const owner = params.owner ?? crypto.randomUUID();
  const tenantId = params.tenantId;
  const claim = { tenantId, owner, operation: params.operation, nowMs: params.nowMs };
  const { runOpenClawStateWorkerOperation } =
    await import("../state/openclaw-state-worker-store.js");
  let phase: "claim" | "operation" | "cleanup" | "closed" = "claim";
  const assertCurrent = (commandType?: PropertyKey) => {
    context.admission.assertCurrent();
    if (phase === "closed" || (phase === "cleanup" && commandType !== "fleet.operation.release")) {
      throw new Error(`Fleet operation scope is closed for ${tenantId}.`);
    }
  };
  return await runOpenClawStateWorkerOperation(
    context,
    async (scope) => {
      await scope.execute({ type: "fleet.operation.acquire", input: claim });
      phase = "operation";
      let release: Promise<void> | undefined;
      const lease: FleetCellOperationLease = {
        owner,
        heartbeat: async (nowMs) => {
          if (phase !== "operation") {
            throw new Error(`Fleet operation lease was lost for ${tenantId}.`);
          }
          await scope.execute({
            type: "fleet.operation.heartbeat",
            input: { tenantId, owner, nowMs },
          });
        },
        release: () => {
          if (release) {
            return release;
          }
          phase = "cleanup";
          return (release = scope.execute({
            type: "fleet.operation.release",
            input: { tenantId, owner },
          }));
        },
      };
      let outcome: { value: T } | { error: unknown };
      const errors: unknown[] = [];
      try {
        outcome = {
          value: await fleetOperationScopes.run(
            { ...scope, context, tenantId, owner, assertCurrent },
            () => operation(lease),
          ),
        };
        context.admission.assertCurrent();
      } catch (error) {
        outcome = { error };
        errors.push(error);
      }
      try {
        await lease.release();
      } catch (error) {
        errors.push(error);
      } finally {
        // The existing client joins dispatched work after closing further command admission.
        phase = "closed";
      }
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw createSqliteLifecycleAggregateError(
          errors,
          "Fleet operation and lease release failed",
          errors[0],
        );
      }
      if ("error" in outcome) {
        throw outcome.error;
      }
      return outcome.value;
    },
    { assertCurrent },
  );
}
