import { existsSync } from "node:fs";
import { readBackupEngine } from "./database-engine/physical-store.js";
import {
  assertManagedUpdateLeaseDatabaseIdentity,
  prepareManagedHandoffLeaseDatabaseIdentity,
} from "./update-managed-service-handoff-database.js";
import type { ManagedUpdateLeaseDatabaseIdentity } from "./update-managed-service-handoff-identity.js";
import {
  prepareManagedHandoffLeaseStore,
  resolveManagedUpdateLeaseDatabasePath,
} from "./update-managed-service-handoff-lease.js";
import {
  assertLegacyGatewayCustodySettled,
  resolveLegacyGatewayManagedUpdateLeaseDatabasePath,
} from "./update-managed-service-handoff-legacy-store.js";
import { stageManagedHandoffRuntime } from "./update-managed-service-handoff-runtime.js";
import type {
  HandoffWorkerCommand,
  HandoffWorkerReply,
  HandoffWorkerResult,
} from "./update-managed-service-handoff-worker.js";
import { encodeNativeWorkerFailure } from "./worker-native-error.js";
import { serveWorkerTasks } from "./worker-task-server.js";

let store: Awaited<ReturnType<typeof prepareManagedHandoffLeaseStore>> | undefined;
let databaseIdentity: ManagedUpdateLeaseDatabaseIdentity | undefined;
let installRoot: string | undefined;
let warnings: HandoffWorkerReply["warnings"] = [];

async function run(command: HandoffWorkerCommand): Promise<HandoffWorkerResult> {
  if (command.kind === "prepare") {
    const databasePath = command.options.databasePath ?? resolveManagedUpdateLeaseDatabasePath();
    const identity =
      command.options.existingIdentity ??
      (await prepareManagedHandoffLeaseDatabaseIdentity(databasePath));
    store = await prepareManagedHandoffLeaseStore({
      ...command.options,
      databasePath: identity.databasePath,
      existingIdentity: identity,
      onProcessIdentityWarning: (pid, message) => warnings.push({ pid, message }),
    });
    databaseIdentity = identity;
    installRoot = command.options.installRoot;
    return { kind: "prepare", value: identity };
  }
  if (!store || !databaseIdentity || !installRoot) {
    throw new Error("Managed handoff lease owner is unavailable");
  }
  switch (command.kind) {
    case "stageRuntime":
      return { kind: command.kind, value: stageManagedHandoffRuntime(command.directory) };
    case "assertCurrent":
      await assertLegacyGatewayCustodySettled(
        installRoot,
        resolveLegacyGatewayManagedUpdateLeaseDatabasePath(databaseIdentity.databasePath),
      );
      assertManagedUpdateLeaseDatabaseIdentity(databaseIdentity);
      return { kind: command.kind };
    case "read":
      return { kind: command.kind, value: store.read(...command.args) };
    case "release":
      return { kind: command.kind, value: store.release(...command.args) };
    case "stopNative":
      return { kind: command.kind, value: store.stopNative(...command.args) };
    case "processIdentity":
      return { kind: command.kind, value: store.processIdentity(...command.args) };
    case "isProcessIdentityCurrent":
      return { kind: command.kind, value: store.isProcessIdentityCurrent(...command.args) };
    default:
      return { kind: command.kind, value: store.inspectProcessIdentity(...command.args) };
  }
}

// Both snapshot inspection and the serving parent's lease metadata belong off-thread.
serveWorkerTasks<
  "sqlite" | "postgres" | undefined | HandoffWorkerReply,
  string | HandoffWorkerCommand
>(async (input) => {
  if (typeof input === "string") {
    return existsSync(input) ? readBackupEngine(input).engine : undefined;
  }
  warnings = [];
  try {
    return { result: await run(input), warnings };
  } catch (error) {
    return { failure: encodeNativeWorkerFailure(error), warnings };
  }
});
