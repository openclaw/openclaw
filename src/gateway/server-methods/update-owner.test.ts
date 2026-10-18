import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, expect, it, vi } from "vitest";
import { buildAgentSystemPrompt } from "../../agents/system-prompt.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { createGatewayTool } from "../../agents/tools/gateway-tool.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getUpdateRun, listUpdateRuns } from "../../infra/update-run-ledger.js";
import { createPluginCache, withPluginCache } from "../../plugins/plugin-cache.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveGatewayScopedTools } from "../tool-resolution.js";
import { summarizeUpdateRunResponse } from "../update-run-summary.js";
import type { GatewayRequestContext } from "./types.js";
import {
  adoptUpdateCampaignMock as adoptCampaign,
  detectRespawnSupervisorMock as detectSupervisor,
  isRestartEnabledMock as restartEnabled,
  mockGlobalInstallSurface as globalInstall,
  readGatewayOwnerLeaseMock as ownerLease,
  resolveStartupInstallStatusMock as installStatus,
  scheduleGatewayRestartMock as scheduleRestart,
  sendGatewayLifecycleNoticeMock as notice,
  sentinelState,
  startManagedServiceUpdateHandoffMock as startHandoff,
  transferManagedServiceUpdateHandoffMock as transferHandoff,
  type UpdateRunPayload,
} from "./update.test-harness.js";

const host = vi.hoisted(() => ({ context: undefined as GatewayRequestContext | undefined }));
let config: OpenClawConfig;
function configureOwner(ownerAllowFrom = ["owner"], restart?: boolean) {
  config = { commands: { ownerAllowFrom, ...(restart === undefined ? {} : { restart }) } };
  setRuntimeConfigSnapshot(config);
}
const ownerTool = () => createGatewayTool({ senderIsOwner: true, requesterSenderId: "owner" });
const sessionKey = "agent:main:slack:dm:owner:thread:123";
function expectNoHandoff() {
  expect(startHandoff).not.toHaveBeenCalled();
  expect(transferHandoff).not.toHaveBeenCalled();
  expect(scheduleRestart).not.toHaveBeenCalled();
}
function expectNoUpdate() {
  expectNoHandoff();
  expect(sentinelState.capturedPayload).toBeUndefined();
}
function expectOnlyRun(fields: Record<string, unknown>) {
  expect(listUpdateRuns()).toEqual([expect.objectContaining(fields)]);
}
function expectStarted(details: unknown) {
  expect(details).toMatchObject({ ok: true, handoff: { status: "started" } });
  expect(startHandoff).toHaveBeenCalledOnce();
  expect(transferHandoff).toHaveBeenCalledOnce();
  return expectDefined(startHandoff.mock.calls[0]?.[0], "prepared update handoff");
}
const ownerFailure = { status: "failed", reason: "owner_required" };
function expectOwnerRefusal(
  details: unknown,
  ackDelivered = false,
  owners = ["replacement", "slack:owner"],
  runFields: Record<string, unknown> = {},
) {
  expect(details).toMatchObject({
    ok: false,
    reason: "owner_required",
    ackDelivered,
    message: expect.stringContaining(
      `openclaw config set commands.ownerAllowFrom '${JSON.stringify(owners)}'`,
    ),
  });
  expectOnlyRun({ ...ownerFailure, phase: "finished", ...runFields });
  expectNoUpdate();
}
async function invokeUpdate(
  params: Record<string, unknown> = {},
  context: Pick<GatewayRequestContext, "getRuntimeConfig"> | undefined = host.context,
  sessionMutationCommitGuard?: () => void,
) {
  const { updateHandlers } = await import("./update.js");
  let payload: UpdateRunPayload | undefined;
  const handler = expectDefined(updateHandlers["update.run"], "update.run handler");
  await handler({
    params,
    context,
    sessionMutationCommitGuard,
    respond: (_ok: boolean, result: UpdateRunPayload) => {
      payload = result;
    },
  } as never);
  return expectDefined(payload, "update.run response");
}
vi.mock("../../agents/tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
  readGatewayCallOptions: vi.fn(),
}));
// mock-isolation: Route update calls through this suite's isolated Gateway host.
vi.mock("../server-plugin-in-process-dispatch.js", () => ({
  getInProcessGatewayRequestContext: () => host.context,
  dispatchGatewayMethodInProcess: async (
    _method: string,
    params: Record<string, unknown>,
    options?: { sessionMutationCommitGuard?: () => void },
  ) => invokeUpdate(params, host.context, options?.sessionMutationCommitGuard),
}));

// Prepare the tool surface before case deadlines; execution resolves the current Gateway context.
const promptUpdateCases = await (async () => {
  const cases = [];
  for (const { channel, supervisor } of [
    { channel: "slack", supervisor: "launchd" },
    { channel: "discord", supervisor: null },
  ] as const) {
    const promptConfig: OpenClawConfig = {
      plugins: { enabled: false },
      tools: { profile: "coding" },
      commands: { ownerAllowFrom: [`${channel}:owner`] },
    };
    setRuntimeConfigSnapshot(promptConfig);
    const cache = createPluginCache();
    const { tools } = await withPluginCache(cache, () =>
      resolveGatewayScopedTools({
        cfg: promptConfig,
        sessionKey: `agent:main:${channel}:dm:owner`,
        messageProvider: channel,
        accountId: "primary",
        agentTo: "owner",
        senderIsOwner: true,
        channelContext: { sender: { id: "owner" } },
        surface: "loopback",
      }),
    );
    cases.push({
      cache,
      channel,
      supervisor,
      config: promptConfig,
      toolNames: tools.map((candidate) => candidate.name),
      tool: expectDefined(
        tools.find((candidate) => candidate.name === "gateway"),
        "Gateway-scoped update tool",
      ),
    });
  }
  clearRuntimeConfigSnapshot();
  return cases;
})();

beforeEach(async () => {
  const actual = await vi.importActual<typeof import("../../config/commands.flags.js")>(
    "../../config/commands.flags.js",
  );
  restartEnabled.mockImplementation(actual.isRestartEnabled);
  configureOwner(["slack:owner"]);
  host.context = { getRuntimeConfig: () => config } as GatewayRequestContext;
});

async function runOwnerTool(tool: ReturnType<typeof createGatewayTool>, channel = "slack") {
  setRuntimeConfigSnapshot(config);
  return withGatewayToolCallerIdentity(
    {
      agentId: "main",
      sessionKey,
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
    const tool = ownerTool();
    configureOwner(
      change === "unchanged" ? ["owner"] : change === "revoked" ? [] : ["replacement"],
    );
    const result =
      change === "channel-less"
        ? await tool.execute("update", { action: "update.run" })
        : await runOwnerTool(tool, change === "webchat" ? "webchat" : "slack");
    const allowed = change === "unchanged" || change === "webchat" || change === "channel-less";
    expect(result.details).toMatchObject({ ok: allowed });
    if (allowed) {
      expectStarted(result.details);
      expect(scheduleRestart).not.toHaveBeenCalled();
      const run = expectDefined(listUpdateRuns()[0], "accepted update run");
      expect(run.status).toBe("running");
      expect(sentinelState.capturedPayload?.stats?.runId).toBe(run.runId);
    } else {
      expectOwnerRefusal(
        result.details,
        false,
        change === "revoked" ? ["slack:owner"] : undefined,
        { trigger: "chat" },
      );
      expect(adoptCampaign).not.toHaveBeenCalled();
      expect(notice).not.toHaveBeenCalled();
    }
  },
);

it.each(promptUpdateCases)(
  "matches the prompt update path for $channel with supervisor $supervisor",
  async ({ cache: preparedCache, channel, supervisor, config: promptConfig, toolNames, tool }) => {
    await using cache = preparedCache;
    await withPluginCache(cache, async () => {
      config = promptConfig;
      setRuntimeConfigSnapshot(config);
      detectSupervisor.mockReturnValue(supervisor);
      globalInstall();
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

      const handoff = expectStarted(result.details);
      expect(scheduleRestart).not.toHaveBeenCalled();
      const requester = {
        channel,
        accountId: "primary",
        senderId: "owner",
        authorizationSource: "configured-owner",
      };
      expect(handoff).toMatchObject({ supervisor, requester });
      expectOnlyRun({ origin: expect.objectContaining({ requester }) });
      expect(transferHandoff).toHaveBeenCalledExactlyOnceWith({
        kind: "managed-update-handoff",
        handoffId: handoff.handoffId,
        installRoot: handoff.root,
      });
      expect(sentinelState.capturedPayload?.stats).toMatchObject({
        runId: handoff.runId,
        handoffId: handoff.handoffId,
      });
      if (!supervisor) {
        expect(ownerLease).toHaveBeenCalledWith({ current: true });
        const owner = expectDefined(
          ownerLease.mock.results.at(-1)?.value,
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
        expect(scheduleRestart).not.toHaveBeenCalled();
      } else {
        expect(scheduleRestart).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            reason: "update.run",
            successorOwner: transferHandoff.mock.calls[0]?.[0],
          }),
        );
      }
      expect(guidance).toContain("only on an explicit owner request");
      expect(guidance).toContain("relay the tool's exact recovery instructions");
      expect(guidance).toContain("operator to run outside the Gateway service");
      expect(guidance).toContain(
        "Never run openclaw update, npm install -g openclaw, swap installations, or stop/restart the gateway service via exec or detached jobs.",
      );
    });
  },
);

it.each(["discovery", "acknowledgement", "scheduled admission"] as const)(
  "rechecks authority after awaited %s",
  async (boundary) => {
    const acknowledged = boundary === "acknowledgement";
    const scheduled = boundary === "scheduled admission";
    let active = true;
    detectSupervisor.mockReturnValue(acknowledged ? "launchd" : null);
    const revoke = () => {
      if (scheduled) {
        active = false;
      } else {
        configureOwner(["replacement"]);
      }
    };
    if (acknowledged) {
      notice.mockImplementationOnce(async () => {
        revoke();
        return true;
      });
    } else {
      installStatus.mockImplementationOnce(async () => {
        revoke();
        return {
          root: "/tmp/openclaw",
          status: { root: "/tmp/openclaw", installKind: "git", packageManager: "pnpm" },
          installReceipt: null,
        };
      });
    }

    if (scheduled) {
      const response = await invokeUpdate({}, host.context, () => {
        if (!active) {
          throw new Error("cron update authority is no longer active");
        }
      });
      const summary = summarizeUpdateRunResponse(response);
      expect(summary).toMatchObject({
        ok: false,
        reason: "owner_required",
        message: expect.stringContaining(
          "no longer has a live requester principal or scheduled operator admission",
        ),
      });
      expectOnlyRun({
        ...ownerFailure,
        origin: expect.objectContaining({ nextAction: summary.message }),
      });
      expectNoHandoff();
    } else {
      const result = await runOwnerTool(ownerTool());
      expectOwnerRefusal(result.details, acknowledged);
      expect(notice).toHaveBeenCalledTimes(acknowledged ? 1 : 0);
    }
  },
);
async function runUpdate(
  requester: { channel?: string; senderId?: string } | undefined = {
    channel: "slack",
    senderId: "owner",
  },
): Promise<UpdateRunPayload> {
  setRuntimeConfigSnapshot(config);
  return invokeUpdate(
    {
      requester,
      sessionKey,
      deliveryContext: { channel: "slack", to: "owner" },
    },
    { getRuntimeConfig: () => config },
  );
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
  expectNoUpdate();
}

it.each([
  { source: "chat", restart: true },
  { source: "chat", restart: false },
  { source: "chat", restart: undefined },
  { source: "webchat", restart: false },
  { source: "api", restart: false },
])("honors commands.restart=$restart for $source", async ({ source, restart }) => {
  detectSupervisor.mockReturnValue("launchd");
  globalInstall();
  config = {
    commands: source === "chat" ? { ownerAllowFrom: ["slack:owner"], restart } : { restart },
  };

  const payload = await runUpdate(
    source === "chat" ? undefined : source === "webchat" ? { channel: "webchat" } : {},
  );

  if (source === "chat" && restart === false) {
    expectDisabledUpdate(payload);
    expect(payload.ackDelivered).toBe(false);
    expect(adoptCampaign).not.toHaveBeenCalled();
    expect(notice).not.toHaveBeenCalled();
  } else {
    expectStarted(payload);
  }
});

it.each([false, true])(
  "rechecks current commands.restart after awaited acknowledgement (managed=%s)",
  async (managed) => {
    if (managed) {
      detectSupervisor.mockReturnValue("launchd");
      globalInstall();
    }
    const acknowledgement = createDeferredCore<boolean>();
    const acknowledgementStarted = createDeferredCore();
    notice.mockImplementationOnce(() => {
      acknowledgementStarted.resolve();
      return acknowledgement.promise;
    });
    const running = runUpdate();
    try {
      await Promise.race([acknowledgementStarted.promise, running]);
      expect(notice).toHaveBeenCalledOnce();
      configureOwner(["slack:owner"], false);
    } finally {
      acknowledgement.resolve(true);
      await running;
    }

    const payload = await running;
    expectDisabledUpdate(payload);
    expect(payload.ackDelivered).toBe(true);
    expect(notice).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message:
          "ℹ️ OpenClaw wasn't updated.\nFor details, open Settings → Updates in the Control UI or run `openclaw update status` in your terminal.",
      }),
      expect.any(Object),
    );
  },
);
