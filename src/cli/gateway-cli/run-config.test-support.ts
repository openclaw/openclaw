import { expect, it, vi } from "vitest";
import * as runtimeSnapshotModule from "../../config/runtime-snapshot.js";
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
  const ownership = new OpenClawStateOwnershipMetadataError("/synthetic/state.sqlite", "invalid");
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
      failure: ownership,
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
    path: "/tmp/openclaw.json",
    exists: true,
    valid: true,
    parsed: config,
    raw: JSON.stringify(config),
    runtimeConfig: config,
    resolved: config,
    sourceConfig: config,
    config,
    issues: [],
    legacyIssues: [],
    warnings: [],
    ...overrides,
  } satisfies ConfigFileSnapshot;
}

export function registerInvalidConfigResetTests(configState: {
  snapshot: Record<string, unknown>;
}) {
  it.each<[string, { sourceConfig?: null | string }, "raw" | "path" | null]>([
    ["absent", {}, null],
    ["null", { sourceConfig: null }, null],
    ["non-object", { sourceConfig: "invalid" }, null],
    ["raw contents", {}, "raw"],
    ["file target", {}, "path"],
  ])("guards invalid-config dev reset: %s", async (_name, source, change) => {
    const { clearGatewayRunConfigEnvironment, prepareGatewayRunBootstrap, recheckGatewayRunReset } =
      await import("./pre-bootstrap.js");
    await withEnvAsync(
      { OPENCLAW_SERVICE_MARKER: undefined, OPENCLAW_PROFILE: "dev" },
      async () => {
        clearGatewayRunConfigEnvironment();
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        const params = { opts: { dev: true, reset: true, allowUnconfigured: true }, runtime };
        const snapshot: Record<string, unknown> = {
          ...completeGatewayRunSnapshot({}),
          raw: "{ invalid config",
          parsed: null,
          valid: false,
          issues: [{ path: "<root>", message: "JSON parse failed" }],
        };
        delete snapshot.sourceConfig;
        Object.assign(snapshot, source);
        configState.snapshot = snapshot;
        const hash = vi.spyOn(runtimeSnapshotModule, "hashRuntimeConfigValue");
        try {
          await expect(prepareGatewayRunBootstrap(params)).resolves.toBe(false);
          hash.mockClear();
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
            expect(hash).not.toHaveBeenCalled();
            expect(runtime.error).not.toHaveBeenCalled();
            expect(runtime.exit).not.toHaveBeenCalled();
          }
        } finally {
          hash.mockRestore();
          clearGatewayRunConfigEnvironment();
        }
      },
    );
  });
}
