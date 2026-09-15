import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentSystemPrompt } from "../../agents/system-prompt.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { createGatewayTool } from "../../agents/tools/gateway-tool.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listUpdateRuns } from "../../infra/update-run-ledger.js";
import { resolveGatewayScopedTools } from "../tool-resolution.js";
import type { GatewayRequestContext } from "./types.js";
import {
  adoptUpdateCampaignMock,
  detectRespawnSupervisorMock,
  initializeGatewayUpdateStatusMock,
  mockGlobalInstallSurface,
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

  it.each([
    { channel: "slack", supervisor: "launchd" },
    { channel: "discord", supervisor: "systemd" },
    { channel: "discord", supervisor: null },
  ] as const)(
    "matches the prompt update path for $channel with supervisor $supervisor",
    async ({ channel, supervisor }) => {
      config = {
        plugins: { enabled: false },
        tools: { profile: "coding" },
        commands: { ownerAllowFrom: [`${channel}:owner`] },
      };
      detectRespawnSupervisorMock.mockReturnValue(supervisor);
      mockGlobalInstallSurface();
      const { tools } = resolveGatewayScopedTools({
        cfg: config,
        sessionKey: `agent:main:${channel}:dm:owner`,
        messageProvider: channel,
        accountId: "primary",
        agentTo: "owner",
        senderIsOwner: true,
        channelContext: { sender: { id: "owner" } },
        surface: "loopback",
      });
      const tool = expectDefined(
        tools.find((candidate) => candidate.name === "gateway"),
        "Gateway-scoped update tool",
      );
      const prompt = buildAgentSystemPrompt({
        workspaceDir: "/tmp/openclaw",
        toolNames: tools.map((candidate) => candidate.name),
        runtimeInfo: { channel },
      });
      const guidance = expectDefined(
        prompt.split("\n").find((line) => line.startsWith("For the Gateway hosting this session:")),
        "hosting Gateway guidance",
      );
      const action = expectDefined(
        guidance.match(/Update OpenClaw: `gateway` action ([\w.]+)/u)?.[1],
        "prompt-advertised update action",
      );
      const result = await tool.execute("update", {
        action,
        requesterSenderId: "model-supplied-sender",
      });

      if (supervisor) {
        expect(result.details).toMatchObject({ ok: true, handoff: { status: "started" } });
        expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
          expect.objectContaining({
            requester: { channel, accountId: "primary", senderId: "owner" },
          }),
        );
        expect(guidance).toContain("only on an explicit owner request");
      } else {
        expect(result.details).toMatchObject({
          ok: false,
          reason: "managed-service-handoff-unavailable",
          handoff: {
            status: "unavailable",
            command: expect.stringContaining("openclaw update"),
            message: expect.stringContaining("Stop the foreground Gateway"),
          },
        });
        expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
        expect(guidance).toContain("relay the tool's exact recovery instructions");
        expect(guidance).toContain("operator to run outside the Gateway service");
      }
      expect(runGatewayUpdateMock).not.toHaveBeenCalled();
      expect(guidance).toContain(
        "Never run openclaw update, npm install -g openclaw, swap installations, or stop/restart the gateway service via exec or detached jobs.",
      );
    },
  );

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
    expect(sendGatewayLifecycleNoticeMock).toHaveBeenCalledOnce();
  });
});
