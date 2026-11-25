import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestConfigSnapshot } from "../../commands/test-runtime-config-helpers.js";
import { ServiceStartRefusalError } from "../../daemon/service-inspection-error.js";
import type { GatewayServiceState } from "../../daemon/service-types.js";
import { createUpdatePreflightFailure } from "../../infra/update-preflight-details.js";
import * as handoff from "./update-command-handoff.js";
import { prepareUpdateRestart } from "./update-command-restart-context.js";
import type { ManagedGatewayUpdateVerdict } from "./update-command-service-context-types.js";
import { GatewayServiceUpdateOwnershipError } from "./update-command-service-plan.js";

const mocks = vi.hoisted(() => ({
  readState: vi.fn<() => Promise<GatewayServiceState>>(),
  revalidate: vi.fn<() => Promise<ManagedGatewayUpdateVerdict>>(),
}));
const serviceEnv = { OPENCLAW_STATE_DIR: "/managed/state" };
const inspectedService = { inspected: true, runtimeInspected: true, serviceEnv };

vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: () => ({}),
}));
vi.mock("./update-command-service-plan.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-plan.js")>()),
  isGatewayServiceManagementAllowedForUpdate: () => true,
  readGatewayServiceStateForUpdate: mocks.readState,
  resolveGatewayServiceManagementBlockMessageForUpdate: () => undefined,
  resolveUpdatedGatewayRestartPort: () => 18789,
}));
vi.mock("./update-command-service-revalidation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-revalidation.js")>()),
  revalidateManagedGatewayServiceAfterUpdate: mocks.revalidate,
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

function prepare(
  input: Partial<Parameters<typeof prepareUpdateRestart>[0]>,
  snapshot = createTestConfigSnapshot({}, {}, "/managed/state/openclaw.json"),
) {
  return prepareUpdateRestart(
    {
      root: "/installed",
      result: { status: "ok", mode: "npm", steps: [], durationMs: 0 },
      shouldRestart: true,
      updateStepTimeoutMs: 1000,
      assertCurrent: () => {},
      ...input,
    },
    snapshot,
  );
}

describe("prepareUpdateRestart", () => {
  it.each(["outside", "inside", "managed handoff", "invalid config"] as const)(
    "selects native Git activation only outside the owned service with signals disabled: %s",
    async (caller) => {
      vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", caller === "managed handoff" ? "1" : undefined);
      const state: GatewayServiceState = {
        installed: true,
        loadState: { status: "loaded" },
        running: true,
        runtime: { status: "running", pid: 1234 },
        env: serviceEnv,
        command: { programArguments: ["node", "/installed/openclaw-launcher.mjs"] },
      };
      mocks.readState.mockResolvedValue(state);
      mocks.revalidate.mockResolvedValue({
        kind: "owned",
        root: "/installed",
        fingerprint: "unit",
        refreshDefinition: false,
      });
      using membership = vi
        .spyOn(handoff, "gatewayMaintenanceBlock")
        .mockReturnValue(
          caller === "inside" ? createUpdatePreflightFailure("inside-gateway-service") : undefined,
        );
      const snapshot = createTestConfigSnapshot({ commands: { restart: false } });
      const prepared = await prepare(
        { result: { status: "ok", mode: "git", steps: [], durationMs: 0 } },
        { ...snapshot, valid: caller !== "invalid config" },
      );
      expect(prepared.gitReleaseRestartMode).toBe(caller === "outside" ? "native" : "observe");
      if (caller === "outside" || caller === "inside") {
        expect(membership).toHaveBeenCalledWith(state, "/installed");
      }
    },
  );

  it.each(["masked", "masked-runtime-refresh", "ownership", "unknown"] as const)(
    "keeps verified service holds separate from stopped-service ownership failure (%s)",
    async (scenario) => {
      const held = scenario.startsWith("masked");
      const refusal = new ServiceStartRefusalError({
        reason: "masked",
        message: "Run `systemctl --user unmask openclaw-gateway.service`, then retry.",
      });
      mocks.readState.mockRejectedValueOnce(
        held
          ? new GatewayServiceUpdateOwnershipError(refusal.message, refusal)
          : scenario === "ownership"
            ? new GatewayServiceUpdateOwnershipError("Service owner changed", undefined)
            : new Error("Service inspection unavailable"),
      );
      const prepared = prepare({
        preManagedServiceStop: {
          ...inspectedService,
          stopped: true,
          running: true,
        },
        serviceRuntimeRefreshRequired: scenario === "masked-runtime-refresh",
      });
      if (!held) {
        await expect(prepared).rejects.toBeInstanceOf(GatewayServiceUpdateOwnershipError);
        return;
      }
      await expect(prepared).resolves.toMatchObject({
        serviceMutationAllowed: false,
        refreshGatewayServiceEnv: false,
        gatewayServiceEnv: expect.objectContaining({ OPENCLAW_STATE_DIR: "/managed/state" }),
        serviceMutationSkipMessage: expect.stringMatching(
          /SERVICE-DEFINITION.*unmask.*openclaw gateway start.*readiness.*unverified/,
        ),
      });
      expect(mocks.revalidate).not.toHaveBeenCalled();
    },
  );

  it.each([
    // mode, installed, loaded, stopped, owned, prepare, captured
    ["npm", true, false, false, true, true, true],
    ["npm", false, false, false, true, false, true],
    ["git", true, false, false, true, false, true],
    ["git", true, true, false, false, false, true],
    ["git", true, true, false, true, true, true],
    ["git", true, false, true, true, true, true],
    ["git", true, true, false, true, true, false],
  ] as const)(
    "prepares native install environment: mode=%s installed=%s loaded=%s stopped=%s owned=%s prepare=%s captured=%s",
    async (mode, installed, loaded, stopped, owned, shouldPrepare, captured) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", "/caller/state");
      const verdict: ManagedGatewayUpdateVerdict = owned
        ? { kind: "owned", root: "/installed", fingerprint: "fixture", refreshDefinition: true }
        : { kind: "unresolved", root: "/installed", fingerprint: "fixture" };
      mocks.readState.mockResolvedValue({
        installed,
        loadState: { status: loaded ? "loaded" : "not-loaded" },
        running: false,
        env: serviceEnv,
        command: { programArguments: ["node", "/installed/entry.js"], environment: serviceEnv },
      });
      mocks.revalidate.mockResolvedValue(verdict);
      const result = await prepare({
        result: { status: "ok", mode, steps: [], durationMs: 0 },
        preManagedServiceStop: {
          ...inspectedService,
          stopped,
          running: false,
          serviceEnv: captured ? serviceEnv : undefined,
          serviceUpdateVerdict: verdict,
        },
      });
      expect(mocks.readState).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          OPENCLAW_STATE_DIR: captured ? "/managed/state" : "/caller/state",
        }),
        1000,
        expect.objectContaining({ assertCurrent: expect.any(Function) }),
      );
      expect(result.gatewayServiceInstallEnv?.OPENCLAW_STATE_DIR).toBe(
        shouldPrepare ? "/managed/state" : undefined,
      );
      expect(result.refreshGatewayServiceEnv).toBe(shouldPrepare);
    },
  );
});
