import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";

export function runtimeFixture(
  version: string,
  sqliteVersion = "3.51.3",
  status: "supported" | "unsupported" = "supported",
) {
  return {
    status,
    version,
    sqliteVersion,
    nodeSharedSqlite: false,
    sqliteProbe: { available: true, version: sqliteVersion, text: true, blob: true, json: true },
  };
}

export function activationFixture(kind: "node" | "bun", path: string, env?: NodeJS.ProcessEnv) {
  return { kind, path, identity: `fixture:${path}`, ...(env ? { env } : {}) };
}

export function verificationFixture(runningVersion: string, runningBuildId?: string) {
  return {
    serviceRunning: true,
    versionMatch: true,
    channelsReady: true,
    readyz: true,
    settled: true,
    pluginErrors: [],
    runningVersion,
    ...(runningBuildId ? { runningBuildId } : {}),
  };
}

export function resultFixture(
  root: string | undefined,
  overrides: Partial<UpdateRunResult> = {},
): UpdateRunResult {
  return {
    status: "ok",
    mode: "npm",
    ...(root === undefined ? {} : { root }),
    durationMs: 0,
    steps: [],
    ...overrides,
  };
}

export function stepFixture(
  name: string,
  overrides: Partial<UpdateStepResult> = {},
): UpdateStepResult {
  return { name, command: "", cwd: "", durationMs: 0, exitCode: 1, ...overrides };
}
