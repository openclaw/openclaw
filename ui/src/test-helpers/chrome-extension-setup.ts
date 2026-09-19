import type { NativeChromeExtensionSetupResult } from "../app/native-chrome-setup.ts";

export function createChromeExtensionSetupResult(
  overrides: Partial<NativeChromeExtensionSetupResult> = {},
): NativeChromeExtensionSetupResult {
  return {
    action: "inspect",
    target: {
      kind: "local-host",
      platform: "darwin",
      hostname: "Example Mac",
      profile: "chrome",
      relayPort: 18792,
    },
    phase: "inspection_required",
    reason: "native_host_missing",
    installation: {
      nativeHostRegistered: false,
      installRequested: false,
      discoveredProfiles: 0,
      awaitingApproval: false,
      automaticBootstrapSupported: true,
    },
    connection: { state: "not_checked" },
    nextAction: "install",
    ...overrides,
  };
}
