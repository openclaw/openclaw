import { channel as createDiagnosticChannel } from "node:diagnostics_channel";
import {
  BroadcastChannel,
  isMainThread,
  MessageChannel,
  type MessagePort,
  Worker,
  threadId,
} from "node:worker_threads";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  getDatabaseEngineSelection,
  type DatabaseEngineSelection,
} from "../database-engine/context.js";
import { resolveRuntimeProcessEntrypointUrl } from "../runtime-process-url.js";
import { resolveRuntimeWorkerThreadExecArgv } from "../runtime-worker-url.js";
import { recordPostgresPoolSelfRoot, trackNativeWorkerForCpu } from "../worker-cpu.js";
import { workerScriptName } from "../worker-diagnostic-script.js";
import {
  postgresPoolState as state,
  type PostgresPoolEndpoint,
  type PostgresPoolEndpoints,
} from "./pool-state.js";

export type PostgresPoolSetup =
  | { host: MessagePort }
  | { connection: import("./protocol.js").BridgeWorkerData };
export type PostgresPoolWorkerData = {
  host: MessagePort;
  signal: SharedArrayBuffer;
  peers: PostgresPoolEndpoint[];
};

type PoolService = {
  channel: MessageChannel;
  signal: SharedArrayBuffer;
  peers: PostgresPoolEndpoint[];
};

const selfRootDiagnostic = createDiagnosticChannel("openclaw.postgres.pool.self-root");

function startPool(): PostgresPoolEndpoints {
  if (!isMainThread && recordPostgresPoolSelfRoot()) {
    const event = { threadId, owner: workerScriptName(process.argv[1] ?? "") };
    selfRootDiagnostic.publish(event);
    // Diagnostics cross thread boundaries even for externally constructed plugin workers.
    const diagnostics = new BroadcastChannel("openclaw.postgres.pool.self-root");
    diagnostics.unref();
    // Node BroadcastChannel has no targetOrigin argument.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    diagnostics.postMessage(event);
    diagnostics.close();
    createSubsystemLogger("postgres").warn(
      `PostgreSQL worker ${event.owner} (thread ${threadId}) has no inherited pool; starting its own four I/O services.`,
    );
  }
  const allocation = new SharedArrayBuffer(4);
  const services: PoolService[] = Array.from({ length: 4 }, () => ({
    channel: new MessageChannel(),
    signal: new SharedArrayBuffer(8),
    peers: [],
  }));
  // A surviving service publishes peer death even when MAIN cannot run events.
  for (let i = 0; i < services.length; i++) {
    for (let j = i + 1; j < services.length; j++) {
      const { port1, port2 } = new MessageChannel();
      services[i]!.peers.push({ port: port1, signal: services[j]!.signal });
      services[j]!.peers.push({ port: port2, signal: services[i]!.signal });
    }
  }
  const endpoints: PostgresPoolEndpoints = {
    services: services.map(({ channel, signal }) => ({ port: channel.port1, signal })),
    allocation,
    nextStep: state.nextStep,
  };
  const url = resolveRuntimeProcessEntrypointUrl("postgresBridge");
  const execArgv = resolveRuntimeWorkerThreadExecArgv(url);
  const workers: Worker[] = [];
  state.endpoints = endpoints;
  state.workers = workers;
  const launch = (index: number) => {
    const service = services[index]!;
    const signal = new Int32Array(service.signal);
    let exited = false;
    const worker = new Worker(url, {
      workerData: {
        host: service.channel.port2,
        signal: service.signal,
        peers: service.peers,
      } satisfies PostgresPoolWorkerData,
      transferList: [service.channel.port2, ...service.peers.map(({ port }) => port)],
      execArgv,
    });
    trackNativeWorkerForCpu(worker, url);
    worker.unref();
    service.channel.port1.unref();
    workers[index] = worker;
    const ready = new Promise<void>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("exit", () =>
        reject(
          new Error(
            `PostgreSQL I/O service exited before readiness.${state.nextStep ? ` Run ${state.nextStep}.` : ""}`,
          ),
        ),
      );
      worker.once("message", () => resolve());
    });
    void ready.catch(() => {});
    state.ready[index] = ready;
    worker.on("error", () => {});
    worker.once("exit", () => {
      exited = true;
      Atomics.store(signal, 1, 1);
      Atomics.notify(signal, 1);
      failedServices.add(index);
    });
    // A synchronous caller can expire the service while MAIN cannot receive events.
    void Promise.resolve(Atomics.waitAsync(signal, 1, 0).value).then(async () => {
      if (!exited) {
        await worker.terminate();
      }
    });
  };
  const failedServices = new Set<number>();
  state.refresh = () => {
    for (const index of failedServices) {
      failedServices.delete(index);
      // Only failed clients retire. Replacement hosts inherit the new setup endpoint;
      // checked-out connections are never moved or replayed.
      const replacement: PoolService = {
        channel: new MessageChannel(),
        signal: new SharedArrayBuffer(8),
        peers: [],
      };
      services[index] = replacement;
      endpoints.services[index] = { port: replacement.channel.port1, signal: replacement.signal };
      for (let peerIndex = 0; peerIndex < services.length; peerIndex++) {
        if (peerIndex === index) {
          continue;
        }
        const peer = services[peerIndex]!;
        const { port1, port2 } = new MessageChannel();
        replacement.peers.push({ port: port1, signal: peer.signal });
        workers[peerIndex]!.postMessage({ watch: { port: port2, signal: replacement.signal } }, [
          port2,
        ]);
      }
      launch(index);
    }
  };
  try {
    for (let index = 0; index < services.length; index++) {
      launch(index);
    }
  } catch (error) {
    void closePostgresPool();
    throw error;
  }
  return endpoints;
}

export function getPostgresPool(): PostgresPoolEndpoints {
  if (!state.nextStep) {
    state.refresh?.();
  }
  return state.endpoints ?? startPool();
}

/** A child inherits setup endpoints, never a forwarding hop for SQL requests. */
export function createPostgresPoolEndpoints(
  selection: DatabaseEngineSelection | undefined = getDatabaseEngineSelection(),
): PostgresPoolEndpoints | undefined {
  if (
    !state.endpoints &&
    (!selection || !Object.values(selection.effectiveEngines).includes("postgres"))
  ) {
    return undefined;
  }
  const pool = getPostgresPool();
  return {
    ...pool,
    services: pool.services.map(({ port, signal }) => {
      const channel = new MessageChannel();
      port.postMessage({ host: channel.port2 } satisfies PostgresPoolSetup, [channel.port2]);
      return { port: channel.port1, signal };
    }),
  };
}

export function postgresPoolTransferList(pool?: PostgresPoolEndpoints): MessagePort[] {
  return pool?.services.map(({ port }) => port) ?? [];
}

export function selectPostgresPoolService(): PostgresPoolEndpoint & { nextStep?: string } {
  const pool = getPostgresPool();
  const index = (Atomics.add(new Uint32Array(pool.allocation), 0, 1) >>> 0) % 4;
  return { ...pool.services[index]!, nextStep: pool.nextStep };
}

export async function preparePostgresPoolForUpdate(nextStep: string): Promise<void> {
  state.nextStep = nextStep;
  const selection = getDatabaseEngineSelection();
  if (
    state.endpoints ||
    (selection && Object.values(selection.effectiveEngines).includes("postgres"))
  ) {
    getPostgresPool().nextStep = nextStep;
    const workers = state.workers ?? [];
    workers.forEach((worker) => worker.ref());
    try {
      await Promise.all(state.ready);
    } finally {
      workers.forEach((worker) => worker.unref());
    }
  }
}

/** Executable cleanup calls this after SQL hosts and native backend-close settlement. */
export async function closePostgresPool(): Promise<void> {
  const workers = state.workers;
  state.workers = undefined;
  for (const { port } of state.endpoints?.services ?? []) {
    port.close();
  }
  state.endpoints = undefined;
  state.ready = [];
  state.refresh = undefined;
  state.failure = undefined;
  await Promise.all(workers?.map((worker) => worker.terminate()) ?? []);
}
