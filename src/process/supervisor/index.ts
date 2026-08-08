// Process supervisor barrel exposes the supervised process API.
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { createProcessSupervisor } from "./supervisor.js";
import type { ProcessSupervisor } from "./types.js";

const PROCESS_SUPERVISOR_HOLDER_KEY = Symbol.for("openclaw.processSupervisorHolder");
const holder = resolveGlobalSingleton(
  PROCESS_SUPERVISOR_HOLDER_KEY,
  (): { current: ReturnType<typeof createProcessSupervisor> | null } => ({ current: null }),
  async (value) => {
    const supervisor = value.current;
    if (!supervisor) {
      return;
    }
    await supervisor.shutdown();
    // Keep the shutdown fence published until lifecycle teardown completes;
    // only the next gateway lifecycle may create a fresh process owner.
    if (value.current === supervisor) {
      value.current = null;
    }
  },
);

/** Return the process-wide supervisor used by runtime code that does not inject one. */
export function getProcessSupervisor(): ProcessSupervisor {
  if (holder.current) {
    return holder.current;
  }
  holder.current = createProcessSupervisor();
  return holder.current;
}

/** Fence and drain the process-wide supervisor for gateway lifecycle teardown. */
export async function shutdownProcessSupervisor(): Promise<void> {
  // Do not clear the holder here: late close work must see the fenced instance.
  holder.current ??= createProcessSupervisor();
  await holder.current.shutdown();
}

export type { ManagedRun, ProcessSupervisor } from "./types.js";
