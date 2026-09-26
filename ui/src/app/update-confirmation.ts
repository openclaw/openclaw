// Canonical confirmation gate for the Control UI's disruptive update action.
// Every affordance that can start an update routes its first click here, so no
// surface dispatches an unconfirmed update or drifts from the shared policy.
// The dialog itself loads lazily: startup pays nothing for a confirmation the
// operator has not opened.
import type { UpdateRunRecord } from "../../../src/infra/update-run-record.ts";
import type {
  ExternalSupervisorGuidance,
  UpdateAvailable,
  UpdateScheduleState,
} from "../api/types.ts";

/** The live server-owned run and request state shown by the update dialog. */
export type UpdateProgress = {
  externalSupervisorGuidance?: ExternalSupervisorGuidance | null;
  run: UpdateRunRecord | null;
  /** The install is accepted and unfinished, across the restart. */
  busy: boolean;
  connected: boolean;
  /** Set once the update produced a definitive failure. */
  failure: string | null;
  /** Reading fresh progress failed; the retained run remains authoritative. */
  readError?: string | null;
};

// Keep the lazy confirmation entry independent of the application context.
export type UpdateProgressSources = {
  gateway: {
    snapshot: { phase: string };
    subscribe: (listener: () => void) => () => void;
  };
  overlays: {
    snapshot: {
      externalSupervisorGuidance?: ExternalSupervisorGuidance | null;
      updateRun: UpdateRunRecord | null;
      updateRunning: boolean;
      updateReconciliationPending: boolean;
      updateStatusBanner: { tone: string; text: string; source?: "read" } | null;
      updateStatusCheckBanner: { text: string } | null;
    };
    subscribe: (listener: () => void) => () => void;
  };
};

/** The dialog supplies its watcher factory after loading the update runtime. */
export type UpdateProgressWatcher = (
  listener: (progress: UpdateProgress) => void,
  createWatcher: (
    context: UpdateProgressSources,
  ) => (listener: (progress: UpdateProgress) => void) => () => void,
) => () => void;

export type ConfirmAndStartUpdateParams = {
  updateAvailable: UpdateAvailable | null;
  updateSchedule: UpdateScheduleState | null;
  existingRun?: UpdateRunRecord;
  onCheckStatus?: () => Promise<boolean>;
  onReviewUpdate?: () => void;
  onAcknowledge?: () => void;
  /**
   * True only where the surface can hand a confirmed update to the macOS app
   * and recover from its decline event. Surfaces without that listener stay on
   * the Gateway route so a declined handoff cannot end in silence.
   */
  viaNativeApp: boolean;
  startGatewayUpdate: () => void;
  /**
   * Streams the update lifecycle so the dialog can stay open and report it.
   * A surface that cannot supply one closes on confirm instead of holding a
   * dialog it can never update; the ambient surfaces narrate from there.
   */
  watchUpdateProgress?: UpdateProgressWatcher;
};

export async function confirmAndStartUpdate(params: ConfirmAndStartUpdateParams): Promise<void> {
  const { confirmAndStartUpdateRuntime } = await import("./update-confirmation.runtime.ts");
  await confirmAndStartUpdateRuntime(params);
}
