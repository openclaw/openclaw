import type { MessagePort, Worker } from "node:worker_threads";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";

export type WorkerCleanup = { cleanupWarnings: string[]; settled: boolean };

export type SqliteMutationWorkerTransport =
  | { kind: "dedicated"; channel: Worker }
  | {
      kind: "pooled";
      channel: MessagePort;
      threadId: number;
      initialOperationId: number;
      completion: Promise<WorkerCleanup>;
      terminate: () => Promise<void>;
    };

export type SqliteMutationWorkerEnd =
  | { kind: "native-exit"; code: number }
  | { kind: "task-complete"; cleanup: WorkerCleanup }
  | { kind: "task-failed"; error: Error };

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
    (cleanup) => active && observe({ kind: "task-complete", cleanup }),
    (error: unknown) =>
      active &&
      observe({
        kind: "task-failed",
        error: toStringifiedError(error),
      }),
  );
  return () => {
    active = false;
  };
}
