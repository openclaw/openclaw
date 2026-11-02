import type { DevicePlacementOption } from "./device-placement.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import type { DraftPlaceBrowser } from "./draft-place-browser.ts";
import type { DraftPlaceCallbacks, DraftPlaceSnapshot } from "./draft-place-contract.ts";
import {
  markDraftPlaceProjectChoice,
  type createDraftPlaceRestoreState,
} from "./draft-place-restore.ts";
import type { DraftRepositoryStateOwner } from "./draft-repository-state.ts";
import type { DraftSuggestedCloudProfile } from "./draft-suggested-cloud-profile.ts";
import type { DraftRestoredFolderValidation } from "./folder-validation.ts";
import { environmentDeviceDisabledReason } from "./hosted-environments.ts";
import type { NewSessionModelControl } from "./model-control.ts";
import { resolveNewSessionWhere } from "./preferences.ts";

type DraftTargetContext = {
  place: {
    requiredPlacement: boolean;
    hostedEnvironment: unknown;
    devices: () => DevicePlacementOption[];
    worktree: boolean;
    folder: string;
    deviceFolderAvailable: boolean;
    suggestedCloudProfile: DraftSuggestedCloudProfile;
  };
  read: () => DraftPlaceSnapshot;
  selection: ReturnType<typeof createDraftPlaceRestoreState>;
  callbacks: DraftPlaceCallbacks;
  folderValidation: DraftRestoredFolderValidation;
  repositoryState: DraftRepositoryStateOwner;
  browser: DraftPlaceBrowser;
  modelControl: NewSessionModelControl;
  persistPreference: (patch: Parameters<DraftGatewayState["persistPreference"]>[2]) => void;
  clearDeviceFolder: () => void;
};

export function selectDraftDeviceFolder(context: DraftTargetContext, select: () => void) {
  const snapshot = context.read();
  if (
    !context.place.deviceFolderAvailable ||
    snapshot.submitting ||
    snapshot.pendingPlacementSessionKey
  ) {
    return;
  }
  select();
  context.selection.freshWorkspace = false;
  context.selection.folderSelectedByUser = true;
  markDraftPlaceProjectChoice(context.selection, true);
  context.browser.resetProjectSearch();
  context.folderValidation.cancel();
  context.browser.clearProjectSelection();
  context.repositoryState.reset();
  context.browser.close();
  context.callbacks.changed();
}

export function selectDraftDevice(
  context: DraftTargetContext,
  deviceId: string,
  autoDevice = false,
) {
  const snapshot = context.read();
  if (
    context.place.requiredPlacement ||
    snapshot.submitting ||
    snapshot.pendingPlacementSessionKey
  ) {
    return;
  }
  if (
    context.place.hostedEnvironment &&
    (deviceId || autoDevice) &&
    environmentDeviceDisabledReason(context.modelControl)
  ) {
    return;
  }
  if (!context.modelControl.selectHostEnvironment()) {
    return;
  }
  if (
    (deviceId &&
      context.place.devices().find((device) => device.deviceId === deviceId)?.selectable !==
        true) ||
    (autoDevice && !context.place.devices().some((device) => device.selectable))
  ) {
    return;
  }
  context.place.suggestedCloudProfile.cancel();
  context.selection.whereSelectedByUser = true;
  context.selection.preferredWhereRestore = null;
  if (
    deviceId === context.selection.deviceId &&
    autoDevice === context.selection.autoDevice &&
    !context.selection.cloudProfileId
  ) {
    context.browser.close();
    context.callbacks.changed();
    return;
  }
  context.folderValidation.cancel();
  context.clearDeviceFolder();
  context.selection.deviceId = deviceId;
  context.selection.autoDevice = autoDevice;
  context.selection.cloudProfileId = "";
  context.persistPreference({
    where: resolveNewSessionWhere({ cloudProfileId: "", deviceId, autoDevice }),
    projectId: context.browser.projectId,
    folder: context.place.folder,
    worktree: Boolean(deviceId || autoDevice) || context.place.worktree,
    freshWorkspace: context.selection.freshWorkspace,
  });
  context.browser.close();
  context.repositoryState.synchronize();
  context.callbacks.changed();
}

export function selectDraftCloudProfile(context: DraftTargetContext, profileId: string) {
  if (
    !context.place.suggestedCloudProfile.canSelect(profileId) ||
    !context.modelControl.selectHostEnvironment()
  ) {
    return;
  }
  context.place.suggestedCloudProfile.cancel();
  context.clearDeviceFolder();
  context.selection.cloudProfileId = profileId;
  context.selection.deviceId = "";
  context.selection.autoDevice = false;
  context.selection.whereSelectedByUser = true;
  context.selection.preferredWhereRestore = null;
  context.callbacks.onError(null);
  context.persistPreference({
    where: { kind: "cloud", id: profileId },
    projectId: context.browser.projectId,
    worktree: true,
    freshWorkspace: context.selection.freshWorkspace,
  });
  context.repositoryState.synchronize();
  context.callbacks.changed();
}

export function selectDraftWorktree(context: DraftTargetContext, value: boolean) {
  if (context.read().submitting || !context.repositoryState.select(value)) {
    return;
  }
  if (value && context.selection.freshWorkspace) {
    context.selection.freshWorkspace = false;
    context.persistPreference({ freshWorkspace: false });
  }
}
