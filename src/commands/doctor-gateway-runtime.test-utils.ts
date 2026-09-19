import { expect, it, vi, type Mock } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { DaemonRuntimePinSnapshot } from "../daemon/runtime-pin-types.js";
import type { ServiceConfigAudit } from "../daemon/service-audit.js";
import { withEnvAsync } from "../test-utils/env.js";
// Vitest hoists the declaration before imports; the export must remain a separate statement.
const pinSnapshotMock = vi.hoisted(() =>
  vi.fn<() => DaemonRuntimePinSnapshot>(() => ({ revision: "empty", stored: false })),
);
vi.mock("../daemon/runtime-pin-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/runtime-pin-state.js")>()),
  readDaemonRuntimePin: pinSnapshotMock,
}));

export { pinSnapshotMock };

export function makeDoctorIo() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

export function makeDoctorPrompts() {
  return {
    confirm: vi.fn().mockResolvedValue(true),
    confirmAutoFix: vi.fn().mockResolvedValue(true),
    confirmAggressiveAutoFix: vi.fn().mockResolvedValue(true),
    confirmRuntimeRepair: vi.fn().mockResolvedValue(true),
    select: vi.fn().mockResolvedValue("node"),
    shouldRepair: false,
    shouldForce: false,
    repairMode: {
      shouldRepair: false,
      shouldForce: false,
      nonInteractive: false,
      canPrompt: true,
      updateInProgress: false,
    },
  };
}

type RuntimePinTestContext = {
  mocks: {
    readCommand: Mock;
    buildGatewayInstallPlan: Mock;
    auditGatewayServiceConfig: Mock;
    resolveSystemNodeInfo: Mock;
    needsNodeRuntimeMigration: Mock;
    install: Mock;
  };
  runRepair: (config: OpenClawConfig) => Promise<void>;
  createRecommendedServiceAudit: (code: string, message: string) => ServiceConfigAudit;
};

export function registerDoctorRuntimePinTests({
  mocks,
  runRepair,
  createRecommendedServiceAudit,
}: RuntimePinTestContext) {
  it("preserves an explicit Node pin instead of migrating it during doctor repair", async () => {
    const pin = "/home/test/.nvm/versions/node/v26.8.1/bin/node";
    pinSnapshotMock.mockReturnValue({
      revision: "prior",
      stored: true,
      pin: { runtime: "node", path: pin },
    });
    const command = {
      programArguments: [pin, "/usr/local/bin/openclaw", "gateway", "--port", "18789"],
      environment: {},
    };
    mocks.readCommand.mockResolvedValue(command);
    mocks.buildGatewayInstallPlan.mockResolvedValue(command);
    mocks.auditGatewayServiceConfig.mockResolvedValue(
      createRecommendedServiceAudit("gateway-path-nonminimal", "Regenerate Gateway PATH"),
    );
    await runRepair({ gateway: {} });
    for (const [options] of mocks.buildGatewayInstallPlan.mock.calls) {
      expect(options).toEqual(
        expect.objectContaining({
          runtime: "node",
          pinnedRuntimePath: pin,
        }),
      );
    }
    expect(mocks.resolveSystemNodeInfo).not.toHaveBeenCalled();
    expect(mocks.install).toHaveBeenCalledWith(
      expect.objectContaining({
        programArguments: command.programArguments,
      }),
    );
  });

  it.each([undefined, ""])(
    "handles an inactive Bun pin when the wrapper invocation value is %s",
    async (wrapperOverride) => {
      const wrapper = "/usr/local/bin/openclaw-doppler";
      const pin = "/opt/pinned/bun";
      pinSnapshotMock.mockReturnValue({
        revision: "prior",
        stored: true,
        pin: { runtime: "bun", path: pin },
      });
      const command = {
        programArguments: [wrapper, "gateway", "--port", "18789"],
        environment: { OPENCLAW_WRAPPER: wrapper },
      };
      mocks.readCommand.mockResolvedValue(command);
      mocks.buildGatewayInstallPlan.mockResolvedValue(command);
      mocks.auditGatewayServiceConfig.mockResolvedValue(
        createRecommendedServiceAudit("gateway-path-nonminimal", "Regenerate Gateway PATH"),
      );
      mocks.needsNodeRuntimeMigration.mockReturnValue(true);

      await withEnvAsync({ OPENCLAW_WRAPPER: wrapperOverride }, async () => {
        await runRepair({ gateway: {} });
      });

      expect(mocks.buildGatewayInstallPlan).toHaveBeenCalled();
      for (const [options] of mocks.buildGatewayInstallPlan.mock.calls) {
        expect(options).toEqual(
          expect.objectContaining({
            runtime: wrapperOverride === "" ? "bun" : "node",
            runtimePath: wrapperOverride === "" ? pin : undefined,
            pinnedRuntimePath: pin,
            env: expect.objectContaining({
              OPENCLAW_WRAPPER: wrapperOverride ?? wrapper,
            }),
          }),
        );
      }
      expect(mocks.resolveSystemNodeInfo).not.toHaveBeenCalled();
      expect(mocks.install).toHaveBeenCalledOnce();
    },
  );
}
