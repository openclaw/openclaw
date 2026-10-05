import { z } from "zod";

export const NODE_INVOKE_PROGRESS_DIAGNOSTIC_EVENT = "node.invoke.progress.diagnostic";
export const NODE_INVOKE_PROGRESS_DIAGNOSTIC_INTERVAL_MS = 5_000;
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const nodeInvokeProgressDiagnosticSchema = z
  .object({
    invokeId: z.string().min(1).max(128),
    stage: z.enum(["sample", "request_failed", "stopped", "settled"]),
    category: z.enum(["desktop_stream", "agent_cli", "registered_command"]),
    disposition: z.enum([
      "active",
      "stopped",
      "handler_returned",
      "handler_error",
      "owner_aborted",
    ]),
    atMs: counter,
    nextSeq: counter,
    lastSentSeq: counter.nullable(),
    lastCompletedSeq: counter.nullable(),
    pendingSeq: counter.nullable(),
    progressRequestId: z.string().min(1).max(128).nullable(),
    sourceWrites: counter,
    lastSourceAtMs: counter.nullable(),
    lastSentAtMs: counter.nullable(),
    lastCompletedAtMs: counter.nullable(),
    requestFailed: z.boolean(),
  })
  .strict();
export type NodeInvokeProgressDiagnostic = z.infer<typeof nodeInvokeProgressDiagnosticSchema>;
export type NodeInvokeProgressDisposition = NodeInvokeProgressDiagnostic["disposition"];
