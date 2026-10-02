import { closeSync, readSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { isPathInside } from "../infra/path-guards.js";
import type { WorkerLaunchDescriptor } from "./launch-descriptor.js";
import { NativeRuntimeConfigSchema } from "./native-runtime-config.js";

/** Private node-to-worker startup carrier, never part of a Gateway turn envelope. */
const WORKER_NATIVE_INFERENCE_STARTUP_ARG = "--internal-worker-native-inference";
const WORKER_NATIVE_INFERENCE_STARTUP_FD = 3;
const WORKER_NATIVE_INFERENCE_STARTUP_MAX_BYTES = 2 * 1024 * 1024;
const NativeInferenceStartupSchema = z.strictObject({
  config: NativeRuntimeConfigSchema,
  credentials: z.record(z.string(), z.string()),
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
  const grant = startup.config.workspaces.find((workspace) => workspace.id === assignment.agentId);
  const modelRef = assignment.modelRef.provider + "/" + assignment.modelRef.model;
  if (
    assignment.inference !== "runtime-local" ||
    !grant ||
    !(
      path.resolve(grant.path) === path.resolve(assignment.workspaceDir) ||
      (grant.scope === "subdirectories" &&
        isPathInside(path.resolve(grant.path), path.resolve(assignment.workspaceDir)))
    ) ||
    (grant.sessionId !== undefined && grant.sessionId !== descriptor.admission.sessionId) ||
    !grant.models.includes(modelRef) ||
    !startup.config.models.some(
      (model) =>
        model.provider === assignment.modelRef.provider && model.id === assignment.modelRef.model,
    )
  ) {
    throw new Error(
      "Node-local inference is not authorized for this agent, session, workspace, or model",
    );
  }
}
