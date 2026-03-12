import type { ResolvedBrowserProfile } from "./config.js";

export type BrowserProfileMode = "local-managed" | "local-extension-relay" | "remote-cdp";

export type BrowserProfileCapabilities = {
  mode: BrowserProfileMode;
  isRemote: boolean;
  requiresRelay: boolean;
  requiresAttachedTab: boolean;
  usesPersistentPlaywright: boolean;
  supportsPerTabWs: boolean;
  supportsJsonTabEndpoints: boolean;
  supportsReset: boolean;
  supportsManagedTabLimit: boolean;
};

export function getBrowserProfileCapabilities(
  profile: ResolvedBrowserProfile,
): BrowserProfileCapabilities {
  if (profile.driver === "extension") {
    return {
      mode: "local-extension-relay",
      isRemote: false,
      requiresRelay: true,
      requiresAttachedTab: true,
      usesPersistentPlaywright: false,
      supportsPerTabWs: false,
      supportsJsonTabEndpoints: true,
      supportsReset: true,
      supportsManagedTabLimit: false,
    };
  }

  if (!profile.cdpIsLoopback) {
    return {
      mode: "remote-cdp",
      isRemote: true,
      requiresRelay: false,
      requiresAttachedTab: false,
      usesPersistentPlaywright: true,
      supportsPerTabWs: false,
      supportsJsonTabEndpoints: false,
      supportsReset: false,
      supportsManagedTabLimit: false,
    };
  }

  return {
    mode: "local-managed",
    isRemote: false,
    requiresRelay: false,
    requiresAttachedTab: false,
    usesPersistentPlaywright: false,
    supportsPerTabWs: true,
    supportsJsonTabEndpoints: true,
    supportsReset: true,
    supportsManagedTabLimit: true,
  };
}

export function resolveDefaultSnapshotFormat(params: {
  profile: ResolvedBrowserProfile;
  hasPlaywright: boolean;
  explicitFormat?: "ai" | "aria";
  mode?: "efficient";
}): "ai" | "aria" {
  if (params.explicitFormat) {
    return params.explicitFormat;
  }
  if (params.mode === "efficient") {
    return "ai";
  }

  const capabilities = getBrowserProfileCapabilities(params.profile);
  if (capabilities.mode === "local-extension-relay") {
    return "aria";
  }

  return params.hasPlaywright ? "ai" : "aria";
}

export function shouldUsePlaywrightForScreenshot(params: {
  profile: ResolvedBrowserProfile;
  wsUrl?: string;
  ref?: string;
  element?: string;
}): boolean {
  const capabilities = getBrowserProfileCapabilities(params.profile);
  return (
    capabilities.requiresRelay || !params.wsUrl || Boolean(params.ref) || Boolean(params.element)
  );
}

export function shouldUsePlaywrightForAriaSnapshot(params: {
  profile: ResolvedBrowserProfile;
  wsUrl?: string;
}): boolean {
  const capabilities = getBrowserProfileCapabilities(params.profile);
  return capabilities.requiresRelay || !params.wsUrl;
}
