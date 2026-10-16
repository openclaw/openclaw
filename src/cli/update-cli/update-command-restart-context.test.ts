import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfigFileSnapshot } from "../../config/io.snapshot-shared.js";
import { ServiceStartRefusalError } from "../../daemon/service-inspection-error.js";
import type { GatewayServiceState } from "../../daemon/service-types.js";
import { prepareUpdateRestart } from "./update-command-restart-context.js";
import type { ManagedGatewayUpdateVerdict } from "./update-command-service-context-types.js";
import { GatewayServiceUpdateOwnershipError } from "./update-command-service-plan.js";

const mocks = vi.hoisted(() => ({
  readState: vi.fn<() => Promise<GatewayServiceState>>(),
  revalidate: vi.fn<() => Promise<ManagedGatewayUpdateVerdict>>(),
}));

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
      const prepared = prepareUpdateRestart(
        {
          root: "/installed",
          result: { status: "ok", mode: "npm", steps: [], durationMs: 0 },
          shouldRestart: true,
          updateStepTimeoutMs: 1000,
          assertCurrent: () => {},
          preManagedServiceStop: {
            stopped: true,
            inspected: true,
            runtimeInspected: true,
            running: true,
            serviceEnv: { OPENCLAW_STATE_DIR: "/managed/state" },
          },
          serviceRuntimeRefreshRequired: scenario === "masked-runtime-refresh",
        },
        createConfigFileSnapshot({
          path: "/managed/state/openclaw.json",
          exists: true,
          raw: "{}",
          parsed: {},
          sourceConfig: {},
          runtimeConfig: {},
          valid: true,
          issues: [],
          warnings: [],
          legacyIssues: [],
        }),
      );
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
    {
      mode: "npm",
      installed: true,
      loaded: false,
      stopped: false,
      owned: true,
      prepare: true,
      captured: true,
    },
    {
      mode: "npm",
      installed: false,
      loaded: false,
      stopped: false,
      owned: true,
      prepare: false,
      captured: true,
    },
    {
      mode: "git",
      installed: true,
      loaded: false,
      stopped: false,
      owned: true,
      prepare: false,
      captured: true,
    },
    {
      mode: "git",
      installed: true,
      loaded: true,
      stopped: false,
      owned: false,
      prepare: false,
      captured: true,
    },
    {
      mode: "git",
      installed: true,
      loaded: true,
      stopped: false,
      owned: true,
      prepare: true,
      captured: true,
    },
    {
      mode: "git",
      installed: true,
      loaded: false,
      stopped: true,
      owned: true,
      prepare: true,
      captured: true,
    },
    {
      mode: "git",
      installed: true,
      loaded: true,
      stopped: false,
      owned: true,
      prepare: true,
      captured: false,
    },
  ] as const)(
    "prepares the native install environment for $mode (installed=$installed, loaded=$loaded, stopped=$stopped, owned=$owned)",
    async ({ mode, installed, loaded, stopped, owned, prepare, captured }) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", "/caller/state");
      const serviceEnv = { OPENCLAW_STATE_DIR: "/managed/state" };
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
      const result = await prepareUpdateRestart(
        {
          root: "/installed",
          result: { status: "ok", mode, steps: [], durationMs: 0 },
          shouldRestart: true,
          updateStepTimeoutMs: 1000,
          assertCurrent: () => {},
          preManagedServiceStop: {
            stopped,
            inspected: true,
            runtimeInspected: true,
            running: false,
            serviceEnv: captured ? serviceEnv : undefined,
            serviceUpdateVerdict: verdict,
          },
        },
        createConfigFileSnapshot({
          path: "/managed/state/openclaw.json",
          exists: true,
          raw: "{}",
          parsed: {},
          sourceConfig: {},
          runtimeConfig: {},
          valid: true,
          issues: [],
          warnings: [],
          legacyIssues: [],
        }),
      );
      expect(mocks.readState).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          OPENCLAW_STATE_DIR: captured ? "/managed/state" : "/caller/state",
        }),
        1000,
        expect.objectContaining({ assertCurrent: expect.any(Function) }),
      );
      expect(result.gatewayServiceInstallEnv?.OPENCLAW_STATE_DIR).toBe(
        prepare ? "/managed/state" : undefined,
      );
      expect(result.refreshGatewayServiceEnv).toBe(prepare);
    },
  );
});
