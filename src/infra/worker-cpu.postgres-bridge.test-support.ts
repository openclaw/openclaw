import { channel } from "node:diagnostics_channel";
import { once } from "node:events";
import {
  MessageChannel,
  parentPort,
  workerData,
  type MessagePort,
  type Worker,
} from "node:worker_threads";
import { installPostgresTestRootGuard } from "../../test/helpers/postgres-pool-roots.js";
import { createPostgresBridge } from "./postgres-sync/bridge-prestart.js";
import {
  closePostgresPool,
  createPostgresPoolEndpoints,
  postgresPoolTransferList,
} from "./postgres-sync/pool.js";
import type { PostgresBridge } from "./postgres-sync/protocol.js";
import { resolveRuntimeWorkerThreadExecArgv } from "./runtime-worker-url.js";
import { createCpuTrackedWorker, getTrackedWorkerPoolSnapshot } from "./worker-cpu.js";
import { waitForWorkerMemoryPort } from "./worker-memory-port.test-support.js";
import { serveWorkerMemorySamples } from "./worker-memory.js";

if (!parentPort) {
  throw new Error("Bridge census fixture requires a parent");
}
const control: MessagePort = workerData.control;
type Command = "create" | "close" | "nest" | "unnest" | "restart" | "snapshot" | "undeclared";
let selfRootEvents = 0;
const selfRootDiagnostic = channel("openclaw.postgres.pool.self-root");
selfRootDiagnostic.subscribe(() => selfRootEvents++);
let child: Worker | undefined;
let childControl: MessagePort | undefined;
async function createChild(depth: number): Promise<void> {
  const { port1, port2 } = new MessageChannel();
  const workerUrl = new URL(import.meta.url);
  const postgresPool = createPostgresPoolEndpoints();
  const worker = createCpuTrackedWorker(workerUrl, {
    workerData: { control: port2, depth, postgresPool },
    transferList: [port2, ...postgresPoolTransferList(postgresPool)],
    execArgv: resolveRuntimeWorkerThreadExecArgv(workerUrl),
  });
  child = worker;
  childControl = port1;
  await waitForWorkerMemoryPort(worker);
}
if (workerData.depth > 0) {
  await createChild(workerData.depth - 1);
}
serveWorkerMemorySamples(parentPort);
const bridges: PostgresBridge[] = [];
async function receive(command: Command): Promise<unknown> {
  if (command === "undeclared") {
    installPostgresTestRootGuard();
    // Exercise the installed listener inside this isolated carrier, without broadcasting
    // a deliberately invalid event to the Vitest host or other concurrent tests.
    selfRootDiagnostic.publish({
      threadId: 2_147_483_647,
      owner: "undeclared-fixture",
    });
    return undefined;
  }
  if (command === "snapshot") {
    return { ...getTrackedWorkerPoolSnapshot(), selfRootEvents };
  }
  if (command === "restart") {
    for (const bridge of bridges.splice(0)) {
      bridge.port.close();
    }
    await closePostgresPool();
    return receive("create");
  }
  if (command === "nest") {
    await createChild(0);
    return 0;
  }
  if (command === "unnest") {
    await child?.terminate();
    childControl?.close();
    child = undefined;
    childControl = undefined;
    return 0;
  }
  if (childControl) {
    const reply = once(childControl, "message");
    childControl.postMessage(command, []);
    return (await reply)[0];
  }
  if (command === "create") {
    bridges.push(
      createPostgresBridge({
        url: "postgres://localhost/bridge_census_fixture",
        schema: "fixture",
        storeId: "fixture",
      }),
    );
  } else {
    const bridge = bridges.pop();
    if (bridge) {
      bridge.port.close();
    }
  }
  return bridges.length;
}
control.on("message", (command: Command) => {
  void receive(command).then((reply) => control.postMessage(reply, []));
});
