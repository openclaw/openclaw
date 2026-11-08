import { closeSync, readSync, realpathSync } from "node:fs";
import { z } from "zod";
import type { WorkerLaunchDescriptor } from "./launch-descriptor.js";
import { NativeRuntimeConfigSchema } from "./native-runtime-config.js";

/** Private node-to-worker startup carrier, never part of a Gateway turn envelope. */
export const WORKER_NATIVE_INFERENCE_STARTUP_ARG = "--internal-worker-native-inference";
export const WORKER_NATIVE_INFERENCE_STARTUP_FD = 3;
export const WORKER_NATIVE_INFERENCE_STARTUP_MAX_BYTES = 2 * 1024 * 1024;
const NativeInferenceStartupSchema = z.strictObject({
  config: NativeRuntimeConfigSchema,
  credentials: z.record(z.string(), z.string().min(1)),
});
export type NativeInferenceStartup = z.infer<typeof NativeInferenceStartupSchema>;

/** Drain the private pipe before the start gate, then close it before any tools can run. */
export function takeNativeInferenceStartup(
  args: string[] = process.argv,
): NativeInferenceStartup | undefined {
  const marker = args.indexOf(WORKER_NATIVE_INFERENCE_STARTUP_ARG);
  if (marker < 0) {
    return undefined;
  }
  args.splice(marker, 1);
  try {
    const data = Buffer.alloc(WORKER_NATIVE_INFERENCE_STARTUP_MAX_BYTES + 1);
    try {
      let length = 0;
      for (;;) {
        const count = readSync(
          WORKER_NATIVE_INFERENCE_STARTUP_FD,
          data,
          length,
          data.length - length,
          null,
        );
        length += count;
        if (length > WORKER_NATIVE_INFERENCE_STARTUP_MAX_BYTES) {
          throw new Error("Startup payload exceeds limit");
        }
        if (count === 0) {
          return NativeInferenceStartupSchema.parse(JSON.parse(data.toString("utf8", 0, length)));
        }
      }
    } finally {
      data.fill(0);
      closeSync(WORKER_NATIVE_INFERENCE_STARTUP_FD);
    }
  } catch {
    throw new Error("Invalid node-local inference startup configuration");
  }
}

export function assertNativeInferenceAssignment(
  startup: NativeInferenceStartup,
  descriptor: WorkerLaunchDescriptor,
): void {
  const assignment = descriptor.assignment;
  const modelRef = `${assignment.modelRef.provider}/${assignment.modelRef.model}`;
  const configuredWorkspace = realpathSync(startup.config.workspace);
  const assignedWorkspace = realpathSync(assignment.workspaceDir);
  if (
    assignment.inference !== "runtime-local" ||
    !startup.config.models.some(
      (model) => `${model.provider}/${model.id}` === modelRef && startup.credentials[modelRef],
    ) ||
    configuredWorkspace !== assignedWorkspace
  ) {
    throw new Error("Node-local inference startup does not match the admitted workspace or model");
  }
}
