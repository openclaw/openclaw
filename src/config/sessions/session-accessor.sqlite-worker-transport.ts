import type { MessagePort, Worker } from "node:worker_threads";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";

export type SqliteMutationWorkerTransport =
  | { kind: "dedicated"; channel: Worker }
  | {
      kind: "pooled";
      channel: MessagePort;
      threadId: number;
      initialOperationId: number;
      completion: Promise<void>;
      custodyReleased: () => boolean;
      terminate: () => Promise<void>;
    };

export type SqliteMutationWorkerEnd =
  | { kind: "native-exit"; code: number }
  | { kind: "task-complete" }
  | { kind: "task-failed"; error: Error; custodyReleased: boolean };

export function sqliteMutationWorkerThreadId(transport: SqliteMutationWorkerTransport): number {
  return transport.kind === "dedicated" ? transport.channel.threadId : transport.threadId;
}

export async function terminateSqliteMutationWorker(
  transport: SqliteMutationWorkerTransport,
): Promise<void> {
  if (transport.kind === "dedicated") {
    await transport.channel.terminate();
  } else {
    await transport.terminate();
  }
}

/** Task completion proves closed resources; only the dedicated path reports native exit. */
export function observeSqliteMutationWorkerEnd(
  transport: SqliteMutationWorkerTransport,
  observe: (ending: SqliteMutationWorkerEnd) => void,
): () => void {
  if (transport.kind === "dedicated") {
    const exited = (code: number) => observe({ kind: "native-exit", code });
    transport.channel.once("exit", exited);
    return () => transport.channel.off("exit", exited);
  }
  let active = true;
  void transport.completion.then(
    () => active && observe({ kind: "task-complete" }),
    (error: unknown) =>
      active &&
      observe({
        kind: "task-failed",
        error: toStringifiedError(error),
        custodyReleased: transport.custodyReleased(),
      }),
  );
  return () => {
    active = false;
  };
}
