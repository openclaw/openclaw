import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentSystemPrompt } from "../../agents/system-prompt.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { createGatewayTool } from "../../agents/tools/gateway-tool.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getUpdateRun, listUpdateRuns } from "../../infra/update-run-ledger.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveGatewayScopedTools } from "../tool-resolution.js";
import { summarizeUpdateRunResponse } from "../update-run-summary.js";
import type { GatewayRequestContext } from "./types.js";
import {
  adoptUpdateCampaignMock,
  detectRespawnSupervisorMock,
  isRestartEnabledMock,
  mockGlobalInstallSurface,
  readGatewayOwnerLeaseMock,
  resolveUpdateInstallSurfaceMock,
  resolveStartupInstallStatusMock,
  scheduleGatewayRestartMock,
  sendGatewayLifecycleNoticeMock,
  sentinelState,
  startManagedServiceUpdateHandoffMock,
  transferManagedServiceUpdateHandoffMock,
  type UpdateRunPayload,
} from "./update.test-harness.js";

const host = vi.hoisted(() => ({ context: undefined as GatewayRequestContext | undefined }));
vi.mock("../../agents/tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
  readGatewayCallOptions: vi.fn(),
}));
vi.mock("../server-plugin-in-process-dispatch.js", () => ({
  getInProcessGatewayRequestContext: () => host.context,
  dispatchGatewayMethodInProcess: async (
    _method: string,
    params: Record<string, unknown>,
    options?: { sessionMutationCommitGuard?: () => void },
  ) => {
    const { updateHandlers } = await import("./update.js");
    let response: unknown;
    await expectDefined(
      updateHandlers["update.run"],
      "update.run handler",
    )({
      params,
      sessionMutationCommitGuard: options?.sessionMutationCommitGuard,
      context: host.context,
      respond: (_ok: boolean, result: unknown) => {
        response = result;
      },
    } as never);
    return response;
  },
}));

// Prepare the tool surface before case deadlines; execution resolves the current Gateway context.
const promptUpdateCases = (
  [
    { channel: "slack", supervisor: "launchd" },
    { channel: "discord", supervisor: "systemd" },
    { channel: "discord", supervisor: null },
  ] as const
).map(({ channel, supervisor }) => {
  const config: OpenClawConfig = {
    plugins: { enabled: false },
    tools: { profile: "coding" },
    commands: { ownerAllowFrom: [`${channel}:owner`] },
  };
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
  return {
    channel,
    supervisor,
    config,
    toolNames: tools.map((candidate) => candidate.name),
    tool: expectDefined(
      tools.find((candidate) => candidate.name === "gateway"),
      "Gateway-scoped update tool",
    ),
  };
});

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
        expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
        expect(transferManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
        expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
        const run = expectDefined(listUpdateRuns()[0], "accepted update run");
        expect(run.status).toBe("running");
        expect(sentinelState.capturedPayload?.stats?.runId).toBe(run.runId);
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
        expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
        expect(transferManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
        expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
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

  it.each(promptUpdateCases)(
    "matches the prompt update path for $channel with supervisor $supervisor",
    async ({ channel, supervisor, config: promptConfig, toolNames, tool }) => {
      config = promptConfig;
      detectRespawnSupervisorMock.mockReturnValue(supervisor);
      mockGlobalInstallSurface();
      const prompt = buildAgentSystemPrompt({
        workspaceDir: "/tmp/openclaw",
        toolNames,
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

      expect(result.details).toMatchObject({ ok: true, handoff: { status: "started" } });
      expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
      expect(transferManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
      expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
      const handoff = expectDefined(
        startManagedServiceUpdateHandoffMock.mock.calls[0]?.[0],
        "prepared update handoff",
      );
      expect(handoff).toMatchObject({
        supervisor,
        requester: { channel, accountId: "primary", senderId: "owner" },
      });
      expect(transferManagedServiceUpdateHandoffMock).toHaveBeenCalledExactlyOnceWith({
        kind: "managed-update-handoff",
        handoffId: handoff.handoffId,
        installRoot: handoff.root,
      });
      expect(sentinelState.capturedPayload?.stats).toMatchObject({
        runId: handoff.runId,
        handoffId: handoff.handoffId,
      });
      if (!supervisor) {
        expect(readGatewayOwnerLeaseMock).toHaveBeenCalledWith({ current: true });
        const owner = expectDefined(
          readGatewayOwnerLeaseMock.mock.results.at(-1)?.value,
          "current foreground Gateway owner",
        );
        expect(owner).toMatchObject({ mode: "foreground", state: "live", pid: process.pid });
        expect(owner.startedAt).not.toBeNull();
        expect(handoff).toMatchObject({
          argv1: "/tmp/openclaw-global/dist/index.js",
          foregroundOrigin: {
            owner: owner.owner,
            pid: owner.pid,
            host: owner.host,
            startedAt: owner.startedAt,
            port: owner.port,
          },
          meta: { completionOwner: "gateway-restart" },
        });
      }
      await expectDefined(handoff.beforePark, "prepared update parking callback")();
      if (supervisor) {
        expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
      } else {
        expect(scheduleGatewayRestartMock).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            reason: "update.run",
            successorOwner: transferManagedServiceUpdateHandoffMock.mock.calls[0]?.[0],
          }),
        );
      }
      expect(guidance).toContain("only on an explicit owner request");
      expect(guidance).toContain("relay the tool's exact recovery instructions");
      expect(guidance).toContain("operator to run outside the Gateway service");
      expect(guidance).toContain(
        "Never run openclaw update, npm install -g openclaw, swap installations, or stop/restart the gateway service via exec or detached jobs.",
      );
    },
  );

  it.each([false, true])(
    "refuses before acknowledgement after discovery revokes ownership (managed=%s)",
    async (managed) => {
      detectRespawnSupervisorMock.mockReturnValue(managed ? "launchd" : null);
      resolveStartupInstallStatusMock.mockImplementationOnce(async () => {
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
      expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
      expect(transferManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
      expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
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
    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(transferManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
    expect(sentinelState.capturedPayload).toBeUndefined();
    expect(sendGatewayLifecycleNoticeMock).toHaveBeenCalledOnce();
  });

  it("rechecks scheduled admission after discovery before starting the update handoff", async () => {
    let active = true;
    resolveStartupInstallStatusMock.mockImplementationOnce(async () => {
      active = false;
      return {
        root: "/tmp/openclaw",
        status: { root: "/tmp/openclaw", installKind: "git", packageManager: "pnpm" },
        installReceipt: null,
      };
    });
    const { updateHandlers } = await import("./update.js");
    const respond = vi.fn();
    await expectDefined(
      updateHandlers["update.run"],
      "update.run handler",
    )({
      params: {},
      context: host.context,
      respond,
      sessionMutationCommitGuard: () => {
        if (!active) {
          throw new Error("cron update authority is no longer active");
        }
      },
    } as never);
    const summary = summarizeUpdateRunResponse(respond.mock.calls[0]?.[1]);
    expect(summary).toMatchObject({
      ok: false,
      reason: "owner_required",
      message: expect.stringContaining(
        "no longer has a live requester principal or scheduled operator admission",
      ),
    });
    expect(listUpdateRuns()).toEqual([
      expect.objectContaining({
        status: "failed",
        reason: "owner_required",
        origin: expect.objectContaining({ nextAction: summary.message }),
      }),
    ]);
    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(transferManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
  });
});

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
    resolveStartupInstallStatusMock.mockResolvedValue({
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
    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(transferManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
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
        expect.any(Object),
      );
    },
  );
});
