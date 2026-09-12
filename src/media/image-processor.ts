import {
  RastermillError,
  RastermillUnavailableError,
  type ImageInput,
  type Rastermill,
} from "rastermill";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { createLocalImageProcessor } from "./image-processor-config.js";
import type {
  ImageProcessorOperation,
  ImageProcessorReply,
  ImageProcessorRequest,
} from "./image-processor.types.js";

const pool = new WorkerTaskPool<ImageProcessorRequest, ImageProcessorReply>({
  workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.imageProcessor),
  // Each Photon instance retains a WASM heap; serialize transforms rather than multiply decodes.
  maxWorkers: 1,
  sharedCompute: true,
});

async function runImageTask(
  input: ImageInput,
  operation: ImageProcessorOperation,
  signal?: AbortSignal,
): Promise<ImageProcessorReply> {
  const reply = await pool.run(
    () => ({
      ...operation,
      // The caller may reuse its Buffer. Transfer a dedicated copy only after admission.
      input: Uint8Array.from(input instanceof ArrayBuffer ? new Uint8Array(input) : input),
    }),
    {
      timeoutMs: 180_000,
      signal,
      inputBytes: input.byteLength,
      transferList: (request) => [request.input.buffer],
    },
  );
  // Structured cloning preserves Error messages but drops Rastermill's public error codes.
  if (reply.kind === "failed" && reply.code && !reply.unavailable) {
    reply.error = new RastermillError(reply.code, reply.error.message, { cause: reply.error });
  }
  return reply;
}

/** Keep cheap probes local and move in-process image computation off the caller's event loop. */
export function createImageProcessor(): Rastermill {
  const local = createLocalImageProcessor("auto");
  return {
    probe: (input) => local.probe(input),
    transparency: async (input) => {
      const reply = await runImageTask(input, { kind: "transparency" });
      if (reply.kind === "failed") {
        throw reply.unavailable
          ? new RastermillUnavailableError("transparency", reply.error.message, [reply.error])
          : reply.error;
      }
      if (reply.kind !== "transparency") {
        throw new Error("Unexpected image worker result");
      }
      return reply.value;
    },
    encode: async (input, options) => {
      const { signal, ...workerOptions } = options ?? {};
      const reply = await runImageTask(input, { kind: "encode", options: workerOptions }, signal);
      signal?.throwIfAborted();
      if (reply.kind === "failed") {
        if (!reply.unavailable) {
          throw reply.error;
        }
        // Preserve Rastermill's native-codec and alpha policy when its internal backend declines.
        return local.encode(input, options);
      }
      if (reply.kind !== "encode") {
        throw new Error("Unexpected image worker result");
      }
      const { data, ...value } = reply.value;
      return { ...value, data: Buffer.from(data.buffer, data.byteOffset, data.byteLength) };
    },
  };
}

export async function convertBmpToPngWithWorker(input: Buffer): Promise<Buffer> {
  const reply = await runImageTask(input, { kind: "bmpToPng" });
  if (reply.kind === "failed") {
    throw reply.error;
  }
  if (reply.kind !== "bmpToPng") {
    throw new Error("Unexpected image worker result");
  }
  return Buffer.from(reply.value.buffer, reply.value.byteOffset, reply.value.byteLength);
}
