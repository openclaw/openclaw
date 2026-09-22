import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toStructuredErrorObject } from "@openclaw/normalization-core/error-coercion";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  confirmOpenClawAgentDatabaseIntegrity,
  listOpenClawRegisteredAgentDatabases,
  recordOpenClawAgentDatabaseOpenFailure,
} from "./openclaw-agent-db.js";
import type {
  OpenClawDatabaseVerifyResult,
  OpenClawDatabaseVerifyTarget,
} from "./openclaw-database-verify.worker.js";
import { recordOpenClawDatabaseQuarantine } from "./openclaw-quarantine-store.js";
import {
  confirmOpenClawStateDatabaseIntegrity,
  recordOpenClawStateDatabaseOpenFailure,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

export const OPENCLAW_DATABASE_VERIFY_INITIAL_DELAY_MS = 5 * 60_000;
export const OPENCLAW_DATABASE_VERIFY_INTERVAL_MS = 24 * 60 * 60_000;

const log = createSubsystemLogger("state/database-verify");
const DATABASE_VERIFY_CHILD_ARG = "--openclaw-database-verify-child";

function isVerifyResult(value: unknown): value is OpenClawDatabaseVerifyResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const result = value as Record<string, unknown>;
  return (
    typeof result.path === "string" &&
    typeof result.ok === "boolean" &&
    (result.error === undefined || typeof result.error === "string") &&
    (result.terminal === undefined || typeof result.terminal === "boolean")
  );
}

type DatabaseVerifyWorkerExit = { code: number | null; signal: NodeJS.Signals | null };
type DatabaseVerifyWorkerLifecycle = {
  settled: Promise<DatabaseVerifyWorkerExit>;
  requestTermination: () => void;
};
const workerLifecycles = new WeakMap<ChildProcess, DatabaseVerifyWorkerLifecycle>();

function ownDatabaseVerifyWorker(worker: ChildProcess): DatabaseVerifyWorkerLifecycle {
  let terminationRequested = false;
  const settled = new Promise<DatabaseVerifyWorkerExit>((resolve) => {
    let exit: DatabaseVerifyWorkerExit | undefined;
    let disconnected = !worker.connected;
    const finish = () => {
      if (!exit || !disconnected) {
        return;
      }
      worker.off("exit", onExit);
      worker.off("disconnect", onDisconnect);
      worker.off("close", onClose);
      resolve(exit);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      exit = { code, signal };
      finish();
    };
    const onDisconnect = () => {
      disconnected = true;
      finish();
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      // Failed launches emit error then close without exit. Spawned children
      // need exit+disconnect because parent disconnect can suppress close.
      if (worker.pid === undefined) {
        exit = { code, signal };
        disconnected = true;
        finish();
      }
    };
    worker.once("exit", onExit);
    worker.once("disconnect", onDisconnect);
    worker.once("close", onClose);
  });
  const lifecycle = {
    settled,
    requestTermination: () => {
      if (
        terminationRequested ||
        worker.pid === undefined ||
        worker.exitCode !== null ||
        worker.signalCode !== null
      ) {
        return;
      }
      terminationRequested = true;
      let signalError: Error | undefined;
      const onSignalError = (error: Error) => {
        signalError = error;
      };
      worker.on("error", onSignalError);
      try {
        if (worker.kill()) {
          return;
        }
      } catch (error) {
        signalError = toStructuredErrorObject(error);
      } finally {
        worker.off("error", onSignalError);
      }
      log.error("database verification worker termination failed; waiting for native exit", {
        pid: worker.pid,
        error: signalError?.message ?? "signal was not delivered",
      });
    },
  };
  workerLifecycles.set(worker, lifecycle);
  return lifecycle;
}

export function runDatabaseVerifyWorker(
  targets: readonly OpenClawDatabaseVerifyTarget[],
  options: { onWorker?: (worker: ChildProcess | undefined) => void; workerUrl?: URL } = {},
): Promise<OpenClawDatabaseVerifyResult[]> {
  const workerUrl =
    options.workerUrl ?? resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.databaseVerify);
  const execArgv = workerUrl.pathname.endsWith(".ts") ? ["--import", "tsx"] : undefined;
  let worker: ChildProcess;
  try {
    // Snapshot preparation opens and closes raw source descriptors. Isolate it
    // because POSIX close() can release the Gateway's process-owned SQLite locks.
    worker = fork(fileURLToPath(workerUrl), [DATABASE_VERIFY_CHILD_ARG], {
      execArgv,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
  } catch (error) {
    return Promise.reject(toStructuredErrorObject(error));
  }
  // Capture the lifetime before publishing the child so stop joins this same boundary.
  const lifecycle = ownDatabaseVerifyWorker(worker);
  let result: OpenClawDatabaseVerifyResult[] | undefined;
  let failure: Error | undefined;
  let settled = false;
  const fail = (error: unknown) => {
    if (settled) {
      return;
    }
    // kill() can emit another error synchronously. Preserve the triggering failure.
    failure ??= toStructuredErrorObject(error);
    lifecycle.requestTermination();
  };
  const onMessage = (message: unknown) => {
    if (!Array.isArray(message) || !message.every(isVerifyResult)) {
      fail(new Error("database verification worker returned invalid results"));
      return;
    }
    result = message;
  };
  worker.once("message", onMessage);
  worker.on("error", fail);
  const completion = lifecycle.settled.then((exit) => {
    settled = true;
    worker.off("message", onMessage);
    worker.off("error", fail);
    options.onWorker?.(undefined);
    if (failure) {
      throw failure;
    }
    if (exit.code !== 0) {
      throw new Error(
        `database verification worker exited with ${exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`}`,
      );
    }
    if (!result) {
      throw new Error("database verification worker exited without results");
    }
    return result;
  });
  options.onWorker?.(worker);
  if (worker.pid !== undefined) {
    try {
      worker.send(targets, (error) => {
        if (error) {
          fail(error);
        }
      });
    } catch (error) {
      fail(error);
    }
  }
  return completion;
}

export async function terminateDatabaseVerifyWorker(worker: ChildProcess): Promise<void> {
  const lifecycle = workerLifecycles.get(worker);
  if (!lifecycle) {
    throw new Error("database verification worker is not owned by this verifier");
  }
  lifecycle.requestTermination();
  await lifecycle.settled;
}

/** Resolve the state database and current registered agent database paths. */
export function collectOpenClawDatabaseVerifyTargets(options: {
  env: NodeJS.ProcessEnv;
}): OpenClawDatabaseVerifyTarget[] {
  const targets = new Map<string, OpenClawDatabaseVerifyTarget>();
  const statePath = path.resolve(resolveOpenClawStateSqlitePath(options.env));
  if (existsSync(statePath)) {
    targets.set(statePath, { kind: "state", label: "OpenClaw state database", path: statePath });
  }
  let registeredDatabases: ReturnType<typeof listOpenClawRegisteredAgentDatabases> = [];
  try {
    registeredDatabases = listOpenClawRegisteredAgentDatabases({ env: options.env });
  } catch (error) {
    log.warn("failed to collect registered agent databases for integrity verification", {
      error: String(error),
    });
  }
  for (const registered of registeredDatabases) {
    const agentPath = path.resolve(registered.path);
    if (!existsSync(agentPath) || targets.has(agentPath)) {
      continue;
    }
    targets.set(agentPath, {
      kind: "agent",
      label: `OpenClaw agent database ${registered.agentId}`,
      path: agentPath,
    });
  }
  return [...targets.values()];
}

/** Reconfirm worker failures on live owners before quarantine and latching. */
export async function applyOpenClawDatabaseVerificationResults(options: {
  env: NodeJS.ProcessEnv;
  results: readonly OpenClawDatabaseVerifyResult[];
  targets: readonly OpenClawDatabaseVerifyTarget[];
}): Promise<void> {
  const targetByPath = new Map(options.targets.map((target) => [target.path, target]));

  for (const result of options.results) {
    const target = targetByPath.get(result.path);
    if (!target) {
      continue;
    }
    if (result.ok) {
      log.info("database integrity verification passed", {
        kind: target.kind,
        label: target.label,
        path: result.path,
      });
      continue;
    }
    if (!result.terminal) {
      log.warn("database integrity verification was inconclusive", {
        kind: target.kind,
        label: target.label,
        path: result.path,
        error: result.error,
      });
      continue;
    }
    const confirmation =
      target.kind === "state"
        ? await confirmOpenClawStateDatabaseIntegrity(result.path)
        : await confirmOpenClawAgentDatabaseIntegrity(result.path);
    if (confirmation.status === "healthy") {
      log.info("discarding stale database integrity verification result", {
        kind: target.kind,
        label: target.label,
        path: result.path,
      });
      continue;
    }
    if (!confirmation.terminal) {
      log.warn("database integrity verification was inconclusive", {
        kind: target.kind,
        label: target.label,
        path: result.path,
        error: confirmation.error.message,
      });
      continue;
    }
    const latched =
      target.kind === "state"
        ? recordOpenClawStateDatabaseOpenFailure(
            result.path,
            confirmation.error,
            confirmation.generation,
          )
        : recordOpenClawAgentDatabaseOpenFailure(
            result.path,
            confirmation.error,
            confirmation.generation,
          );
    if (!latched) {
      log.info("discarding database integrity result after database generation changed", {
        kind: target.kind,
        label: target.label,
        path: result.path,
      });
      continue;
    }
    if (target.kind === "agent") {
      // Confirmation awaited drainage; retire any actor admitted before the terminal latch.
      await closeOpenClawAgentDatabaseByPathAsync(result.path);
    }
    const recorded = recordOpenClawDatabaseQuarantine({
      env: options.env,
      generation: confirmation.generation,
      kind: target.kind,
      path: result.path,
      reason: confirmation.error.message,
    });
    if (!recorded) {
      // Store unavailable. Daily verification retries persistence.
      log.error("failed to persist database quarantine; quarantine is process-local", {
        kind: target.kind,
        path: result.path,
      });
    }
    log.error("database integrity verification failed", {
      kind: target.kind,
      label: target.label,
      path: result.path,
      error: confirmation.error.message,
    });
  }
}
