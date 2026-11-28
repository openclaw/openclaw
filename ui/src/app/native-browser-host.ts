type NativeBrowserHostWindow = Window & {
  __OPENCLAW_NATIVE_BROWSER_CUTOUTS__?: boolean;
  webkit?: { messageHandlers?: { openclawBrowser?: { postMessage?: unknown } } };
};

function nativeBrowserHost(): NativeBrowserHostWindow | undefined {
  const host: NativeBrowserHostWindow | undefined =
    typeof window === "undefined" ? undefined : window;
  return typeof host?.webkit?.messageHandlers?.openclawBrowser?.postMessage === "function"
    ? host
    : undefined;
}

export function hasNativeBrowserBridge(): boolean {
  return nativeBrowserHost() !== undefined;
}

export function supportsNativeBrowserCutouts(): boolean {
  return nativeBrowserHost()?.["__OPENCLAW_NATIVE_BROWSER_CUTOUTS__"] === true;
}
