import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestConfigSnapshot } from "../../commands/test-runtime-config-helpers.js";
import { ServiceStartRefusalError } from "../../daemon/service-inspection-error.js";
import type { GatewayServiceState } from "../../daemon/service-types.js";
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

function prepare(input: Partial<Parameters<typeof prepareUpdateRestart>[0]>) {
  return prepareUpdateRestart(
    {
      root: "/installed",
      result: { status: "ok", mode: "npm", steps: [], durationMs: 0 },
      shouldRestart: true,
      updateStepTimeoutMs: 1000,
      assertCurrent: () => {},
      ...input,
    },
    createTestConfigSnapshot({}, {}, "/managed/state/openclaw.json"),
  );
}

describe("prepareUpdateRestart", () => {
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
