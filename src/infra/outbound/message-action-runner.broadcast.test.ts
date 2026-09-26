import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { projectEmbeddedMessageDeliveryFact } from "../../agents/embedded-agent-message-delivery.js";
import { jsonResult } from "../../agents/tools/common.js";
import { createMessageTool } from "../../agents/tools/message-tool-execution.js";
import { chunkText } from "../../auto-reply/chunk.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { formatMessageCliText } from "../../commands/message-format.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createTempHomeEnv, type TempHomeEnv } from "../../test-utils/temp-home.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { resolveMessageActionOutcome } from "./message-action-contracts.js";
import { MessageActionDeniedError } from "./message-action-denial.js";
import { runMessageAction } from "./message-action-runner.js";
import type { OutboundGatewayRequest } from "./message-gateway-options.js";

function registerNativeBroadcastPlugin(actions: NonNullable<ChannelPlugin["actions"]>) {
  const plugin: ChannelPlugin = {
    ...createChannelTestPluginBase({ id: "broadcast-test" }),
    messaging: { targetResolver: { looksLikeId: () => true } },
    outbound: {
      deliveryMode: "direct",
      sendText: async () => {
        throw new Error("native action bypassed");
      },
    },
    actions,
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: plugin.id, plugin, source: "test" }]));
  return plugin;
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

  it.each<{
    name: string;
    payload: Record<string, unknown>;
    ok: boolean;
    sentBeforeError?: true;
  }>([
    {
      name: "native rejection before send",
      payload: { ok: false, error: "rejected before send", sentBeforeError: false },
      ok: false,
    },
    { name: "native suppression", payload: { ok: false, warning: "send suppressed" }, ok: false },
    {
      name: "native partial failure",
      payload: {
        ok: false,
        error: "second part failed",
        sentBeforeError: true,
        messageId: "sent-part",
      },
      ok: false,
      sentBeforeError: true,
    },
    {
      name: "canonical partial status",
      payload: {
        ok: false,
        deliveryStatus: "partial_failed",
        sentBeforeError: true,
        error: "second canonical part failed",
        result: { messageId: "sent-part" },
      },
      ok: false,
      sentBeforeError: true,
    },
    { name: "native success", payload: { ok: true, messageId: "sent-native" }, ok: true },
    { name: "legacy empty success", payload: {}, ok: true },
    {
      name: "nested receipt",
      payload: { ok: true, result: { messageId: "sent-nested" } },
      ok: true,
    },
  ])("preserves $name alongside a successful target", async ({ payload, ok, sentBeforeError }) => {
    const delivered: string[] = [];
    const plugin = registerNativeBroadcastPlugin({
      describeMessageTool: () => ({ actions: ["send"] }),
      supportsAction: ({ action }) => action === "send",
      handleAction: async ({ params }) => {
        delivered.push(String(params.to));
        return jsonResult(params.to === "first" ? payload : { ok: true, messageId: "sent-2" });
      },
    });

    const result = await runMessageAction({
      cfg: {},
      action: "broadcast",
      params: { channel: plugin.id, targets: ["first", "second"], message: "hello" },
    });

    expect(delivered).toEqual(["first", "second"]);
    expect(result).toMatchObject({
      kind: "broadcast",
      payload: {
        results: [
          { to: "first", ok, payload },
          { to: "second", ok: true },
        ],
      },
    });
    expect(resolveMessageActionOutcome(result).ok).toBe(ok);
    expect(formatMessageCliText(result)[0]).toContain(ok ? "2/2 succeeded" : "1/2 succeeded");
    if (result.kind !== "broadcast") {
      throw new Error("Expected broadcast result");
    }
    expect(result.payload.results[0]?.sentBeforeError).toBe(sentBeforeError);
    expect(result.payload.results[0]?.payload).toBe(payload);
  });

  it.each([
    {
      name: "before the in-flight target dispatches",
      dispatchBeforeWait: false,
      failureKind: "cancellation",
      expectedError: "current action canceled",
      failed: 1,
      notAttempted: 1,
    },
    {
      name: "after the in-flight target starts dispatching",
      dispatchBeforeWait: true,
      failureKind: "cancellation",
      expectedError: "current action canceled",
      failed: 1,
      notAttempted: 1,
    },
    {
      name: "after part of the in-flight target was sent",
      dispatchBeforeWait: true,
      failureKind: "cancellation",
      expectedError: "current action canceled",
      sentBeforeError: true,
      failed: 1,
      notAttempted: 1,
    },
    {
      name: "while an adapter without a dispatch callback reports a provider error",
      dispatchBeforeWait: false,
      failureKind: "provider",
      expectedError: "provider request failed",
      failed: 1,
      notAttempted: 1,
    },
    {
      name: "while the in-flight target reports a policy denial",
      dispatchBeforeWait: false,
      failureKind: "policy",
      expectedError: "target policy denied",
      failed: 1,
      notAttempted: 1,
    },
  ] satisfies Array<{
    name: string;
    dispatchBeforeWait: boolean;
    failureKind: "cancellation" | "provider" | "policy";
    expectedError: string;
    failed: number;
    notAttempted: number;
    sentBeforeError?: true;
  }>)("keeps completed results when cancellation arrives $name", async (scenario) => {
    let actionCurrent = true;
    let releaseSecond: () => void = () => undefined;
    const secondStarted = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let enteredSecond: () => void = () => undefined;
    const secondEntered = new Promise<void>((resolve) => {
      enteredSecond = resolve;
    });
    const handled: string[] = [];
    const dispatched: string[] = [];
    const denied: string[] = [];
    const plugin = registerNativeBroadcastPlugin({
      describeMessageTool: () => ({ actions: ["send"] }),
      supportsAction: ({ action }) => action === "send",
      handleAction: async ({ params, assertDirectAdapterHandoff, onPlatformSendDispatch }) => {
        const target = String(params.to);
        handled.push(target);
        const dispatch = async () => {
          await onPlatformSendDispatch?.();
          dispatched.push(target);
        };
        if (target === "first") {
          await dispatch();
          return jsonResult({ ok: true, messageId: "sent-first" });
        }
        if (scenario.dispatchBeforeWait) {
          await dispatch();
        }
        enteredSecond();
        await secondStarted;
        if (scenario.failureKind === "provider") {
          throw new Error(scenario.expectedError);
        }
        if (scenario.failureKind === "policy") {
          throw new MessageActionDeniedError(
            scenario.expectedError,
            "target_policy_denied",
            "target:policy",
          );
        }
        assertDirectAdapterHandoff?.();
        await dispatch();
        return jsonResult({ ok: true, messageId: `sent-${target}` });
      },
    });

    const pending = runMessageAction({
      cfg: {},
      action: "broadcast",
      params: { channel: plugin.id, targets: ["first", "second", "third"], message: "hello" },
      assertDirectAdapterHandoff: () => {
        if (!actionCurrent) {
          throw Object.assign(new Error("current action canceled"), {
            name: "AbortError",
            ...(scenario.sentBeforeError ? { sentBeforeError: true as const } : {}),
          });
        }
      },
      onActionDenied: (err) => denied.push(err.message),
    });
    await secondEntered;
    actionCurrent = false;
    releaseSecond();
    const result = await pending;

    expect(handled).toEqual(["first", "second"]);
    expect(dispatched).toEqual(scenario.dispatchBeforeWait ? ["first", "second"] : ["first"]);
    expect(result).toMatchObject({
      kind: "broadcast",
      payload: {
        results: [
          { to: "first", ok: true, payload: { ok: true, messageId: "sent-first" } },
          { to: "second", ok: false },
          { to: "third", ok: false, attempted: false },
        ],
      },
    });
    if (result.kind !== "broadcast") {
      throw new Error("Expected broadcast result");
    }
    expect(result.payload.results[1]?.sentBeforeError).toBe(scenario.sentBeforeError);
    expect(result.payload.results[1]?.attempted).toBeUndefined();
    expect(result.payload.results[1]?.error).toBe(scenario.expectedError);
    expect(denied).toEqual(scenario.failureKind === "policy" ? [scenario.expectedError] : []);
    expect(result.payload.results.filter((entry) => entry.attempted === false)).toHaveLength(
      scenario.notAttempted,
    );
    expect(projectEmbeddedMessageDeliveryFact(result)).toMatchObject({
      status: "settled",
      partialDelivery: true,
    });
    const cliOutput = formatMessageCliText(result).join("\n");
    expect(cliOutput).toContain(
      `Broadcast incomplete (1/3 succeeded, ${scenario.failed} failed, ${scenario.notAttempted} not attempted)`,
    );
    expect(cliOutput).toContain("not attempted");
  });

  it("marks a native target unattempted when its final host handoff rejects", async () => {
    let actionCurrent = true;
    const handled: string[] = [];
    const plugin = registerNativeBroadcastPlugin({
      describeMessageTool: () => ({ actions: ["send"] }),
      supportsAction: ({ action }) => {
        if (handled.length === 1) {
          actionCurrent = false;
        }
        return action === "send";
      },
      handleAction: async ({ params }) => {
        handled.push(String(params.to));
        return jsonResult({ ok: true, messageId: `sent-${String(params.to)}` });
      },
    });

    const result = await runMessageAction({
      cfg: {},
      action: "broadcast",
      params: { channel: plugin.id, targets: ["first", "second", "third"], message: "hello" },
      assertDirectAdapterHandoff: () => {
        if (!actionCurrent) {
          throw Object.assign(new Error("current action canceled"), { name: "AbortError" });
        }
      },
    });

    expect(handled).toEqual(["first"]);
    expect(result).toMatchObject({
      kind: "broadcast",
      payload: {
        results: [
          { to: "first", ok: true },
          { to: "second", ok: false, attempted: false },
          { to: "third", ok: false, attempted: false },
        ],
      },
    });
  });

  it("marks a gateway target unattempted when the final handoff fence rejects it", async () => {
    let actionCurrent = true;
    let releaseHandoff: () => void = () => undefined;
    const handoffWait = new Promise<void>((resolve) => {
      releaseHandoff = resolve;
    });
    let enterHandoff: () => void = () => undefined;
    const handoffEntered = new Promise<void>((resolve) => {
      enterHandoff = resolve;
    });
    const gatewayTargets: string[] = [];
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({ id: "broadcast-test" }),
      messaging: { targetResolver: { looksLikeId: () => true } },
      outbound: { deliveryMode: "gateway" },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: plugin.id, plugin, source: "test" }]));

    const pending = runMessageAction({
      cfg: {},
      action: "broadcast",
      params: { channel: plugin.id, targets: ["first", "second", "third"], message: "hello" },
      gateway: {
        clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
        request: async <T>(request: OutboundGatewayRequest): Promise<T> => {
          const params = request.params;
          const target = String(
            params && typeof params === "object" && "to" in params ? params.to : "",
          );
          gatewayTargets.push(target);
          return { messageId: `sent-${target}` } as T;
        },
      },
      onPlatformSendDispatch: async () => {
        if (gatewayTargets.length > 0) {
          enterHandoff();
          await handoffWait;
        }
      },
      assertDirectAdapterHandoff: () => {
        if (!actionCurrent) {
          throw Object.assign(new Error("current action canceled"), { name: "AbortError" });
        }
      },
    });
    await handoffEntered;
    actionCurrent = false;
    releaseHandoff();
    const result = await pending;

    expect(gatewayTargets).toEqual(["first"]);
    expect(result).toMatchObject({
      kind: "broadcast",
      payload: {
        results: [
          { to: "first", ok: true },
          { to: "second", ok: false, attempted: false },
          { to: "third", ok: false, attempted: false },
        ],
      },
    });
  });

  it("marks a Gateway-executed action unattempted when its final host handoff rejects", async () => {
    let actionCurrent = true;
    let gatewayRequests = 0;
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({ id: "broadcast-test" }),
      messaging: { targetResolver: { looksLikeId: () => true } },
      outbound: {
        deliveryMode: "direct",
        sendText: async () => {
          throw new Error("Gateway action used core delivery");
        },
      },
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        supportsAction: ({ action }) => action === "send",
        resolveExecutionMode: ({ action }) => {
          if (gatewayRequests === 1) {
            actionCurrent = false;
          }
          return action === "send" ? "gateway" : "local";
        },
        handleAction: async () => {
          throw new Error("Gateway action ran locally");
        },
      },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: plugin.id, plugin, source: "test" }]));

    const result = await runMessageAction({
      cfg: {},
      action: "broadcast",
      params: { channel: plugin.id, targets: ["first", "second", "third"], message: "hello" },
      gateway: {
        clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
        request: async <T>(): Promise<T> => {
          gatewayRequests += 1;
          return { ok: true, messageId: `sent-${gatewayRequests}` } as T;
        },
      },
      assertDirectAdapterHandoff: () => {
        if (!actionCurrent) {
          throw Object.assign(new Error("current action canceled"), { name: "AbortError" });
        }
      },
    });

    expect(gatewayRequests).toBe(1);
    expect(result).toMatchObject({
      kind: "broadcast",
      payload: {
        results: [
          { to: "first", ok: true },
          { to: "second", ok: false, attempted: false },
          { to: "third", ok: false, attempted: false },
        ],
      },
    });
  });

  it.each(
    [undefined, true].flatMap((bestEffort) =>
      [false, true].map((sentBeforeCurrent) => ({ bestEffort, sentBeforeCurrent })),
    ),
  )(
    "stops core delivery after a rejected handoff (bestEffort: $bestEffort, current may have sent: $sentBeforeCurrent)",
    async ({ bestEffort, sentBeforeCurrent }) => {
      let actionCurrent = true;
      let releaseHandoff: () => void = () => undefined;
      const handoffWait = new Promise<void>((resolve) => {
        releaseHandoff = resolve;
      });
      let enterHandoff: () => void = () => undefined;
      const handoffEntered = new Promise<void>((resolve) => {
        enterHandoff = resolve;
      });
      let insideAdapter = false;
      const transported: string[] = [];
      const plugin: ChannelPlugin = {
        ...createChannelTestPluginBase({ id: "broadcast-test" }),
        messaging: { targetResolver: { looksLikeId: () => true } },
        outbound: {
          deliveryMode: "direct",
          ...(sentBeforeCurrent
            ? { chunker: chunkText, chunkerMode: "text" as const, textChunkLimit: 2 }
            : {}),
          sendText: async (context) => {
            insideAdapter = true;
            try {
              await context.onPlatformSendDispatch?.();
              transported.push(context.to);
              return {
                channel: "broadcast-test",
                messageId:
                  sentBeforeCurrent && context.to === "second"
                    ? "unknown"
                    : `sent-${context.to}-${context.text}`,
              };
            } finally {
              insideAdapter = false;
            }
          },
        },
      };
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: plugin.id, plugin, source: "test" }]),
      );

      const pending = runMessageAction({
        cfg: {},
        action: "broadcast",
        params: {
          channel: plugin.id,
          targets: ["first", "second", "third"],
          message: sentBeforeCurrent ? "abcd" : "hello",
          ...(bestEffort === undefined ? {} : { bestEffort }),
        },
        onPlatformSendDispatch: async () => {
          if (
            (sentBeforeCurrent
              ? transported.filter((target) => target === "second").length === 1
              : transported.length > 0) &&
            !insideAdapter
          ) {
            enterHandoff();
            await handoffWait;
          }
        },
        assertDirectAdapterHandoff: () => {
          if (!actionCurrent) {
            throw Object.assign(new Error("current action canceled"), { name: "AbortError" });
          }
        },
      });
      await handoffEntered;
      actionCurrent = false;
      releaseHandoff();
      const result = await pending;

      expect(transported).toEqual(sentBeforeCurrent ? ["first", "first", "second"] : ["first"]);
      expect(result).toMatchObject({
        kind: "broadcast",
        payload: {
          results: [
            { to: "first", ok: true },
            {
              to: "second",
              ok: false,
              ...(sentBeforeCurrent ? { sentBeforeError: true } : { attempted: false }),
            },
            { to: "third", ok: false, attempted: false },
          ],
        },
      });
    },
  );

  it.each([undefined, true])(
    "keeps a failed first core target after its platform dispatch (bestEffort: %s)",
    async (bestEffort) => {
      let actionCurrent = true;
      let releaseProvider: () => void = () => undefined;
      const providerWait = new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });
      let enterProvider: () => void = () => undefined;
      const providerEntered = new Promise<void>((resolve) => {
        enterProvider = resolve;
      });
      const attempted: string[] = [];
      const plugin: ChannelPlugin = {
        ...createChannelTestPluginBase({ id: "broadcast-test" }),
        messaging: { targetResolver: { looksLikeId: () => true } },
        outbound: {
          deliveryMode: "direct",
          sendText: async (context) => {
            attempted.push(context.to);
            await context.onPlatformSendDispatch?.();
            enterProvider();
            await providerWait;
            throw new Error("provider result unknown");
          },
        },
      };
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: plugin.id, plugin, source: "test" }]),
      );

      const pending = runMessageAction({
        cfg: {},
        action: "broadcast",
        params: {
          channel: plugin.id,
          targets: ["first", "second"],
          message: "hello",
          ...(bestEffort === undefined ? {} : { bestEffort }),
        },
        assertDirectAdapterHandoff: () => {
          if (!actionCurrent) {
            throw Object.assign(new Error("current action canceled"), { name: "AbortError" });
          }
        },
      });
      await providerEntered;
      actionCurrent = false;
      releaseProvider();
      const result = await pending;

      expect(attempted).toEqual(["first"]);
      expect(result).toMatchObject({
        kind: "broadcast",
        payload: {
          results: [
            { to: "first", ok: false, error: "provider result unknown", sentBeforeError: true },
            { to: "second", ok: false, attempted: false },
          ],
        },
      });
    },
  );

  it("still rejects cancellation after a normalized first-target failure", async () => {
    let actionCurrent = true;
    let releaseFailure: () => void = () => undefined;
    const failureWait = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    let enterFailure: () => void = () => undefined;
    const failureEntered = new Promise<void>((resolve) => {
      enterFailure = resolve;
    });
    const handled: string[] = [];
    const plugin = registerNativeBroadcastPlugin({
      describeMessageTool: () => ({ actions: ["send"] }),
      supportsAction: ({ action }) => action === "send",
      handleAction: async ({ params }) => {
        handled.push(String(params.to));
        enterFailure();
        await failureWait;
        return jsonResult({ ok: false, error: "provider rejected message" });
      },
    });

    const pending = runMessageAction({
      cfg: {},
      action: "broadcast",
      params: { channel: plugin.id, targets: ["first", "second"], message: "hello" },
      assertDirectAdapterHandoff: () => {
        if (!actionCurrent) {
          throw Object.assign(new Error("current action canceled"), { name: "AbortError" });
        }
      },
    });
    await failureEntered;
    actionCurrent = false;
    releaseFailure();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(handled).toEqual(["first"]);
  });

  it("returns accepted rows through the message tool after turn cancellation", async () => {
    let releaseSecond: () => void = () => undefined;
    const secondWait = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let enterSecond: () => void = () => undefined;
    const secondEntered = new Promise<void>((resolve) => {
      enterSecond = resolve;
    });
    const plugin = registerNativeBroadcastPlugin({
      describeMessageTool: () => ({ actions: ["send"] }),
      supportsAction: ({ action }) => action === "send",
      handleAction: async ({ params, onPlatformSendDispatch }) => {
        const target = String(params.to);
        if (target === "second") {
          await onPlatformSendDispatch?.();
          enterSecond();
          await secondWait;
          return jsonResult({ ok: true, messageId: `sent-${target}` });
        }
        await onPlatformSendDispatch?.();
        return jsonResult({ ok: true, messageId: `sent-${target}` });
      },
    });
    const runId = "broadcast-cancel-tool";
    const sessionKey = "agent:main:broadcast-cancel-tool";
    const sessionId = "broadcast-cancel-tool-session";
    const capability = mintMessageActionTurnCapability({
      agentId: "main",
      runId,
      sessionKey,
      sessionId,
    });
    try {
      const tool = createMessageTool({
        agentId: "main",
        runId,
        agentSessionKey: sessionKey,
        sessionId,
        messageActionTurnCapability: capability,
        config: {},
      });
      const pending = tool.execute("broadcast-cancel-call", {
        action: "broadcast",
        channel: plugin.id,
        targets: ["first", "second", "third"],
        message: "hello",
      });
      await secondEntered;
      revokeMessageActionTurnCapability(capability);
      releaseSecond();
      const result = await pending;

      expect(result.details).toMatchObject({
        results: [
          { to: "first", ok: true },
          { to: "second", ok: true },
          { to: "third", ok: false, attempted: false },
        ],
        messageDelivery: {
          status: "settled",
          partialDelivery: true,
        },
      });
    } finally {
      revokeMessageActionTurnCapability(capability);
    }
  });

  it.each([false, true])(
    "still rejects cancellation when the first destination dispatch started: %s",
    async (dispatchBeforeWait) => {
      let actionCurrent = true;
      let release: () => void = () => undefined;
      const pendingDispatch = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered: () => void = () => undefined;
      const enteredDispatch = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const dispatched: string[] = [];
      const plugin = registerNativeBroadcastPlugin({
        describeMessageTool: () => ({ actions: ["send"] }),
        supportsAction: ({ action }) => action === "send",
        handleAction: async ({ assertDirectAdapterHandoff, onPlatformSendDispatch }) => {
          if (dispatchBeforeWait) {
            await onPlatformSendDispatch?.();
            dispatched.push("only");
          }
          entered();
          await pendingDispatch;
          assertDirectAdapterHandoff?.();
          return jsonResult({ ok: true });
        },
      });

      const pending = runMessageAction({
        cfg: {},
        action: "broadcast",
        params: { channel: plugin.id, targets: ["only"], message: "hello" },
        assertDirectAdapterHandoff: () => {
          if (!actionCurrent) {
            throw Object.assign(new Error("current action canceled"), { name: "AbortError" });
          }
        },
      });
      await enteredDispatch;
      actionCurrent = false;
      release();

      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(dispatched).toEqual(dispatchBeforeWait ? ["only"] : []);
    },
  );

  it("derives stable idempotency keys for each target on one provider", async () => {
    const attempts: string[][] = [[], []];
    let invocation = 0;
    const plugin = registerNativeBroadcastPlugin({
      describeMessageTool: () => ({ actions: ["send"] }),
      supportsAction: ({ action }) => action === "send",
      handleAction: async ({ params }) => {
        attempts[invocation]?.push(String(params.idempotencyKey));
        return jsonResult({ ok: true, messageId: params.to });
      },
    });

    const send = async () =>
      await runMessageAction({
        cfg: {},
        action: "broadcast",
        params: {
          channel: plugin.id,
          targets: ["first", "second"],
          message: "hello",
          idempotencyKey: "broadcast-root",
        },
        messageActionAuthorization: {
          scheduled: { policy: { version: 1, mode: "trusted" }, assertCurrent: () => {} },
        },
      });
    await send();
    invocation = 1;
    await send();

    expect(new Set(attempts[0]).size).toBe(2);
    expect(attempts[1]).toEqual(attempts[0]);
  });
});
