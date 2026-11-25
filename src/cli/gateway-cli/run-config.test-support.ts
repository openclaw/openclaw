import { expect, it, vi } from "vitest";
import { createTestConfigSnapshot } from "../../commands/test-runtime-config-helpers.js";
import type {
  ConfigFileSnapshot,
  ConfigValidationIssue,
  OpenClawConfig,
} from "../../config/types.js";
import { OpenClawStateOwnershipMetadataError } from "../../infra/sqlite-lifecycle-errors.js";
import { withEnvAsync } from "../../test-utils/env.js";

export type RuntimeDotEnvLoadResult = {
  dotenvPresentKeys: string[];
  gatewayEnvAppliedKeys: string[];
  stateEnvAppliedKeys: string[];
};

export function failedGatewayRunConfigSnapshot(
  issues: ConfigValidationIssue[] = [{ path: "<root>", message: "JSON5 parse failed" }],
) {
  return {
    exists: true,
    valid: false,
    path: "/tmp/openclaw-test-missing-config.json",
    config: {},
    sourceConfig: {},
    parsed: null,
    issues,
    legacyIssues: [],
  };
}

type ReadFailureFixture = { label: string; expected: object; exact?: boolean } & (
  | { stage: "read"; failure: Error }
  | { stage: "runtime"; failure: Error }
  | { stage: "snapshot"; snapshot: ReturnType<typeof failedGatewayRunConfigSnapshot> }
);

export function gatewayRunReadFailures(): ReadFailureFixture[] {
  const unavailable = Object.assign(new Error("configuration storage unavailable"), {
    code: "ENOSPC",
  });
  return [
    {
      label: "rejected final read",
      stage: "read",
      failure: unavailable,
      expected: unavailable,
      exact: true,
    },
    {
      label: "unavailable final snapshot",
      stage: "snapshot",
      snapshot: failedGatewayRunConfigSnapshot([
        { path: "", errorCode: "CONFIG_READ_FAILED", message: "read failed: ENOSPC" },
      ]),
      expected: { code: "CONFIG_READ_FAILED" },
    },
    {
      label: "restart ownership refusal",
      failure: new OpenClawStateOwnershipMetadataError("/synthetic/state.sqlite", "invalid"),
      stage: "runtime",
      expected: { message: "__exit__:78" },
    },
  ];
}
export function completeGatewayRunSnapshot(
  config: OpenClawConfig,
  overrides: Partial<ConfigFileSnapshot> = {},
) {
  return {
    ...createTestConfigSnapshot(config),
    parsed: config,
    raw: JSON.stringify(config),
    ...overrides,
  } satisfies ConfigFileSnapshot;
}

export function registerInvalidConfigResetTests(configState: {
  snapshot: Record<string, unknown>;
}) {
  it.each([null, "raw", "path"] as const)("guards invalid-config dev reset: %s", async (change) => {
    const { clearGatewayRunConfigEnvironment, prepareGatewayRunBootstrap, recheckGatewayRunReset } =
      await import("./pre-bootstrap.js");
    const env = { OPENCLAW_SERVICE_MARKER: undefined, OPENCLAW_PROFILE: "dev" };
    await withEnvAsync(env, async () => {
      clearGatewayRunConfigEnvironment();
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const params = { opts: { dev: true, reset: true, allowUnconfigured: true }, runtime };
      const snapshot: Record<string, unknown> = {
        ...failedGatewayRunConfigSnapshot(),
        raw: "{ invalid config",
      };
      delete snapshot.sourceConfig;
      configState.snapshot = snapshot;
      try {
        await expect(prepareGatewayRunBootstrap(params)).resolves.toBe(false);
        configState.snapshot = {
          ...snapshot,
          ...(change === "raw" ? { raw: "{ a different invalid config" } : {}),
          ...(change === "path" ? { path: "/tmp/other.json" } : {}),
        };
        await expect(recheckGatewayRunReset(params)).resolves.toBe(change === null);
        if (change) {
          expect(runtime.exit).toHaveBeenCalledWith(1);
          expect(runtime.error).toHaveBeenCalledWith(
            expect.stringContaining("selected config or state target changed during startup"),
          );
        } else {
          expect(runtime.error).not.toHaveBeenCalled();
          expect(runtime.exit).not.toHaveBeenCalled();
        }
      } finally {
        clearGatewayRunConfigEnvironment();
      }
    });
  });
}
