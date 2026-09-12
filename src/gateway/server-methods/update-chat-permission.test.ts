import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  adoptUpdateCampaignMock,
  detectRespawnSupervisorMock,
  initializeGatewayUpdateStatusMock,
  isRestartEnabledMock,
  resolveUpdateInstallSurfaceMock,
  runGatewayUpdateMock,
  scheduleGatewaySigusr1RestartMock,
  sendGatewayLifecycleNoticeMock,
  sentinelState,
  startManagedServiceUpdateHandoffMock,
  transferManagedServiceUpdateHandoffMock,
  type UpdateRunPayload,
} from "./update.test-harness.js";

describe("update.run chat restart permission", () => {
  let config: OpenClawConfig;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("../../config/commands.flags.js")>(
      "../../config/commands.flags.js",
    );
    isRestartEnabledMock.mockImplementation(actual.isRestartEnabled);
    config = { commands: { ownerAllowFrom: ["slack:owner"] } };
  });

  async function runUpdate(
    requester: { channel?: string; senderId?: string } | undefined = {
      channel: "slack",
      senderId: "owner",
    },
  ): Promise<UpdateRunPayload> {
    const { updateHandlers } = await import("./update.js");
    let payload: UpdateRunPayload | undefined;
    await expectDefined(
      updateHandlers["update.run"],
      "update.run handler",
    )({
      params: {
        requester,
        sessionKey: "agent:main:slack:dm:owner:thread:123",
        deliveryContext: { channel: "slack", to: "owner" },
      },
      context: { getRuntimeConfig: () => config },
      respond: (_ok: boolean, result: UpdateRunPayload) => {
        payload = result;
      },
    } as never);
    return expectDefined(payload, "update.run response");
  }

  function prepareGlobalInstall(supervisor: "launchd" | "systemd") {
    detectRespawnSupervisorMock.mockReturnValue(supervisor);
    initializeGatewayUpdateStatusMock.mockResolvedValue({
      root: "/tmp/openclaw-global",
      status: { root: "/tmp/openclaw-global", installKind: "package", packageManager: "npm" },
      installReceipt: null,
    });
    resolveUpdateInstallSurfaceMock.mockResolvedValue({
      kind: "global",
      mode: "npm",
      root: "/tmp/openclaw-global",
      packageRoot: "/tmp/openclaw-global",
    });
  }

  function expectDisabledUpdate(payload: UpdateRunPayload) {
    expect(payload).toMatchObject({
      ok: false,
      result: { status: "skipped", reason: "restart-disabled" },
      message: expect.stringContaining("commands.restart"),
    });
    expect(getUpdateRun(payload.runId)).toMatchObject({
      trigger: "chat",
      phase: "finished",
      status: "skipped",
      reason: "restart-disabled",
    });
    expect(runGatewayUpdateMock).not.toHaveBeenCalled();
    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(transferManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(sentinelState.capturedPayload).toBeUndefined();
  }

  describe.each(["launchd", "systemd"] as const)("%s managed install", (supervisor) => {
    it.each([true, false, undefined])("honors commands.restart=%s for chat", async (restart) => {
      prepareGlobalInstall(supervisor);
      config = { commands: { ownerAllowFrom: ["slack:owner"], restart } };

      const payload = await runUpdate();

      if (restart === false) {
        expectDisabledUpdate(payload);
        expect(payload.ackDelivered).toBe(false);
        expect(adoptUpdateCampaignMock).not.toHaveBeenCalled();
        expect(sendGatewayLifecycleNoticeMock).not.toHaveBeenCalled();
      } else {
        expect(payload).toMatchObject({ ok: true, handoff: { status: "started" } });
        expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
        expect(transferManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
      }
    });
  });

  it.each(["webchat", "api"])(
    "preserves managed %s operator updates when chat restart commands are disabled",
    async (source) => {
      prepareGlobalInstall("launchd");
      config = { commands: { restart: false } };

      const payload = await runUpdate(source === "webchat" ? { channel: "webchat" } : {});

      expect(payload).toMatchObject({ ok: true, handoff: { status: "started" } });
      expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
      expect(transferManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "rechecks current commands.restart after awaited acknowledgement (managed=%s)",
    async (managed) => {
      if (managed) {
        prepareGlobalInstall("launchd");
      }
      const acknowledgement = createDeferredCore<boolean>();
      const acknowledgementStarted = createDeferredCore();
      sendGatewayLifecycleNoticeMock.mockImplementationOnce(() => {
        acknowledgementStarted.resolve();
        return acknowledgement.promise;
      });
      const running = runUpdate();
      try {
        await Promise.race([acknowledgementStarted.promise, running]);
        expect(sendGatewayLifecycleNoticeMock).toHaveBeenCalledOnce();
        config = { commands: { ownerAllowFrom: ["slack:owner"], restart: false } };
      } finally {
        acknowledgement.resolve(true);
        await running;
      }

      const payload = await running;
      expectDisabledUpdate(payload);
      expect(payload.ackDelivered).toBe(true);
      expect(sendGatewayLifecycleNoticeMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ message: expect.stringContaining("commands.restart") }),
      );
    },
  );
});
