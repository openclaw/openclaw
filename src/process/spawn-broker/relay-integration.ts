import type { ChildProcess, Serializable, SpawnOptions } from "node:child_process";
import type { Duplex } from "node:stream";
import { stripNodeStartupHooks } from "../../../node-runtime-env.mjs";
import { formatChildRuntimeSpawnWarning } from "../../infra/child-runtime-viability.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerEnv,
} from "../../infra/runtime-worker-url.js";
import { resolveLaunchableNodePath } from "../../infra/stable-node-path.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withChildProcessOperation } from "../spawn-diagnostics.js";
import type { SpawnInitiation } from "../spawn-initiation.js";
import { spawnProcess } from "../spawn-utils.js";
import {
  encodeServiceChildMessage,
  type ServiceChildControlMessage,
  type ServiceChildControlPayload,
} from "../supervisor/service-child-protocol.js";
import { BrokerChild } from "./child.js";

export function createServiceChildControlSender(params: {
  child: ChildProcess;
  getControl: () => Duplex | null;
  useWindowsJobAnchor: boolean;
  startup: Promise<void>;
  cleanup: Promise<void>;
  generation: string;
  nextSequence: () => number;
}) {
  return (payload: ServiceChildControlPayload, initiate?: SpawnInitiation): Promise<void> => {
    const message: ServiceChildControlMessage = Object.assign(
      { type: payload.type, generation: params.generation, sequence: params.nextSequence() },
      payload,
    );
    // Failed startup releases launch custody only after confirmed containment cleanup.
    const settlement = initiate ? params.startup.catch(() => params.cleanup) : undefined;
    void settlement?.catch(() => {});
    if (params.useWindowsJobAnchor) {
      return initiateServiceChildRelay(
        params.child,
        message,
        initiate && ((launch) => initiate(launch, settlement)),
      );
    }
    return new Promise((resolve, reject) => {
      const control = params.getControl();
      if (!control || control.destroyed) {
        reject(new Error("service child control pipe is closed"));
        return;
      }
      let launched = false;
      const launch = () => {
        launched = true;
        return control.write(encodeServiceChildMessage(message), "utf8", (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      };
      if (!initiate) {
        launch();
        return;
      }
      try {
        initiate(launch, settlement);
      } catch (error) {
        if (launched) {
          throw error;
        }
        // Without a written frame the anchor never received launch authority.
        reject(new ServiceChildLaunchNotInitiatedError(error));
      }
    });
  };
}

/** A launch refusal that provably never wrote the frame granting the anchor spawn authority. */
export class ServiceChildLaunchNotInitiatedError extends Error {
  constructor(cause: unknown) {
    super(String(cause), { cause });
    this.name = "ServiceChildLaunchNotInitiatedError";
  }
}

/** Admit the target command when its final frame enters native IPC, after any broker queue. */
function initiateServiceChildRelay(
  child: ChildProcess,
  message: Serializable,
  initiateSpawn?: SpawnInitiation,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.connected) {
      reject(new Error("service child lifecycle IPC is closed"));
      return;
    }
    const done = (error: Error | null) => (error ? reject(error) : resolve());
    if (child instanceof BrokerChild) {
      child.send(message, undefined, undefined, done, initiateSpawn);
    } else {
      const launch = () => child.send(message, done);
      if (initiateSpawn) {
        initiateSpawn(launch);
      } else {
        launch();
      }
    }
  });
}

function createServiceChildCleanup() {
  const completion = createDeferredCore();
  let authorityClose: Promise<PromiseSettledResult<void>> | undefined;
  const promise = (async () => {
    const [outcome] = await Promise.allSettled([completion.promise]);
    const closed = await authorityClose;
    const failure = closed?.status === "rejected" ? closed : outcome;
    if (failure.status === "rejected") {
      throw failure.reason;
    }
  })();
  const outcome = Promise.allSettled([promise]);

  return {
    completion,
    promise,
    outcome,
    bindAuthorityClose:
      (close: () => Promise<void>, onFailure: (reason: unknown) => void) => () => {
        authorityClose = Promise.allSettled([close()]).then(([result]) => {
          if (result.status === "rejected") {
            onFailure(result.reason);
          }
          return result;
        });
      },
  };
}

/** Publish cleanup ownership before waiting for the broker's pipe and IPC handoff. */
export function spawnServiceChildRelay(params: {
  workerUrl: URL;
  stdio: SpawnOptions["stdio"];
  env: NodeJS.ProcessEnv;
  detached: boolean;
  nativeProcessOwner?: string;
  onSpawnCleanup?: (completion: Promise<void>) => void;
}): {
  child: ChildProcess;
  cleanup: ReturnType<typeof createServiceChildCleanup>;
  transportReady: Promise<void> | undefined;
} {
  const executable = resolveLaunchableNodePath();
  const child = withChildProcessOperation(
    "service.relay",
    () => {
      const env = resolveRuntimeWorkerEnv(params.workerUrl, params.env);
      if (env.NODE_OPTIONS !== undefined) {
        env.NODE_OPTIONS = stripNodeStartupHooks(env.NODE_OPTIONS);
      }
      // The admitted owner can select a native entry without the caller's image inventory.
      if (params.nativeProcessOwner === params.workerUrl.href) {
        delete env.BUN_BE_BUN;
      }
      return spawnProcess(executable, resolveRuntimeWorkerArgv(params.workerUrl, executable), {
        stdio: params.stdio,
        detached: params.detached,
        windowsHide: true,
        env,
      });
    },
    "default",
  );
  const cleanup = createServiceChildCleanup();
  params.onSpawnCleanup?.(cleanup.promise);
  let transportReady: Promise<void> | undefined;
  if (child instanceof BrokerChild) {
    transportReady = child.ready().catch((error: unknown) => {
      if (error instanceof Error) {
        error.message = formatChildRuntimeSpawnWarning(error) ?? error.message;
      }
      cleanup.completion.reject(error);
      throw error;
    });
  } else if (child.pid === undefined) {
    // Native spawn failures can lack stdio entirely. Join Node's close before
    // releasing the no-process cleanup owner, and preserve its original errno.
    const closed = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
    });
    transportReady = new Promise<Error>((resolve) => {
      child.once("error", resolve);
    }).then(async (error) => {
      await closed;
      cleanup.completion.resolve();
      error.message = formatChildRuntimeSpawnWarning(error) ?? error.message;
      throw error;
    });
  }
  return { child, cleanup, transportReady };
}
