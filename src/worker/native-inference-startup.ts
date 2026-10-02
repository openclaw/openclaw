import { closeSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { WorkerLaunchDescriptor } from "./launch-descriptor.js";
import { NativeRuntimeConfigSchema } from "./native-runtime-config.js";

/** Private node-to-worker startup carrier, never part of a Gateway turn envelope. */
const WORKER_NATIVE_INFERENCE_STARTUP_ARG = "--internal-worker-native-inference";
const WORKER_NATIVE_INFERENCE_STARTUP_FD = 3;
const WORKER_NATIVE_INFERENCE_STARTUP_MAX_BYTES = 2 * 1024 * 1024;
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

/** A child receives only this grant and its permitted models, never another agent's credentials. */
export function projectNativeInferenceStartup(
  startup: NativeInferenceStartup,
  descriptor: WorkerLaunchDescriptor,
): NativeInferenceStartup {
  assertNativeInferenceAssignment(startup, descriptor);
  const grant = startup.config.workspaces.find(
    (entry) => entry.id === descriptor.assignment.agentId,
  );
  if (!grant) {
    throw new Error("Node-local inference workspace grant is missing");
  }
  const root = realpathSync(grant.path);
  const workspace = realpathSync(descriptor.assignment.workspaceDir);
  if (workspace !== root && !(grant.scope === "subdirectories" && isPathInside(root, workspace))) {
    throw new Error("Node-local inference workspace escapes its provisioned root");
  }
  const models = startup.config.models.filter((model) =>
    grant.models.includes(model.provider + "/" + model.id),
  );
  return {
    // Projection changes selection and canonical path, not the validated model definitions.
    config: structuredClone({ models, workspaces: [{ ...grant, path: root }] }),
    credentials: NativeInferenceStartupSchema.shape.credentials.parse(
      Object.fromEntries(
        models.map((model) => [model.apiKeyEnv, startup.credentials[model.apiKeyEnv]]),
      ),
    ),
  };
}
