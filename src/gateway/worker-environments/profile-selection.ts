import type { WorkerExecutionMode } from "../../../packages/gateway-protocol/src/schema/environments.js";
import type { WorkerProfile } from "../../plugins/capability-provider.types.js";

export function readWorkerProfileSelection(snapshot: WorkerProfile): {
  machineClass?: string;
  os?: string;
  executionMode?: WorkerExecutionMode;
} {
  return {
    ...(typeof snapshot.machineClass === "string" ? { machineClass: snapshot.machineClass } : {}),
    ...(typeof snapshot.os === "string" ? { os: snapshot.os } : {}),
    ...(snapshot.executionMode === "worker-turn" || snapshot.executionMode === "remote-exec"
      ? { executionMode: snapshot.executionMode }
      : {}),
  };
}
