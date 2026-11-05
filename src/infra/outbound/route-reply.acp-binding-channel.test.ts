import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import { guardAcpTransportHandoff } from "../../auto-reply/reply/dispatch-acp-delivery-binding.js";
import type {
  AcpDispatchDeliveryParams,
  AcpDispatchDeliveryState,
} from "../../auto-reply/reply/dispatch-acp-delivery.types.js";
import { createAcpToolMessageEditor } from "../../auto-reply/reply/dispatch-acp-tool-edit.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import { installRouteReplyFixture } from "../../auto-reply/reply/route-reply.fixture.test-support.js";
import { routeReply } from "../../auto-reply/reply/route-reply.js";
import { createAcpTestReplyDispatcher } from "../../auto-reply/reply/test-fixtures/acp-runtime.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import { deliverInboundReplyWithMessageSendContextCore } from "../../channels/turn/durable-delivery.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { seedDeliveryQueueEntry } from "../delivery-queue-sqlite.test-support.js";
import { isAcpConversationBindingCurrent } from "./acp-binding-authority.js";
import { PlatformMessageNotDispatchedError } from "./deliver-types.js";
import { deliverOutboundPayloadsInternal } from "./deliver.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import { recoverPendingDeliveries } from "./delivery-queue-recovery.js";
import {
  createRecoveryLog,
  loadPendingDeliveries,
  setQueuedEntryState,
} from "./delivery-queue.test-helpers.js";

const binding = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("./session-binding-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-binding-service.js")>()),
  getSessionBindingService: () => ({ resolveByConversationAsync: async () => binding.current }),
}));

const conversation = { channel: "matrix", accountId: "default", conversationId: "!room" };
const authority = {
  targetSessionKey: "agent:codex-acp:child",
  bindingId: "b1",
  boundAt: 1,
  conversation,
};
const states = {
  bound: { ...authority, targetKind: "session" },
  removed: null,
  reassigned: { ...authority, bindingId: "b2", targetSessionKey: "agent:other:x" },
};
// Live check: the real bindingId/boundAt/target comparison against the binding service.
const liveRevocation = () =>
  Object.assign(async () => !(await isAcpConversationBindingCurrent(authority)), {
    authority: Promise.resolve(authority),
  });

/** Real routeReply / durable queue / recovery / message-action route, test channel transport. */
describe("ACP bound-child replies through the channel route", () => {
  const fixtures = installRouteReplyFixture();
  let visible: string[];
  let edits: string[];
  let failNext: boolean;

  beforeEach(() => {
    [visible, edits, failNext, binding.current] = [[], [], false, states.bound];
    const plugin = {
      ...createOutboundTestPlugin({
        id: "matrix",
        outbound: {
          deliveryMode: "direct",
          deliveryCapabilities: { durableFinal: { text: true, messageSendingHooks: true } },
          sendText: async ({ text }) => {
            if (failNext) {
              failNext = false; // provider refused before accepting: retryable, provably unsent
              throw new PlatformMessageNotDispatchedError("provider unavailable", {
                cause: undefined,
                retryable: true,
              });
            }
            visible.push(text);
            return { channel: "matrix", messageId: `m${visible.length}` };
          },
        },
      }),
      messaging: {
        normalizeTarget: (raw: string) => raw,
        targetResolver: { looksLikeId: () => true },
      },
      actions: {
        describeMessageTool: () => ({ actions: ["edit" as const] }),
        providerOwnedReadGates: ["edit" as const],
        handleAction: async (ctx: { params: Record<string, unknown> }) => {
          edits.push(String(ctx.params.message));
          return jsonResult({ ok: true });
        },
      },
    };
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "matrix", source: "test", origin: "bundled", plugin }]),
    );
  });

  async function send(text: string) {
    const guard = guardAcpTransportHandoff(createAcpTestReplyDispatcher(), liveRevocation());
    const options = await guard!();
    const payload = { text };
    return routeReply({
      cfg: {},
      channel: "matrix",
      to: "!room",
      replyKind: "final",
      mirror: false,
      payload,
      ...options,
    });
  }

  function editToolMessage(text: string, entryCheck = liveRevocation()) {
    const params = {
      cfg: {},
      ctx: { SessionKey: authority.targetSessionKey, AccountId: "default" },
      isUserDeliveryRevoked: entryCheck,
    } as unknown as AcpDispatchDeliveryParams;
    const handle = { channel: "matrix", to: "!room", accountId: "default", messageId: "m1" };
    const state = {
      routedCounts: { tool: 0, block: 0, final: 0 },
      toolMessageByCallId: new Map([["call-1", handle]]),
    } as unknown as AcpDispatchDeliveryState;
    const guard = guardAcpTransportHandoff(createAcpTestReplyDispatcher(), liveRevocation());
    return createAcpToolMessageEditor(params, state, guard)({ text }, "call-1");
  }

  async function restartRecovery() {
    // Simulated restart: drain the on-disk queue with the retry backoff elapsed.
    for (const row of await loadPendingDeliveries(fixtures.tmpDir())) {
      setQueuedEntryState(fixtures.tmpDir(), row.id, {
        retryCount: row.retryCount,
        lastAttemptAt: 1,
        availableAt: 0,
      });
    }
    const log = createRecoveryLog();
    const summary = await recoverPendingDeliveries(
      { cfg: {}, log, stateDir: fixtures.tmpDir(), deliver: async () => [] },
      (params, context) => deliverOutboundPayloadsInternal(params, context),
    );
    return { summary, warnings: log.warn.mock.calls.map(([message]) => message) };
  }

  it.each(Object.keys(states) as (keyof typeof states)[])("routed send, %s", async (state) => {
    binding.current = states[state];
    const result = await send(state);
    console.log(`[proof] routed send ${state}:`, result.ok ? "delivered" : result.error);
    expect(visible).toEqual(state === "bound" ? ["bound"] : []);
  });

  it.each(Object.keys(states) as (keyof typeof states)[])(
    "queued retry, restart, %s",
    async (state) => {
      failNext = true;
      await send("queued retry");
      const [row] = await loadPendingDeliveries(fixtures.tmpDir());
      expect(row?.acpBindingAuthority).toEqual(authority);
      binding.current = states[state];
      const { summary, warnings } = await restartRecovery();
      console.log(`[proof] restart recovery ${state}:`, JSON.stringify(summary), visible, warnings);
      expect(visible).toEqual(state === "bound" ? ["queued retry"] : []);
      expect(summary).toMatchObject(
        state === "bound" ? { recovered: 1 } : { recovered: 0, failed: 1 },
      );
      if (state !== "bound") {
        expect(warnings.join("\n")).toContain("ACP conversation binding was revoked");
      }
    },
  );

  /** Normal same-channel turn: dispatcher hook, then the channel's durable final callback. */
  async function dispatchViaChannelCallback(text: string) {
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) =>
        deliverInboundReplyWithMessageSendContextCore({
          cfg: {},
          channel: "matrix",
          to: "!room",
          agentId: "codex-acp",
          ctxPayload: { SessionKey: authority.targetSessionKey } as FinalizedMsgContext,
          payload,
          info: { kind: "final" },
        }),
      onError: () => {},
    });
    guardAcpTransportHandoff(dispatcher, liveRevocation());
    dispatcher.sendFinalReply({ text });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
  }

  it.each(Object.keys(states) as (keyof typeof states)[])("dispatcher send, %s", async (state) => {
    binding.current = states[state];
    await dispatchViaChannelCallback(state);
    console.log(`[proof] dispatcher send ${state}:`, JSON.stringify(visible));
    expect(visible).toEqual(state === "bound" ? ["bound"] : []);
  });

  it.each(Object.keys(states) as (keyof typeof states)[])(
    "dispatcher durable retry, restart, %s",
    async (state) => {
      failNext = true;
      await dispatchViaChannelCallback("dispatcher retry");
      const [row] = await loadPendingDeliveries(fixtures.tmpDir());
      expect(row?.acpBindingAuthority).toEqual(authority);
      binding.current = states[state];
      const { summary, warnings } = await restartRecovery();
      console.log(`[proof] dispatcher recovery ${state}:`, JSON.stringify(summary), visible);
      expect(visible).toEqual(state === "bound" ? ["dispatcher retry"] : []);
      if (state !== "bound") {
        expect(warnings.join("\n")).toContain("ACP conversation binding was revoked");
      }
    },
  );

  it("recovers a queue entry written before acpBindingAuthority existed", async () => {
    failNext = true;
    await deliverOutboundPayloadsInternal({
      cfg: {},
      channel: "matrix",
      to: "!room",
      payloads: [{ text: "pre-upgrade" }],
    }).catch(() => undefined);
    const [row] = await loadPendingDeliveries(fixtures.tmpDir());
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("acpBindingAuthority");
    binding.current = null; // no binding at all: legacy rows are not ACP-gated
    const { summary } = await restartRecovery();
    console.log("[proof] legacy queue entry:", JSON.stringify(summary), visible);
    expect(summary).toMatchObject({ recovered: 1 });
    expect(visible).toEqual(["pre-upgrade"]);
  });

  it.each(["bound", "removed"] as const)(
    "upgrade: a raw pre-binding (v2026.10.9-shape) row survives recovery, binding %s",
    async (state) => {
      failNext = true;
      await send("upgrade row");
      const [row] = await loadPendingDeliveries(fixtures.tmpDir());
      // Rewrite the on-disk row exactly as an older build stored it: no binding field.
      const { acpBindingAuthority: _dropped, ...legacy } = row!;
      seedDeliveryQueueEntry({
        queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
        entry: legacy,
        stateDir: fixtures.tmpDir(),
      });
      const [reloaded] = await loadPendingDeliveries(fixtures.tmpDir());
      expect(reloaded).not.toHaveProperty("acpBindingAuthority");
      expect(reloaded?.preparedBatch).toEqual(row?.preparedBatch);
      binding.current = states[state];
      const { summary } = await restartRecovery();
      console.log(`[proof] upgrade raw row, binding ${state}:`, JSON.stringify(summary), visible);
      expect(summary).toMatchObject({ recovered: 1 });
      expect(visible).toEqual(["upgrade row"]);
    },
  );

  it.each(Object.keys(states) as (keyof typeof states)[])("tool edit, %s", async (state) => {
    binding.current = states[state];
    await editToolMessage(state);
    console.log(`[proof] tool edit ${state}:`, JSON.stringify(edits));
    expect(edits).toEqual(state === "bound" ? ["bound"] : []);
  });

  it("blocks a tool edit at platform dispatch when unbound after the entry check", async () => {
    binding.current = null;
    const staleEntryCheck = Object.assign(async () => false, {
      authority: Promise.resolve(authority),
    });
    const edited = await editToolMessage("raced", staleEntryCheck);
    console.log("[proof] raced tool edit:", JSON.stringify({ edited, edits }));
    expect(edits).toEqual([]);
  });
});
