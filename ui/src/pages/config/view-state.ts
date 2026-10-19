import { pathKey } from "../../components/config-form.shared.ts";
import type { ConfigProps, ConfigViewState } from "./view-types.ts";

export function createMediaDeviceState(): Omit<
  NonNullable<ConfigProps["microphone"]>,
  "selectedDeviceId"
> & {
  loaded: boolean;
  requestsPermission: boolean;
} {
  return {
    devices: [],
    permissionRequired: true,
    loading: false,
    error: null,
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

export function configContextKey(props: ConfigProps): string {
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
