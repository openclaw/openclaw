import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { captureRuntimeWorkerSource } from "./runtime-worker-generation.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import type { ManagedUpdateLeaseDatabaseIdentity } from "./update-managed-service-handoff-identity.js";
import type { ManagedHandoffLeaseStoreOptions } from "./update-managed-service-handoff-lease-types.js";
import type { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";
import { decodeNativeWorkerFailure, type NativeWorkerFailure } from "./worker-native-error.js";
import { createOwnedWorkerTaskPool } from "./worker-task-pool.js";

type Store = ReturnType<typeof createManagedHandoffLeaseStore>;
type Method =
  | "read"
  | "release"
  | "stopNative"
  | "processIdentity"
  | "isProcessIdentityCurrent"
  | "inspectProcessIdentity";
type ParentStoreOptions = Omit<ManagedHandoffLeaseStoreOptions, "databasePath"> & {
  databasePath?: string;
  installRoot: string;
};
export type HandoffWorkerCommand =
  | { kind: "prepare"; options: Omit<ParentStoreOptions, "onProcessIdentityWarning"> }
  | { kind: "assertCurrent" }
  | { kind: "stageRuntime"; directory: string }
  | { [K in Method]: { kind: K; args: Parameters<Store[K]> } }[Method];
export type HandoffWorkerResult =
  | { kind: "prepare"; value: ManagedUpdateLeaseDatabaseIdentity }
  | { kind: "assertCurrent" }
  | { kind: "stageRuntime"; value: string[] }
  | { [K in Method]: { kind: K; value: ReturnType<Store[K]> } }[Method];
export type HandoffWorkerReply = {
  warnings: Array<{ pid: number; message: string }>;
} & ({ result: HandoffWorkerResult } | { failure: NativeWorkerFailure });

/** The serving parent keeps lifecycle decisions; its existing lease store runs off-thread. */
export async function prepareManagedHandoffParentStore(options: ParentStoreOptions) {
  const source = captureRuntimeWorkerSource(
    resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.managedHandoffEngine),
  );
  const pool = createOwnedWorkerTaskPool<HandoffWorkerCommand, HandoffWorkerReply>({
    workerUrl: source.moduleUrl,
    maxWorkers: 1,
    idleTimeoutMs: 0,
    restartOnError: false,
  });
  const close = () => pool.close();
  source.runtimeGeneration?.retain(pool, async () => close);
  const run = async (command: HandoffWorkerCommand) => {
    const task = pool.runTask(command, {});
    let reply: HandoffWorkerReply;
    try {
      reply = await task.result;
    } finally {
      await task.close();
    }
    for (const warning of reply.warnings) {
      try {
        options.onProcessIdentityWarning?.(warning.pid, warning.message);
      } catch {
        // Diagnostics never revoke an attributed update process.
      }
    }
    if ("failure" in reply) {
      throw decodeNativeWorkerFailure(reply.failure);
    }
    return reply.result;
  };
  try {
    const { onProcessIdentityWarning: _, ...input } = options;
    const prepared = await run({ kind: "prepare", options: input });
    if (prepared.kind !== "prepare") {
      throw new Error("Invalid handoff preparation reply");
    }
    return {
      databaseIdentity: prepared.value,
      close,
      async stageRuntime(directory: string) {
        const reply = await run({ kind: "stageRuntime", directory });
        if (reply.kind !== "stageRuntime") {
          throw new Error("Invalid handoff runtime staging reply");
        }
        return reply.value;
      },
      async assertCurrent() {
        const reply = await run({ kind: "assertCurrent" });
        if (reply.kind !== "assertCurrent") {
          throw new Error("Invalid handoff identity reply");
        }
      },
      async read(...args: Parameters<Store["read"]>) {
        const reply = await run({ kind: "read", args });
        if (reply.kind !== "read") {
          throw new Error("Invalid handoff read reply");
        }
        return reply.value;
      },
      async release(...args: Parameters<Store["release"]>) {
        const reply = await run({ kind: "release", args });
        if (reply.kind !== "release") {
          throw new Error("Invalid handoff release reply");
        }
        return reply.value;
      },
      async stopNative(...args: Parameters<Store["stopNative"]>) {
        const reply = await run({ kind: "stopNative", args });
        if (reply.kind !== "stopNative") {
          throw new Error("Invalid handoff stop reply");
        }
        return reply.value;
      },
      async processIdentity(...args: Parameters<Store["processIdentity"]>) {
        const reply = await run({ kind: "processIdentity", args });
        if (reply.kind !== "processIdentity") {
          throw new Error("Invalid handoff process identity reply");
        }
        return reply.value;
      },
      async isProcessIdentityCurrent(...args: Parameters<Store["isProcessIdentityCurrent"]>) {
        const reply = await run({ kind: "isProcessIdentityCurrent", args });
        if (reply.kind !== "isProcessIdentityCurrent") {
          throw new Error("Invalid handoff identity check reply");
        }
        return reply.value;
      },
      async inspectProcessIdentity(...args: Parameters<Store["inspectProcessIdentity"]>) {
        const reply = await run({ kind: "inspectProcessIdentity", args });
        if (reply.kind !== "inspectProcessIdentity") {
          throw new Error("Invalid handoff identity inspection reply");
        }
        return reply.value;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export type ManagedHandoffParentStore = Awaited<
  ReturnType<typeof prepareManagedHandoffParentStore>
>;
