// Joined current-source proof: synthetic Gateway/Discord transport, never live receipts.
import { beforeAll, beforeEach, afterEach, afterAll, expect, it, vi } from "vitest";
import { handleUpdateCommand } from "../../src/auto-reply/reply/commands-update.js";
import { buildCommandTestParams } from "../../src/auto-reply/reply/commands.test-harness.js";
import {
  describe0BeforeEach0,
  globalBeforeAll0,
  dispatchReplyFromConfig,
  setNoAbort,
} from "../../src/auto-reply/reply/dispatch-from-config.test-support.js";
import { resolveReplyOperationRunState } from "../../src/auto-reply/reply/reply-operation-run-state.js";
import { buildTestCtx } from "../../src/auto-reply/reply/test-ctx.js";
import { setActivePluginRegistry } from "../../src/plugins/runtime.js";
import {
  createOutboundTestPlugin,
  createTestRegistry,
} from "../../src/test-utils/channel-plugins.js";
import { useSessionStoreTempDirs } from "../../src/test-utils/session-state-cleanup.js";
const stateDirs = useSessionStoreTempDirs(afterAll, "discord-update-ack-");
const gateway = vi.hoisted(() => ({ dispatch: vi.fn(), sendBatch: vi.fn(), context: {} }));
// mock-isolation: keep external message transport synthetic while exercising real SQLite custody.
vi.mock("../../src/channels/message/runtime.js", () => ({
  sendDurableMessageBatchCore: gateway.sendBatch,
}));
// mock-isolation: replace the running Gateway boundary with deterministic update.run responses.
vi.mock("../../src/gateway/server-plugin-in-process-dispatch.js", () => ({
  dispatchGatewayMethodInProcess: gateway.dispatch,
  getInProcessGatewayRequestContext: () => gateway.context,
}));
type DiscordNativeReplyModule = Awaited<
  ReturnType<typeof import("../../extensions/discord/test-api.js").loadDiscordNativeAgentReply>
>;
let adapter: DiscordNativeReplyModule["dispatchDiscordNativeAgentReply"];
beforeAll(async () => {
  await globalBeforeAll0();
  const { loadDiscordNativeAgentReply } = await import("../../extensions/discord/test-api.js");
  adapter = (await loadDiscordNativeAgentReply()).dispatchDiscordNativeAgentReply;
});
beforeEach(() => {
  describe0BeforeEach0();
  setNoAbort();
  gateway.dispatch.mockReset();
});
afterEach(async () => {
  (
    await import("../../src/sessions/session-controller.test-support.js")
  ).testing.resetSessionControllerForTest();
  (await import("../../src/auto-reply/reply/inbound-dedupe.js")).resetInboundDedupe();
  await (await import("../../src/state/openclaw-state-db.js")).closeOpenClawStateDatabaseAsync();
  vi.unstubAllEnvs();
});
it.each(["delivered", "pending", "noack"] as const)("joined current update %s", async (mode) => {
  const trace: unknown[] = [];
  const stateDir = stateDirs.make();
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const { captureDeliveryQueueStateContext } =
    await import("../../src/infra/delivery-queue-state-context.js");
  const { findDeliveryIntentOwner, markDeliveryPlatformSendAttemptStarted } =
    await import("../../src/infra/outbound/delivery-queue-storage.js");
  const { sendGatewayLifecycleNotice, enqueueRestartSentinelNotice } =
    await import("../../src/gateway/server-restart-sentinel-notice.js");
  const queueContext = captureDeliveryQueueStateContext(stateDir);
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "discord",
        source: "test",
        plugin: createOutboundTestPlugin({
          id: "discord",
          outbound: {
            deliveryMode: "direct",
            sendText: async () => {
              throw new Error("unexpected external transport");
            },
          },
        }),
      },
    ]),
  );
  gateway.sendBatch.mockImplementation(async (request) => {
    await markDeliveryPlatformSendAttemptStarted(request.deliveryQueueId, stateDir);
    trace.push({
      stage: "synthetic-lifecycle-transport",
      action: "accepted",
      id: "synthetic-receipt",
    });
    return { status: "sent", results: [{ channel: "discord", messageId: "synthetic-receipt" }] };
  });
  const cfg = {
    commands: { text: true },
    channels: { discord: { dmPolicy: "open" as const, allowFrom: ["*"] } },
  };
  gateway.dispatch.mockImplementation(async (method) => {
    trace.push({ stage: "synthetic-gateway", method, mode });
    if (mode === "noack") {
      throw new Error("synthetic Gateway transport refused");
    }
    const notice = {
      cfg,
      channel: "discord",
      to: "synthetic-channel",
      message: "Synthetic update acknowledgement",
      deps: {},
      deliveryIntentId: `update-run-ack:proof-${mode}`,
    };
    if (mode === "pending") {
      await enqueueRestartSentinelNotice(
        { ...notice, sessionKey: `agent:main:discord:dm:proof-${mode}`, revision: 1 },
        queueContext,
      );
    }
    const ackDelivered = await sendGatewayLifecycleNotice(notice, queueContext);
    const custody = await findDeliveryIntentOwner(notice.deliveryIntentId, undefined, queueContext);
    trace.push({ stage: "real-lifecycle-owner", ackDelivered, custody });
    expect(custody?.status).toBe(mode === "pending" ? "pending" : "completed");
    return {
      ok: true,
      runId: "synthetic-proof-run",
      ackDelivered,
      ackQueued: custody?.status === "pending" || custody?.status === "completed",
      handoff: { status: "started" },
    };
  });
  const interaction = {
    responseState: "deferred",
    deleteReply: vi.fn(async () => {
      interaction.responseState = "replied";
      trace.push({ stage: "discord-transport", action: "deleteReply" });
    }),
    followUp: vi.fn(async (body) => {
      interaction.responseState = "replied";
      trace.push({ stage: "discord-transport", action: "followUp", body });
    }),
    editReply: vi.fn(async (body) => {
      trace.push({ stage: "discord-transport", action: "editReply", body });
    }),
  };
  const ctx = buildTestCtx({
    Provider: "discord",
    Surface: "discord",
    SessionKey: `agent:main:discord:dm:proof-${mode}`,
    Body: "/update",
    CommandBody: "/update",
    CommandAuthorized: true,
  });
  let result: Awaited<ReturnType<typeof dispatchReplyFromConfig>> | undefined;
  await adapter({
    cfg,
    discordConfig: cfg.channels.discord,
    accountId: "default",
    interaction: interaction as never,
    ctxPayload: ctx as never,
    effectiveRoute: { agentId: "main", accountId: "default", sessionKey: ctx.SessionKey! },
    channelConfig: null,
    mediaLocalRoots: [],
    pluginCommandDispatch: { kind: "non-plugin" },
    log: { error: vi.fn() } as never,
    dispatchReplyFromConfig: async (args) => {
      result = await dispatchReplyFromConfig({
        ...args,
        replyResolver: async (_ctx, opts) => {
          const params = buildCommandTestParams("/update", cfg, ctx);
          params.sessionKey = ctx.SessionKey!;
          params.opts = opts;
          Object.assign(params.command, {
            surface: "discord",
            channel: "discord",
            senderIsOwner: true,
            isAuthorizedSender: true,
            senderId: "synthetic-owner",
          });
          const command = await handleUpdateCommand(params, true);
          trace.push({
            stage: "producer-completion",
            completion: resolveReplyOperationRunState(opts)?.replyCompletion,
            reply: command?.reply,
          });
          return command?.reply;
        },
      });
      trace.push({ stage: "core-finalizer", result });
      return result;
    },
  });
  console.log("REAL_PROOF_TRACE", JSON.stringify({ mode, trace }));
  expect(gateway.dispatch).toHaveBeenCalledOnce();
  expect(interaction.responseState).toBe("replied");
  if (mode === "noack") {
    expect(result?.replyDelivery).not.toBe("pending");
    expect(JSON.stringify(trace)).toContain("Couldn't confirm the update");
    expect(interaction.deleteReply).not.toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ content: expect.stringContaining("Couldn't confirm the update") }),
    );
    expect(result?.counts.final).toBe(1);
  } else {
    expect(result?.replyDelivery).toBe(mode);
    expect(result?.counts).toEqual({ tool: 0, block: 0, final: 0 });
    expect(result?.observedReplyDelivery).toBeUndefined();
    expect(interaction.deleteReply).toHaveBeenCalledOnce();
    expect(interaction.followUp).not.toHaveBeenCalled();
    expect(interaction.editReply).not.toHaveBeenCalled();
  }
  expect(JSON.stringify(trace)).not.toContain("Command produced no visible reply");
});
