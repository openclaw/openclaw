import { z } from "zod";
import {
  decodeQueuedOperatorRecoverySource,
  type QueuedOperatorRecoverySource,
} from "./operator-run-recovery-source.codec.js";

export const PLUGIN_RELOAD_OPERATION_KEY_PREFIX = "pluginReload.operation.";
export const MAX_ACTIVE_PLUGIN_RELOAD_OPERATIONS = 32;
export const MAX_TERMINAL_PLUGIN_RELOAD_OPERATIONS = 128;

export type PluginReloadContinuation = {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision?: string;
  sourceRunId: string;
  sourceInputKeys?: string[];
  recoverySource: QueuedOperatorRecoverySource;
  queuedInputIds: string[];
  state: "pending" | "cancelled" | "accepted" | "complete" | "failed";
  error?: string;
};

/** Exact original input scope; authority is revalidated separately at admission. */
export function pluginReloadContinuationIdentity(
  source: Pick<
    PluginReloadContinuation,
    "agentId" | "sessionKey" | "sessionId" | "lifecycleRevision" | "sourceRunId"
  >,
): string {
  return JSON.stringify([
    source.agentId,
    source.sessionKey,
    source.sessionId,
    source.lifecycleRevision,
    source.sourceRunId,
  ]);
}

export type PluginReloadOperation = {
  id: string;
  pluginIds: string[];
  requestKey?: string;
  createdAtMs: number;
  updatedAtMs: number;
  state: "accepted" | "interrupting" | "reloading" | "succeeded" | "failed";
  continuations: PluginReloadContinuation[];
  result?: unknown;
  error?: string;
};

const nonemptyString = z.string().min(1);
const timestamp = z.number().int().nonnegative();
const recoverySource = z.unknown().transform((value, context) => {
  try {
    return decodeQueuedOperatorRecoverySource(value);
  } catch {
    context.addIssue({ code: "custom", message: "Invalid queued operator recovery source" });
    return z.NEVER;
  }
});
const operationSchema = z
  .strictObject({
    id: nonemptyString.refine((id) => id === id.trim(), {
      message: "Invalid plugin reload operation id",
    }),
    pluginIds: z.array(nonemptyString).min(1),
    requestKey: nonemptyString.optional(),
    createdAtMs: timestamp,
    updatedAtMs: timestamp,
    state: z.enum(["accepted", "interrupting", "reloading", "succeeded", "failed"]),
    continuations: z.array(
      z.strictObject({
        agentId: nonemptyString,
        sessionKey: nonemptyString,
        sessionId: nonemptyString,
        lifecycleRevision: z.string().optional(),
        sourceRunId: nonemptyString,
        sourceInputKeys: z.array(nonemptyString).optional(),
        recoverySource,
        queuedInputIds: z.array(nonemptyString),
        state: z.enum(["pending", "cancelled", "accepted", "complete", "failed"]),
        error: z.string().optional(),
      }),
    ),
    result: z.json().optional(),
    error: z.string().optional(),
  })
  .refine((operation) => operation.updatedAtMs >= operation.createdAtMs, {
    message: "Plugin reload operation update precedes creation",
  });

/** Validate both incoming writes and durable values at the persistence boundary. */
export function parsePluginReloadOperation(value: unknown): PluginReloadOperation {
  return operationSchema.parse(value);
}

export function isTerminalPluginReloadOperation(operation: PluginReloadOperation): boolean {
  return (
    (operation.state === "succeeded" || operation.state === "failed") &&
    operation.continuations.every(
      (continuation) => continuation.state !== "pending" && continuation.state !== "accepted",
    )
  );
}
