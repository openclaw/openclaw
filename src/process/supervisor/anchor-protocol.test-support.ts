import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Duplex } from "node:stream";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { readLines } from "./service-child-group-anchor.preparation.test-support.js";
import type {
  ServiceChildAnchorMessage,
  ServiceChildControlPayload,
} from "./service-child-protocol.js";

export function createAnchorFixture({
  preload,
  legacy = false,
}: { preload?: string; legacy?: boolean } = {}) {
  const generation = randomUUID();
  const argv = resolveRuntimeWorkerArgv(
    resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.serviceChildGroupAnchor),
  );
  const child = spawn(
    process.execPath,
    preload ? [...argv.slice(0, -1), "--import", preload, argv.at(-1)!] : argv,
    {
      detached: true,
      stdio: preload
        ? ["pipe", "pipe", "pipe", "pipe", "pipe", "ipc", "pipe"]
        : ["ignore", "pipe", "pipe", "pipe", "pipe", "ipc"],
    },
  );
  const exited = createDeferredCore<{ code: number | null; signal: NodeJS.Signals | null }>();
  child.once("exit", (code, signal) => exited.resolve({ code, signal }));
  child.once("error", exited.reject);
  const control = child.stdio[3];
  const lineage = child.stdio[4];
  if (!(control instanceof Duplex) || !(lineage instanceof Duplex)) {
    child.kill("SIGKILL");
    throw new Error("Expected the anchor's control and lineage pipes");
  }
  let sequence = 0;
  const send = (payload: ServiceChildControlPayload) =>
    control.write(`${JSON.stringify({ ...payload, generation, sequence: ++sequence })}\n`);
  const messages: ServiceChildAnchorMessage[] = [];
  let receive: (message: ServiceChildAnchorMessage) => void = () => {};
  readLines(control, (line) => {
    // This fixture's spawned anchor is the sole control-channel writer.
    const message = JSON.parse(line) as ServiceChildAnchorMessage;
    messages.push(message);
    receive(message);
  });
  control.on("error", () => {});
  lineage.once("end", () => {
    if (!control.destroyed && !legacy) {
      send({ type: "lineage-closed" });
    }
  });
  lineage.resume();
  return {
    child,
    generation,
    control,
    messages,
    send,
    exited: exited.promise,
    onMessage: (listener: typeof receive) => {
      receive = listener;
    },
    nextSequence: () => ++sequence,
  };
}
