import type { WorkerLaunchDescriptor } from "./launch-descriptor.js";
import {
  buildWorkerProcessTurn,
  parseWorkerProcessRequest,
  serializeWorkerProcessInput,
} from "./worker-process-protocol.js";

/** Exercise the production JSONL handoff, including whole-descriptor admission. */
export function roundTripWorkerLaunchDescriptor(descriptor: WorkerLaunchDescriptor) {
  const encoded = serializeWorkerProcessInput(buildWorkerProcessTurn(descriptor));
  const request = parseWorkerProcessRequest(JSON.parse(encoded));
  if (request.type !== "turn") {
    throw new Error("expected a serialized worker turn");
  }
  return request.descriptor;
}
