import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { createGatewayTool } from "../../agents/tools/gateway-tool.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readUpdateRunDriver } from "../../infra/update-run-driver.js";
import { getUpdateRun, listUpdateRuns } from "../../infra/update-run-ledger.js";
import { UNPROTECTED_GATEWAY_UPDATE_ADVISORY } from "../../infra/update-run-record.js";
import { readUpdateRunStatus } from "../../infra/update-run-status.js";
import type { GatewayRequestContext } from "./types.js";
import {
  adoptUpdateCampaignMock,
  captureUpdateRunPayload,
  runPostCoreFinalizeAfterGatewayUpdateMock,
  detectRespawnSupervisorMock,
  initializeGatewayUpdateStatusMock,
  runGatewayUpdateMock,
  scheduleGatewaySigusr1RestartMock,
  sendGatewayLifecycleNoticeMock,
  sentinelState,
  startManagedServiceUpdateHandoffMock,
} from "./update.test-harness.js";

const host = vi.hoisted(() => ({ context: undefined as GatewayRequestContext | undefined }));
vi.mock("../../agents/tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
  readGatewayCallOptions: vi.fn(),
}));
vi.mock("../server-plugins.js", () => ({
  getInProcessGatewayRequestContext: () => host.context,
  hasInProcessGatewayContext: () => Boolean(host.context),
  dispatchGatewayMethodInProcess: async (_method: string, params: Record<string, unknown>) => {
    const { updateHandlers } = await import("./update.js");
    let response: unknown;
    await expectDefined(
      updateHandlers["update.run"],
      "update.run handler",
    )({
      params,
      context: host.context,
      respond: (_ok: boolean, result: unknown) => {
        response = result;
      },
    } as never);
    return response;
  },
}));

describe("update.run current owner authority", () => {
  let config: OpenClawConfig;
  beforeEach(() => {
    config = { commands: { ownerAllowFrom: ["owner"] } };
    host.context = { getRuntimeConfig: () => config } as GatewayRequestContext;
  });

  async function runOwnerTool(tool: ReturnType<typeof createGatewayTool>, channel = "slack") {
    return withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:slack:dm:owner:thread:123",
        turnSourceChannel: channel,
        turnSourceAccountId: "primary",
        turnSourceTo: "owner",
      },
      () => tool.execute("update", { action: "update.run" }),
    );
  }

  it.each(["revoked", "reassigned", "unchanged", "webchat", "channel-less"])(
    "%s owner after tool construction uses current config",
    async (change) => {
      const tool = createGatewayTool({ senderIsOwner: true, requesterSenderId: "owner" });
      config = {
        commands: {
          ownerAllowFrom:
            change === "unchanged" ? ["owner"] : change === "revoked" ? [] : ["replacement"],
        },
      };
      const result =
        change === "channel-less"
          ? await tool.execute("update", { action: "update.run" })
          : await runOwnerTool(tool, change === "webchat" ? "webchat" : "slack");
      const allowed = change === "unchanged" || change === "webchat" || change === "channel-less";
      expect(result.details).toMatchObject({ ok: allowed });
      if (allowed) {
        expect(runGatewayUpdateMock).toHaveBeenCalledOnce();
      } else {
        expect(result.details).toMatchObject({
          reason: "owner_required",
          ackDelivered: false,
          message: expect.stringContaining(
            `openclaw config set commands.ownerAllowFrom '${JSON.stringify(change === "revoked" ? ["slack:owner"] : ["replacement", "slack:owner"])}'`,
          ),
        });
        expect(listUpdateRuns()).toEqual([
          expect.objectContaining({
            trigger: "chat",
            phase: "finished",
            status: "failed",
            reason: "owner_required",
          }),
        ]);
        expect(adoptUpdateCampaignMock).not.toHaveBeenCalled();
        expect(sendGatewayLifecycleNoticeMock).not.toHaveBeenCalled();
        expect(runGatewayUpdateMock).not.toHaveBeenCalled();
        expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
        expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
        expect(sentinelState.capturedPayload).toBeUndefined();
      }
    },
  );

  it("carries the admitted chat requester into the managed handoff", async () => {
    detectRespawnSupervisorMock.mockReturnValue("launchd");
    const result = await runOwnerTool(
      createGatewayTool({ senderIsOwner: true, requesterSenderId: "owner" }),
    );
    expect(result.details).toMatchObject({ ok: true });
    expect(listUpdateRuns()).toEqual([
      expect.objectContaining({
        origin: expect.objectContaining({
          requester: { channel: "slack", accountId: "primary", senderId: "owner" },
        }),
      }),
    ]);
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requester: { channel: "slack", accountId: "primary", senderId: "owner" },
      }),
    );
  });

  it.each([false, true])(
    "refuses before acknowledgement after discovery revokes ownership (managed=%s)",
    async (managed) => {
      detectRespawnSupervisorMock.mockReturnValue(managed ? "launchd" : null);
      initializeGatewayUpdateStatusMock.mockImplementationOnce(async () => {
        config = { commands: { ownerAllowFrom: ["replacement"] } };
        return {
          root: "/tmp/openclaw",
          status: { root: "/tmp/openclaw", installKind: "git", packageManager: "pnpm" },
          installReceipt: null,
        };
      });

      const result = await runOwnerTool(
        createGatewayTool({ senderIsOwner: true, requesterSenderId: "owner" }),
      );

      expect(result.details).toMatchObject({
        ok: false,
        reason: "owner_required",
        ackDelivered: false,
      });
      expect(listUpdateRuns()).toEqual([
        expect.objectContaining({ phase: "finished", status: "failed", reason: "owner_required" }),
      ]);
      expect(sendGatewayLifecycleNoticeMock).not.toHaveBeenCalled();
      expect(runGatewayUpdateMock).not.toHaveBeenCalled();
      expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
      expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
      expect(sentinelState.capturedPayload).toBeUndefined();
    },
  );

  it.each([false, true])("rechecks after awaited acknowledgement (managed=%s)", async (managed) => {
    detectRespawnSupervisorMock.mockReturnValue(managed ? "launchd" : null);
    sendGatewayLifecycleNoticeMock.mockImplementationOnce(async () => {
      config = { commands: { ownerAllowFrom: ["replacement"] } };
      return true;
    });
    const result = await runOwnerTool(
      createGatewayTool({ senderIsOwner: true, requesterSenderId: "owner" }),
    );
    expect(result.details).toMatchObject({
      ok: false,
      reason: "owner_required",
      ackDelivered: true,
      message: expect.stringContaining(
        'openclaw config set commands.ownerAllowFrom \'["replacement","slack:owner"]\'',
      ),
    });
    expect(runGatewayUpdateMock).not.toHaveBeenCalled();
    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(sentinelState.capturedPayload).toBeUndefined();
    expect(sendGatewayLifecycleNoticeMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(
          'openclaw config set commands.ownerAllowFrom \'["replacement","slack:owner"]\'',
        ),
      }),
    );
  });
});

it("preserves the non-Git package-root refusal without declaring an unprotected update", async () => {
  const root = "/tmp/openclaw-local-package";
  initializeGatewayUpdateStatusMock.mockResolvedValueOnce({
    root,
    status: { root, installKind: "package", packageManager: "npm" },
    installReceipt: null,
  });
  runGatewayUpdateMock.mockResolvedValueOnce({
    status: "skipped",
    reason: "not-git-install",
    mode: "unknown",
    root,
    steps: [],
    durationMs: 0,
  });

  const payload = await captureUpdateRunPayload();

  expect(payload?.result).toMatchObject({
    status: "skipped",
    reason: "not-git-install",
    steps: [],
  });
  expect(runGatewayUpdateMock).toHaveBeenCalledOnce();
  const options = runGatewayUpdateMock.mock.calls[0]?.[0];
  expect(options?.updateRecoveryOwner).toBeUndefined();
  expect(options?.getDoctorEnv).toBeUndefined();
  const runId = expectDefined(payload?.runId, "Package-root refusal retains its own run");
  expect(getUpdateRun(runId)?.origin.unprotectedGatewayUpdate).toBeUndefined();
  const runStatus = readUpdateRunStatus();
  expect(runStatus).not.toHaveProperty("runStatusError");
  expect(runStatus).not.toMatchObject({
    advisories: expect.arrayContaining([
      expect.objectContaining({ message: UNPROTECTED_GATEWAY_UPDATE_ADVISORY }),
    ]),
  });
});

it("declares an unsupervised Git update unprotected before Doctor and reports its advisory", async () => {
  let declaredRun: ReturnType<typeof getUpdateRun>;
  runGatewayUpdateMock.mockImplementationOnce(async (opts) => {
    declaredRun = getUpdateRun(expectDefined(opts?.runId, "RPC update has an admitted run"));
    return { status: "ok", mode: "git", root: "/tmp/openclaw", steps: [], durationMs: 0 };
  });
  const payload = await captureUpdateRunPayload();
  expect(payload?.result?.status).toBe("ok");
  expect(
    Boolean(declaredRun?.origin.unprotectedGatewayUpdate),
    "RPC declares intent before launching Doctor",
  ).toBe(true);
  expect(declaredRun?.origin.unprotectedGatewayUpdate?.owner).toEqual(readUpdateRunDriver());
  const opts = runGatewayUpdateMock.mock.calls[0]?.[0];
  expect(opts?.getDoctorEnv?.()?.OPENCLAW_UPDATE_RUN_ID).toBe(declaredRun?.runId);
  expect(opts?.updateRecoveryOwner).toBe("unprotected");
  expect(opts?.getUpdateRecoveryBackup).toBeUndefined();
  expect(payload?.result).toMatchObject({
    steps: expect.arrayContaining([
      expect.objectContaining({
        advisory: { kind: "recoverable-maintenance", message: UNPROTECTED_GATEWAY_UPDATE_ADVISORY },
      }),
    ]),
  });
  expect(readUpdateRunStatus()).toMatchObject({
    advisories: expect.arrayContaining([
      expect.objectContaining({
        runId: payload?.runId,
        message: UNPROTECTED_GATEWAY_UPDATE_ADVISORY,
      }),
    ]),
  });
  expect(runPostCoreFinalizeAfterGatewayUpdateMock).toHaveBeenCalledWith(
    expect.objectContaining({
      env: expect.objectContaining({ OPENCLAW_UPDATE_RUN_ID: payload?.runId }),
    }),
  );
});
