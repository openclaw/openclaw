import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { expect, it, vi, type Mock } from "vitest";
import { createTestConfigSnapshot } from "../../commands/test-runtime-config-helpers.js";
import type {
  ConfigFileSnapshot,
  ConfigValidationIssue,
  OpenClawConfig,
} from "../../config/types.js";
import type { GatewayServerOptions } from "../../gateway/server-public.js";
import { OpenClawStateOwnershipMetadataError } from "../../infra/sqlite-lifecycle-errors.js";
import { withEnvAsync } from "../../test-utils/env.js";
import type { GatewayLoopParams } from "./run-cleanup-receipt.test-support.js";

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

export function registerGatewayRunConfigGuardTests({
  configState,
  runGatewayLoop,
  runUnconfigured,
  startGatewayServer,
}: {
  configState: { snapshot: Record<string, unknown> };
  runGatewayLoop: Mock<(params: GatewayLoopParams) => Promise<void>>;
  runUnconfigured: (...args: string[]) => Promise<void>;
  startGatewayServer: { mock: { calls: [number, unknown?][] } };
}) {
  it.each([19772, undefined])("refreshes the configured restart port (%s)", async (nextPort) => {
    await withEnvAsync(
      { OPENCLAW_GATEWAY_PORT: undefined, OPENCLAW_PROFILE: undefined },
      async () => {
        configState.snapshot = completeGatewayRunSnapshot({
          gateway: { mode: "local", port: 19771 },
        });
        runGatewayLoop.mockImplementationOnce(async (params: GatewayLoopParams) => {
          await params.start();
          process.env.OPENCLAW_GATEWAY_PORT = "19771";
          configState.snapshot = completeGatewayRunSnapshot({
            gateway: { mode: "local", port: nextPort },
          });
          await params.resolveRestartPort?.();
          await params.start();
        });

        await runUnconfigured();

        expect(startGatewayServer.mock.calls.map(([port]) => port)).toEqual([
          19771,
          nextPort ?? 18789,
        ]);
        expect(
          (startGatewayServer.mock.calls[1]?.[1] as GatewayServerOptions | undefined)
            ?.startupConfigSnapshotRead?.snapshot.config,
        ).toEqual(configState.snapshot.config);
      },
    );
  });

  it("releases the selected config snapshot after startup hands off to the final config", async () => {
    const {
      selectGatewayRunEnvironment,
      prepareGatewayRunBootstrap,
      recheckGatewayRunBootstrap,
      applyFinalGatewayRunConfigEnv,
    } = await import("./pre-bootstrap.js");
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const params = { opts: {}, runtime };
    configState.snapshot = completeGatewayRunSnapshot({ gateway: { mode: "local" } });
    const selected = new WeakRef(configState.snapshot);
    expect(await selectGatewayRunEnvironment(params)).toBe(true);
    expect(await prepareGatewayRunBootstrap(params)).toBe(true);

    const finalSnapshot = completeGatewayRunSnapshot({ gateway: { mode: "local" } });
    configState.snapshot = finalSnapshot;
    expect(await recheckGatewayRunBootstrap({ ...params, snapshot: finalSnapshot })).toBe(true);
    expect(await applyFinalGatewayRunConfigEnv({ runtime, snapshot: finalSnapshot })).toBe(true);

    await nextTurn();
    queryObjects(WeakRef);
    expect(selected.deref()).toBeUndefined();
  });

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
