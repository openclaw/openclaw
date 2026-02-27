import type { ProcessSupervisor } from "./types.js";
import { createProcessSupervisor } from "./supervisor.js";

let singleton: ProcessSupervisor | null = null;

export function getProcessSupervisor(): ProcessSupervisor {
  if (singleton) {
    return singleton;
  }
  singleton = createProcessSupervisor();
  return singleton;
}

export { createProcessSupervisor } from "./supervisor.js";
export type {
  ManagedRun,
  ProcessSupervisor,
  RunExit,
  RunRecord,
  RunState,
  SpawnInput,
  SpawnMode,
  TerminationReason,
} from "./types.js";
