import type { LaneState } from "../../scripts/lib/cross-os-release-checks/config.ts";

export function makeReleaseLane(rootDir: string, overrides: Partial<LaneState> = {}): LaneState {
  return {
    name: "fresh",
    rootDir,
    prefixDir: rootDir,
    homeDir: rootDir,
    stateDir: rootDir,
    appDataDir: rootDir,
    gatewayPort: 0,
    phaseTimings: [],
    ...overrides,
  };
}
