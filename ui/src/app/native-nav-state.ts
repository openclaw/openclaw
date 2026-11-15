import { webKitHostWindow, type WebKitHostMessages } from "./native-webkit-bridge.ts";

export type NativeNavState = Omit<WebKitHostMessages["openclawNav"], "type">;

export function postNativeNavState(state: NativeNavState): void {
  webKitHostWindow()?.webkit?.messageHandlers?.openclawNav?.postMessage({
    type: "nav-state",
    ...state,
  });
}
