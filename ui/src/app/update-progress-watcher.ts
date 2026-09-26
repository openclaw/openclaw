import type { UpdateProgress, UpdateProgressSources } from "./update-confirmation.ts";

export function createUpdateProgressWatcher(
  context: UpdateProgressSources,
): (listener: (progress: UpdateProgress) => void) => () => void {
  return (listener) => {
    const emit = () => {
      const update = context.overlays.snapshot;
      const banner = update.updateStatusBanner;
      listener({
        externalSupervisorGuidance: update.externalSupervisorGuidance,
        run: update.updateRun,
        busy: update.updateRunning || update.updateReconciliationPending,
        connected: context.gateway.snapshot.phase === "connected",
        failure: banner && banner.tone !== "info" && banner.source !== "read" ? banner.text : null,
        readError:
          update.updateStatusCheckBanner?.text ?? (banner?.source === "read" ? banner.text : null),
      });
    };
    const stopOverlays = context.overlays.subscribe(emit);
    const stopGateway = context.gateway.subscribe(emit);
    emit();
    return () => {
      stopOverlays();
      stopGateway();
    };
  };
}
