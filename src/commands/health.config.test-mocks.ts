import { vi } from "vitest";

// Shared config.js mock for the health-snapshot test suites. getHealthSnapshot
// reads the runtime-config drift accessors (#89526); tests that don't exercise
// drift install this so the drift summary short-circuits on the undefined
// snapshot instead of throwing on a missing mock export. Drift behavior itself
// is covered directly in health.snapshot.runtime-config.test.ts.
export function installHealthConfigMock(getConfig: () => Record<string, unknown>): void {
  vi.doMock("../config/config.js", () => ({
    getRuntimeConfig: getConfig,
    loadConfig: getConfig,
    getRuntimeConfigSourceSnapshot: () => undefined,
    getRuntimeConfigSnapshotMetadata: () => undefined,
    hashRuntimeConfigValue: (config: Record<string, unknown>) => JSON.stringify(config),
  }));
}
