import type { RuntimeConfigCapability } from "../lib/config/runtime-config-capability.ts";
import type { ApplicationOverlays } from "./overlays-types.ts";

/** App-lifetime wiring keeps page teardown from stranding the updater's write interlock. */
export function bindUpdateConfigWriteInterlock(
  overlays: Pick<ApplicationOverlays, "snapshot" | "subscribe" | "refreshUpdateStatus">,
  runtimeConfig: Pick<RuntimeConfigCapability, "setWritesSuspended">,
): () => void {
  const refreshAdmission = () => overlays.refreshUpdateStatus("completion");
  const sync = () => {
    const update = overlays.snapshot;
    runtimeConfig.setWritesSuspended(
      update.updateRunning || update.updateReconciliationPending,
      refreshAdmission,
    );
  };
  const stop = overlays.subscribe(sync);
  sync();
  return stop;
}
