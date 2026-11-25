import { pathKey } from "../../components/config-form.shared.ts";
import type { RealtimeTalkInputDevice } from "../chat/talk/input.ts";

export type SettingsMediaDeviceState = {
  devices: RealtimeTalkInputDevice[];
  permissionRequired: boolean;
  selectedDeviceId: string;
  discovery: Promise<string | null> | null;
  selection: Promise<void> | null;
};

export type ConfigFormMode = "form" | "raw";

export type ConfigDiffPath = string[];
export type ConfigDiffEntry = { path: ConfigDiffPath; from: unknown; to: unknown };
export type ConfigViewState = {
  rawRevealed: boolean;
  rawDiffOpen: boolean;
  envRevealed: boolean;
  validityDismissed: boolean;
  revealedSensitivePaths: Set<string>;
  rawDiffCache?: {
    original: string;
    current: string;
    diff: ConfigDiffEntry[];
  };
  lastConfigContextKey: string | null;
  lastFormModeForScroll: ConfigFormMode | null;
};

export function createMediaDeviceState(): Omit<SettingsMediaDeviceState, "selectedDeviceId"> & {
  loaded: boolean;
  requestsPermission: boolean;
  activeDiscovery: Promise<string | null> | null;
} {
  return {
    devices: [],
    permissionRequired: true,
    discovery: null,
    activeDiscovery: null,
    selection: null,
    loaded: false,
    requestsPermission: false,
  };
}

export function createConfigViewState(): ConfigViewState {
  return {
    rawRevealed: false,
    rawDiffOpen: false,
    envRevealed: false,
    validityDismissed: false,
    revealedSensitivePaths: new Set(),
    lastConfigContextKey: null,
    lastFormModeForScroll: null,
  };
}

export function resetConfigEphemeralState(viewState: ConfigViewState) {
  viewState.rawRevealed = false;
  viewState.rawDiffOpen = false;
  viewState.envRevealed = false;
  viewState.validityDismissed = false;
  viewState.revealedSensitivePaths.clear();
  viewState.rawDiffCache = undefined;
}

export function configContextKey(props: {
  configPath?: string | null;
  gatewayUrl: string;
  navRootLabel?: string;
  includeSections?: readonly string[];
  excludeSections?: readonly string[];
}): string {
  const include = props.includeSections?.join("\u001f") ?? "";
  const exclude = props.excludeSections?.join("\u001f") ?? "";
  return [
    props.configPath ?? "",
    props.gatewayUrl,
    props.navRootLabel ?? "",
    include,
    exclude,
  ].join("\u001e");
}

export function isSensitivePathRevealed(
  viewState: ConfigViewState,
  path: Array<string | number>,
): boolean {
  const key = pathKey(path);
  return key ? viewState.revealedSensitivePaths.has(key) : false;
}

export function toggleSensitivePathReveal(
  viewState: ConfigViewState,
  path: Array<string | number>,
) {
  const key = pathKey(path);
  if (!key) {
    return;
  }
  if (viewState.revealedSensitivePaths.has(key)) {
    viewState.revealedSensitivePaths.delete(key);
  } else {
    viewState.revealedSensitivePaths.add(key);
  }
}
