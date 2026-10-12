import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { projectEmbeddedMessageDeliveryFact } from "../../agents/embedded-agent-message-delivery.js";
import { jsonResult } from "../../agents/tools/common.js";
import { createMessageTool } from "../../agents/tools/message-tool-execution.js";
import { chunkText } from "../../auto-reply/chunk.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { formatMessageCliText } from "../../commands/message-format.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import type * as ConfirmedVisibleMessage from "../../sessions/background-session-result.js";
import {
  createChannelTestPluginBase,
  createOutboundTestPlugin,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createTempHomeEnv, type TempHomeEnv } from "../../test-utils/temp-home.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import {
  resolveMessageActionOutcome,
  type MessageActionInput,
  type MessageActionResult,
} from "./message-action-contracts.js";
import { MessageActionDeniedError } from "./message-action-denial.js";
import { runMessageAction } from "./message-action-runner.js";
import { workspaceConfig, workspaceTestPlugin } from "./message-action-runner.test-support.js";
import type { OutboundGatewayRequest } from "./message-gateway-options.js";

// Broadcast cancellation owns delivery outcomes, not destination transcript storage.
vi.mock("../../sessions/background-session-result.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ConfirmedVisibleMessage>()),
  commitConfirmedVisibleMessage: vi.fn(async () => ({ ok: true })),
}));

const channel = "broadcast-test";
const gateway = {
  clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
  mode: GATEWAY_CLIENT_MODES.BACKEND,
};
const notAttempted = { ok: false, attempted: false };
const stoppedAfterFirst = [
  { to: "first", ok: true },
  { to: "second", ...notAttempted },
  { to: "third", ...notAttempted },
];
function registerPlugin(overrides: Pick<ChannelPlugin, "outbound" | "actions">) {
  const plugin: ChannelPlugin = {
    ...createChannelTestPluginBase({ id: channel }),
    messaging: { targetResolver: { looksLikeId: () => true } },
    ...overrides,
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: channel, plugin, source: "test" }]));
}
type Actions = NonNullable<ChannelPlugin["actions"]>;
function registerNative(actions: Omit<Actions, "describeMessageTool">) {
  registerPlugin({
    outbound: {
      deliveryMode: "direct",
      sendText: async () => {
        throw new Error("native action bypassed");
      },
    },
    actions: {
      describeMessageTool: () => ({ actions: ["send"] }),
      supportsAction: ({ action }) => action === "send",
      ...actions,
    },
  });
}
function broadcast(input: Omit<Partial<MessageActionInput>, "cfg" | "action"> = {}) {
  return runMessageAction({
    cfg: {},
    action: "broadcast",
    ...input,
    params: { channel, targets: ["first", "second", "third"], message: "hello", ...input.params },
  });
}
function expectResults(result: MessageActionResult, results: Record<string, unknown>[]) {
  expect(result).toMatchObject({ kind: "broadcast", payload: { results } });
  if (result.kind !== "broadcast") {
    throw new Error("Expected broadcast result");
  }
  return result.payload.results;
}
function cancellationGate(sentBeforeError?: true) {
  const entered = createDeferred();
  const release = createDeferred();
  const gate = {
    current: true,
    assertCurrent: () => {
      if (!gate.current) {
        throw Object.assign(new Error("current action canceled"), {
          name: "AbortError",
          ...(sentBeforeError ? { sentBeforeError } : {}),
        });
      }
    },
    async wait() {
      entered.resolve();
      await release.promise;
    },
    async cancel() {
      await entered.promise;
      gate.current = false;
      release.resolve();
    },
  };
  return gate;
}

describe("broadcast send outcomes through native actions", () => {
  let tempHome: TempHomeEnv;
  beforeAll(async () => {
    tempHome = await createTempHomeEnv("openclaw-broadcast-outcomes-");
  });
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });
  afterAll(async () => {
    await tempHome.restore();
  });

  it.each([
    { name: "partial send", sentBeforeError: true, error: "current action canceled" },
    { name: "policy denial", sentBeforeError: undefined, error: "target policy denied" },
  ] as const)("keeps completed results on cancellation during a $name", async (scenario) => {
    const gate = cancellationGate(scenario.sentBeforeError);
    const handled: string[] = [],
      dispatched: string[] = [],
      denied: string[] = [];
    registerNative({
      handleAction: async ({ params, assertDirectAdapterHandoff, onPlatformSendDispatch }) => {
        const target = String(params.to);
        handled.push(target);
        if (target === "first" || scenario.sentBeforeError) {
          await onPlatformSendDispatch?.();
          dispatched.push(target);
        }
        if (target === "first") {
          return jsonResult({ ok: true, messageId: "sent-first" });
        }
        await gate.wait();
        if (!scenario.sentBeforeError) {
          throw new MessageActionDeniedError(
            scenario.error,
            "target_policy_denied",
            "target:policy",
          );
        }
        assertDirectAdapterHandoff?.();
        await onPlatformSendDispatch?.();
        dispatched.push(target);
        return jsonResult({ ok: true, messageId: `sent-${target}` });
      },
    });
    const pending = broadcast({
      assertDirectAdapterHandoff: gate.assertCurrent,
      onActionDenied: (err) => denied.push(err.message),
    });
    await gate.cancel();
    const result = await pending;
    expect(resolveMessageActionOutcome(result).ok).toBe(false);
    expect(handled).toEqual(["first", "second"]);
    expect(dispatched).toEqual(scenario.sentBeforeError ? ["first", "second"] : ["first"]);
    const rows = expectResults(result, [
      { to: "first", ok: true, payload: { ok: true, messageId: "sent-first" } },
      { to: "second", ok: false },
      { to: "third", ...notAttempted },
    ]);
    expect(rows[1]?.sentBeforeError).toBe(scenario.sentBeforeError);
    expect(rows[1]?.attempted).toBeUndefined();
    expect(rows[1]?.error).toBe(scenario.error);
    expect(denied).toEqual(scenario.sentBeforeError ? [] : [scenario.error]);
    expect(projectEmbeddedMessageDeliveryFact(result)).toMatchObject({
      status: "settled",
      partialDelivery: true,
    });
    expect(formatMessageCliText(result).join("\n")).toContain(
      "Broadcast incomplete (1/3 succeeded, 1 failed, 1 not attempted)",
    );
  });

  it("fences the final core Gateway handoff", async () => {
    const gate = cancellationGate();
    const targets: string[] = [];
    registerPlugin({ outbound: { deliveryMode: "gateway" } });
    const pending = broadcast({
      gateway: {
        ...gateway,
        request: async <T>(request: OutboundGatewayRequest): Promise<T> => {
          const params = request.params;
          const target = String(
            params && typeof params === "object" && "to" in params ? params.to : "",
          );
          targets.push(target);
          return { messageId: `sent-${target}` } as T;
        },
      },
      onPlatformSendDispatch: async () => {
        if (targets.length > 0) {
          await gate.wait();
        }
      },
      assertDirectAdapterHandoff: gate.assertCurrent,
    });
    await gate.cancel();
    expectResults(await pending, stoppedAfterFirst);
    expect(targets).toEqual(["first"]);
  });

  it.each(["local", "gateway"] as const)("fences the final %s action handoff", async (mode) => {
    const gate = cancellationGate();
    const handled: string[] = [];
    const retireAfterFirst = () => {
      if (handled.length === 1) {
        gate.current = false;
      }
    };
    registerNative({
      ...(mode === "local"
        ? {
            supportsAction: ({ action }) => {
              retireAfterFirst();
              return action === "send";
            },
          }
        : {
            resolveExecutionMode: ({ action }) => {
              retireAfterFirst();
              return action === "send" ? "gateway" : "local";
            },
          }),
      handleAction: async ({ params }) => {
        if (mode === "gateway") {
          throw new Error("Gateway action ran locally");
        }
        handled.push(String(params.to));
        return jsonResult({ ok: true, messageId: `sent-${String(params.to)}` });
      },
    });
    const result = await broadcast({
      ...(mode === "gateway"
        ? {
            gateway: {
              ...gateway,
              request: async <T>(): Promise<T> => {
                handled.push("request");
                return { ok: true, messageId: `sent-${handled.length}` } as T;
              },
            },
          }
        : {}),
      assertDirectAdapterHandoff: gate.assertCurrent,
    });
    expect(handled).toEqual(mode === "local" ? ["first"] : ["request"]);
    expectResults(result, stoppedAfterFirst);
  });

  it.each([false, true])("fences core delivery (partial send: %s)", async (partial) => {
    const gate = cancellationGate();
    let insideAdapter = false;
    const transported: string[] = [];
    registerPlugin({
      outbound: {
        deliveryMode: "direct",
        ...(partial ? { chunker: chunkText, chunkerMode: "text" as const, textChunkLimit: 2 } : {}),
        sendText: async (context) => {
          insideAdapter = true;
          try {
            await context.onPlatformSendDispatch?.();
            transported.push(context.to);
            return {
              channel,
              messageId:
                partial && context.to === "second"
                  ? "unknown"
                  : `sent-${context.to}-${context.text}`,
            };
          } finally {
            insideAdapter = false;
          }
        },
      },
    });
    const pending = broadcast({
      params: {
        message: partial ? "abcd" : "hello",
        bestEffort: partial ? undefined : true,
      },
      onPlatformSendDispatch: async () => {
        if (
          (partial
            ? transported.filter((target) => target === "second").length === 1
            : transported.length > 0) &&
          !insideAdapter
        ) {
          await gate.wait();
        }
      },
      assertDirectAdapterHandoff: gate.assertCurrent,
    });
    await gate.cancel();
    expectResults(await pending, [
      { to: "first", ok: true },
      {
        to: "second",
        ok: false,
        ...(partial ? { sentBeforeError: true } : { attempted: false }),
      },
      { to: "third", ...notAttempted },
    ]);
    expect(transported).toEqual(partial ? ["first", "first", "second"] : ["first"]);
  });

  it("retains an uncertain first core delivery", async () => {
    const gate = cancellationGate();
    const attempted: string[] = [];
    registerPlugin({
      outbound: {
        deliveryMode: "direct",
        sendText: async (context) => {
          attempted.push(context.to);
          await context.onPlatformSendDispatch?.();
          await gate.wait();
          throw new Error("provider result unknown");
        },
      },
    });
    const pending = broadcast({
      params: { targets: ["first", "second"], bestEffort: true },
      assertDirectAdapterHandoff: gate.assertCurrent,
    });
    await gate.cancel();
    expectResults(await pending, [
      { to: "first", ok: false, error: "provider result unknown", sentBeforeError: true },
      { to: "second", ...notAttempted },
    ]);
    expect(attempted).toEqual(["first"]);
  });

  it("rejects cancellation with no accepted targets", async () => {
    const gate = cancellationGate();
    const handled: string[] = [];
    registerNative({
      handleAction: async ({ params }) => {
        handled.push(String(params.to));
        await gate.wait();
        return jsonResult({ ok: false, error: "provider rejected message" });
      },
    });
    const pending = broadcast({
      params: { targets: ["first", "second"] },
      assertDirectAdapterHandoff: gate.assertCurrent,
    });
    await gate.cancel();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(handled).toEqual(["first"]);
  });

  it("retains accepted message-tool results after cancellation", async () => {
    const entered = createDeferred(),
      release = createDeferred();
    registerNative({
      handleAction: async ({ params, onPlatformSendDispatch }) => {
        const target = String(params.to);
        await onPlatformSendDispatch?.();
        if (target === "second") {
          entered.resolve();
          await release.promise;
        }
        return jsonResult({ ok: true, messageId: `sent-${target}` });
      },
    });
    const identity = {
      agentId: "main",
      runId: "broadcast-cancel-tool",
      sessionKey: "agent:main:broadcast-cancel-tool",
      sessionId: "broadcast-cancel-tool-session",
    };
    const capability = mintMessageActionTurnCapability(identity);
    try {
      const tool = createMessageTool({
        ...identity,
        agentSessionKey: identity.sessionKey,
        messageActionTurnCapability: capability,
        config: {},
      });
      const pending = tool.execute("broadcast-cancel-call", {
        action: "broadcast",
        channel,
        targets: ["first", "second", "third"],
        message: "hello",
      });
      await entered.promise;
      revokeMessageActionTurnCapability(capability);
      release.resolve();
      expect((await pending).details).toMatchObject({
        results: [
          { to: "first", ok: true },
          { to: "second", ok: true },
          { to: "third", ...notAttempted },
        ],
        messageDelivery: { status: "settled", partialDelivery: true },
      });
    } finally {
      revokeMessageActionTurnCapability(capability);
    }
  });

  it("keeps per-target idempotency keys stable", async () => {
    const attempts: string[][] = [[], []];
    let invocation = 0;
    registerNative({
      handleAction: async ({ params }) => {
        attempts[invocation]?.push(String(params.idempotencyKey));
        return jsonResult({ ok: true, messageId: params.to });
      },
    });
    const send = () =>
      broadcast({
        params: { targets: ["first", "second"], idempotencyKey: "broadcast-root" },
        messageActionAuthorization: {
          scheduled: { policy: { version: 1, mode: "trusted" }, assertCurrent: () => {} },
        },
      });
    expect(resolveMessageActionOutcome(await send()).ok).toBe(true);
    invocation = 1;
    await send();
    expect(new Set(attempts[0]).size).toBe(2);
    expect(attempts[1]).toEqual(attempts[0]);
  });
  it("delivers media captions through core send", async () => {
    const receipt = { channel: "testchat", messageId: "m1", chatId: "c1" };
    const sendMedia = vi.fn().mockResolvedValue(receipt);
    const plugin = createOutboundTestPlugin({
      id: "testchat",
      outbound: {
        deliveryMode: "direct",
        sendText: vi.fn().mockResolvedValue({ ...receipt, messageId: "t1" }),
        sendMedia,
      },
    });
    setActivePluginRegistry(createTestRegistry([{ pluginId: plugin.id, source: "test", plugin }]));
    await runMessageAction({
      cfg: { channels: { testchat: { enabled: true } } } as OpenClawConfig,
      action: "send",
      params: {
        channel: "testchat",
        target: "channel:abc",
        media: "https://example.com/cat.png",
        caption: "caption-only text",
      },
      dryRun: false,
    });

    expect(sendMedia).toHaveBeenCalledOnce();
    expect(sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "caption-only text",
        mediaUrl: "https://example.com/cat.png",
      }),
    );
  });
  const sourceInput = {
    cfg: {},
    action: "send",
    params: { message: "telegram reply" },
    sessionKey: "agent:main:telegram:direct:123456789",
    sourceReplyDeliveryMode: "message_tool_only",
  } as const;
  function expectInternalReply(result: MessageActionResult, text: string) {
    expect(result).toMatchObject({
      kind: "send",
      channel: "webchat",
      to: "current-run",
      handledBy: "internal-source",
      dryRun: false,
      payload: { deliveryStatus: "sent", sourceReplySink: "internal-ui", sourceReply: { text } },
    });
    if (result.kind !== "send") {
      throw new Error("Expected send result");
    }
    expect(result.toolResult?.details).toMatchObject({
      sourceReply: { text },
      message: text,
      sourceReplyDeliveryMode: "message_tool_only",
    });
    expect(result.toolResult?.content).toEqual([
      {
        type: "text",
        text: "Sent visible reply to the current source conversation via internal-ui.",
      },
    ]);
    expect(JSON.stringify(result.toolResult?.content)).not.toContain(text);
  }
  describe("runMessageAction send validation", () => {
    beforeEach(() => {
      setActivePluginRegistry(
        createTestRegistry([
          { pluginId: "workspace", source: "test", plugin: workspaceTestPlugin },
        ]),
      );
    });

    it.each([
      { provider: "webchat", sessionKey: "agent:voice:agent:channel:room", context: {} },
      {
        provider: "telegram",
        sessionKey: sourceInput.sessionKey,
        context: { currentChannelId: "user:123456789", currentMessageId: 98765 },
      },
    ])(
      "delivers a sanitized private reply for $provider",
      async ({ provider, sessionKey, context }) => {
        const result = await runMessageAction({
          ...sourceInput,
          sessionKey,
          params: { message: "hello citeturn2view0" },
          toolContext: { currentChannelProvider: provider, ...context },
        });
        expectInternalReply(result, "hello");
        expect(JSON.stringify(result.payload)).not.toContain("turn2view0");
      },
    );

    it("reports a route-less message-tool-only reply as a transcript record", async () => {
      const result = await runMessageAction({
        ...sourceInput,
        sessionKey: "agent:main:main",
        sourceReplyTranscriptOnly: true,
        toolContext: { currentChannelProvider: "webchat" },
      });

      if (result.kind !== "send") {
        throw new Error("Expected send result");
      }
      expect(result).toMatchObject({ handledBy: "internal-source", to: "current-run" });
      expect(result.toolResult?.content).toEqual([
        {
          type: "text",
          text: "Recorded reply in the current session transcript via internal-ui. This send did not deliver it to an external channel.",
        },
      ]);
    });

    it("sends an explicit target from a route-less run through the channel", async () => {
      const result = await runMessageAction({
        cfg: {
          ...workspaceConfig,
          tools: { message: { crossContext: { allowAcrossProviders: true } } },
        },
        action: "send",
        params: { channel: "workspace", target: "#C12345678", message: "hello from codex" },
        toolContext: { currentChannelProvider: "webchat" },
        sessionKey: "agent:main:main",
        sourceReplyDeliveryMode: "message_tool_only",
        sourceReplyTranscriptOnly: true,
      });

      expect(result).toMatchObject({
        kind: "send",
        channel: "workspace",
        handledBy: "core",
        dryRun: false,
      });
    });

    it.each([
      {
        name: "private source without an address",
        input: { ...sourceInput, toolContext: { currentChannelProvider: "telegram" } },
        denial: { reasonCode: "message_target_missing", policyRef: "message-target:required" },
        message: /requires a target/i,
      },
      {
        name: "disabled broadcast",
        input: {
          cfg: { tools: { message: { broadcast: { enabled: false } } } },
          action: "broadcast",
          params: { targets: ["qa-channel:direct:one"], message: "hello" },
        },
        denial: {
          reasonCode: "message_broadcast_disabled",
          policyRef: "message-broadcast:enabled",
        },
      },
      {
        name: "broadcast targets used as a send target",
        input: {
          cfg: {},
          action: "send",
          params: {
            action: "send",
            idempotencyKey: "run:message:1",
            targets: ["user:123456789"],
            message: "hello from codex",
          },
        },
        message: /requires a target/i,
      },
    ] satisfies Array<{
      name: string;
      input: MessageActionInput;
      denial?: { reasonCode: string; policyRef: string };
      message?: RegExp;
    }>)("rejects $name", async ({ input, denial, message }) => {
      const failure = runMessageAction(input);
      if (denial) {
        await expect(failure).rejects.toBeInstanceOf(MessageActionDeniedError);
        await expect(failure).rejects.toMatchObject(denial);
      }
      if (message) {
        await expect(failure).rejects.toThrow(message);
      }
    });

    it.each([false, true])(
      "checks explicit-route provider policy (allowed=%s)",
      async (allowAcrossProviders) => {
        const send = runMessageAction({
          cfg: {
            ...workspaceConfig,
            tools: { message: { crossContext: { allowAcrossProviders } } },
          },
          action: "send",
          params: {
            channel: "workspace",
            target: "#C12345678",
            message: "hello from codex",
          },
          toolContext: {
            currentChannelProvider: "webchat",
          },
          sessionKey: "agent:main:main",
          sourceReplyDeliveryMode: "message_tool_only",
          dryRun: true,
        });

        if (!allowAcrossProviders) {
          await expect(send).rejects.toMatchObject({
            reasonCode: "message_cross_context_denied",
            policyRef: "message-cross-context:provider",
          });
          return;
        }
        const result = await send;
        expect(result).toMatchObject({
          kind: "send",
          channel: "workspace",
          handledBy: "core",
          dryRun: true,
        });
      },
    );
  });
});
