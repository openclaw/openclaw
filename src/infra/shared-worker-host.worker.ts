// Initialize the context-free root before an endpoint can lazily import maintenance owners.
import "../shared/detached-async-context.js";
import { MessagePort, parentPort, workerData } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { routeLogsToStderr } from "../logging/console.js";
import { installDatabaseEngineSelection } from "./database-engine/context.js";
import {
  runInHostedWorkerEndpoint,
  type HostedWorkerEndpoint,
  type HostedWorkerStart,
} from "./shared-worker-host-endpoint.js";
import type {
  SharedWorkerHostKind,
  SharedWorkerHostReply,
  SharedWorkerHostRequest,
} from "./shared-worker-host.types.js";
import { serveWorkerMemorySamples } from "./worker-memory.js";

// Static specifiers let the bundler place every hosted module in this host's shared graph.
const hostedModules: Record<SharedWorkerHostKind, () => Promise<unknown>> = {
  "sqlite-store": () => import("./sqlite-store.worker.js"),
  "session-transcript": () => import("../config/sessions/session-transcript.worker.js"),
  "state-read": () => import("../state/openclaw-state-read.worker.js"),
  "plugin-model-catalog-read": () => import("../agents/plugin-model-catalog-read.worker.js"),
};

if (!parentPort || !isRecord(workerData) || !(workerData.control instanceof MessagePort)) {
  throw new Error("Shared worker host requires its control port");
}
const control = workerData.control;
if (isRecord(workerData.databaseEngineSelection)) {
  installDatabaseEngineSelection(
    // SAFETY: The main thread sends its installed selection object unchanged.
    workerData.databaseEngineSelection as Parameters<typeof installDatabaseEngineSelection>[0],
  );
}
// The host isolate is the only physical heap; endpoints never sample memory themselves.
serveWorkerMemorySamples(parentPort);
// Endpoint results use their own ports; diagnostics must keep the Gateway's stdout clean.
routeLogsToStderr();

const endpoints = new Map<number, HostedWorkerEndpoint>();
const reply = (message: SharedWorkerHostReply) => control.postMessage(message, []);

async function startEndpoint(request: Extract<SharedWorkerHostRequest, { type: "attach" }>) {
  const loaded = await hostedModules[request.kind]();
  const start = isRecord(loaded) ? loaded.startHostedWorker : undefined;
  if (typeof start !== "function") {
    throw new Error(`Hosted module ${request.kind} does not export its endpoint start`);
  }
  const endpoint: HostedWorkerEndpoint = {
    port: request.port,
    workerData: request.workerData,
    ready: request.ready,
    fail: (reason) => reply({ type: "failed", id: request.id, reason }),
  };
  endpoints.set(request.id, endpoint);
  // SAFETY: Hosted modules export the HostedWorkerStart returned by their server owner.
  runInHostedWorkerEndpoint(endpoint, () => (start as HostedWorkerStart)(endpoint));
  reply({ type: "started", id: request.id });
}

async function stopEndpoint(id: number) {
  const endpoint = endpoints.get(id);
  endpoints.delete(id);
  try {
    await endpoint?.close?.();
  } finally {
    endpoint?.port.close();
  }
  reply({ type: "stopped", id });
}

control.on("message", (request: SharedWorkerHostRequest) => {
  const run = request.type === "attach" ? startEndpoint(request) : stopEndpoint(request.id);
  // A module that cannot start or stop leaves isolate state unknown; the owner replaces the host.
  run.catch((error: unknown) =>
    reply({
      type: "failed",
      id: request.id,
      reason: error instanceof Error ? error.message : String(error),
    }),
  );
});
