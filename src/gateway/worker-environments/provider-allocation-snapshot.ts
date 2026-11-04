import type { WorkerProfile, WorkerProvider } from "../../plugins/types.js";
import type { WorkerProviderIntentPreparationOptions } from "./provider-intent.js";
import { requireWorkerProfile } from "./service-validation.js";

export function allocationSnapshot(
  profile: WorkerProfile,
  {
    machineClass,
    os,
    executionMode,
    sessionGuest,
    resources,
  }: WorkerProviderIntentPreparationOptions,
  provider?: Pick<WorkerProvider, "selectMachineResources">,
): WorkerProfile {
  // A new allocation admits its own project, even when it inherits provider settings.
  const {
    project: _project,
    runtimePreparation: _runtimePreparation,
    sessionGuest: _guest,
    resources: _resources,
    ...snapshot
  } = profile;
  if (machineClass && resources?.machineType) {
    throw new Error("Choose machineClass or resources.machineType, not both");
  }
  const { inference: _inference, executionMode: _executionMode, ...toolOnlySnapshot } = snapshot;
  const selected: WorkerProfile = {
    ...(sessionGuest ? toolOnlySnapshot : snapshot),
    ...(machineClass === undefined ? {} : { machineClass }),
    ...(os === undefined ? {} : { os }),
    ...(executionMode === undefined || sessionGuest ? {} : { executionMode }),
    ...(sessionGuest ? { sessionGuest } : {}),
  };
  if (resources) {
    const select = provider?.selectMachineResources;
    if (!select) {
      throw new Error("This provider does not support per-request machine resource selection");
    }
    return {
      ...selected,
      resources,
      settings: select(requireWorkerProfile(snapshot.settings), resources),
    };
  }
  return selected;
}
