type NativeBrowserHostWindow = Window & {
  __OPENCLAW_NATIVE_BROWSER_CUTOUTS__?: boolean;
  webkit?: { messageHandlers?: { openclawBrowser?: { postMessage?: unknown } } };
};

export function hasNativeBrowserBridge(): boolean {
  const host: NativeBrowserHostWindow | undefined =
    typeof window === "undefined" ? undefined : window;
  return typeof host?.webkit?.messageHandlers?.openclawBrowser?.postMessage === "function";
}

export function supportsNativeBrowserCutouts(): boolean {
  return (
    hasNativeBrowserBridge() &&
    (window as NativeBrowserHostWindow)["__OPENCLAW_NATIVE_BROWSER_CUTOUTS__"] === true
  );
}
