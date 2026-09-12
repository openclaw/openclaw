import { isRastermillError, isRastermillUnavailableError } from "rastermill";
import { serveWorkerTasks } from "../infra/worker-task-pool.js";
import { createLocalImageProcessor } from "./image-processor-config.js";
import type { ImageProcessorReply, ImageProcessorRequest } from "./image-processor.types.js";

// Native codecs stay in the caller, whose subprocess lifetime survives worker cancellation.
const processor = createLocalImageProcessor("internal");

serveWorkerTasks<ImageProcessorReply>(
  async (input) => {
    // SAFETY: The owning image pool is the sole sender and builds this private request with the worker.
    const request = input as ImageProcessorRequest;
    try {
      switch (request.kind) {
        case "encode": {
          const value = await processor.encode(request.input, request.options);
          return { kind: request.kind, value: { ...value, data: Uint8Array.from(value.data) } };
        }
        case "transparency":
          return { kind: request.kind, value: await processor.transparency(request.input) };
        case "bmpToPng": {
          const { convertBmpToPngWithPhoton } = await import("./photon.runtime.js");
          return {
            kind: request.kind,
            value: Uint8Array.from(convertBmpToPngWithPhoton(Buffer.from(request.input))),
          };
        }
        default:
          throw new Error("Unsupported image worker operation");
      }
    } catch (error) {
      return {
        kind: "failed",
        error: error instanceof Error ? error : new Error(String(error)),
        ...(isRastermillError(error) ? { code: error.code } : {}),
        unavailable: isRastermillUnavailableError(error),
      };
    }
  },
  {
    transferList: (reply) =>
      reply.kind === "encode"
        ? [reply.value.data.buffer]
        : reply.kind === "bmpToPng"
          ? [reply.value.buffer]
          : [],
  },
);
