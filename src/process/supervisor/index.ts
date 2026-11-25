import { PluginRuntimeCloseRetainedError } from "../../plugins/runtime-close-error.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { createProcessSupervisor } from "./supervisor.js";
import type { ProcessSupervisor } from "./types.js";

const holder = resolveGlobalSingleton(
  Symbol.for("openclaw.processSupervisorHolder"),
  (): { current: ReturnType<typeof createProcessSupervisor> | null } => ({ current: null }),
  async (value) => {
    const supervisor = value.current;
    await supervisor?.shutdown();
    if (value.current === supervisor) {
      value.current = null;
    }
  },
);

/** Return the process-wide supervisor used by runtime code that does not inject one. */
export function getProcessSupervisor(): ProcessSupervisor {
  return (holder.current ??= createProcessSupervisor());
}

/** Process shutdown owns idle background commands even when another runtime stays retained. */
export async function shutdownProcessSupervisor(): Promise<void> {
  try {
    await holder.current?.shutdown();
  } catch (error) {
    // Failed extinction fences runtime reuse, but does not fail an external stop.
    throw new PluginRuntimeCloseRetainedError(error);
  }
}

export type { ManagedRun, ProcessSupervisor } from "./types.js";
