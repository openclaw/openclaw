import { validateCellContainerProfile, type CellContainerProfile } from "./cell-profile.js";
import { requireFleetImageId } from "./container-image.runtime.js";
import type { FleetContainerRuntime } from "./containers.runtime.js";

// Admission precedes any replacement of a cell or its mounted state. Recovery
// replays the inspected generation, whose old command need not support new flags.
export async function prepareFleetLaunchProfile(
  containers: FleetContainerRuntime,
  profile: CellContainerProfile,
  options: { pull?: boolean } = {},
): Promise<CellContainerProfile> {
  validateCellContainerProfile(profile);
  if (profile.command !== undefined) {
    requireFleetImageId(profile.image);
    return profile;
  }
  if (options.pull) {
    await containers.pull(profile.runtime, profile.image);
  }
  return {
    ...profile,
    image: await containers.prepareGatewayImage(profile.runtime, profile.image),
  };
}
