import { expect, it, vi } from "vitest";
import * as harness from "./dispatch-from-config.shared.test-harness.js";
import * as dispatch from "./dispatch-from-config.test-support.js";
import { buildTestCtx } from "./test-ctx.js";

const suppressedProgress = {
  sourceReplyDeliveryMode: "message_tool_only",
  suppressDefaultToolProgressMessages: true,
  allowProgressCallbacksWhenSourceDeliverySuppressed: true,
} as const;
const toolStart = { name: "exec", phase: "start" } as const;
const toolItem = { itemId: "1", kind: "tool", progressText: "running exec" } as const;
const commandOutput = { phase: "end", name: "exec", status: "ok", exitCode: 0 } as const;
const modelWait = {
  itemId: "model-wait",
  kind: "model-wait",
  phase: "update",
  progressText: "Waiting for the local model to respond",
} as const;
const directContext = (from = "telegram:123") =>
  buildTestCtx({
    Provider: "telegram",
    Surface: "telegram",
    ChatType: "direct",
    From: from,
    SessionKey: "agent:main:telegram:dm:123",
  });

function quietSession(deny = false) {
  dispatch.setNoAbort();
  harness.sessionStoreMocks.currentEntry = {
    verboseLevel: "off",
    ...(deny ? { sendPolicy: "deny" as const } : {}),
  };
  return harness.createDispatcher();
}

function expectNoAutomaticReply(dispatcher: ReturnType<typeof harness.createDispatcher>) {
  expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
  expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
}

export function registerProgressPrivacyTests() {
  it.each([
    { surface: "telegram", mentioned: false, deny: false },
    { surface: "discord", mentioned: true, deny: false },
    { surface: "telegram", mentioned: true, deny: true },
  ])(
    "gates $surface draft progress (mentioned: $mentioned, denied: $deny)",
    async ({ surface, mentioned, deny }) => {
      const dispatcher = quietSession(deny);
      const onItemEvent = vi.fn(),
        onToolStart = vi.fn(),
        onPlanUpdate = vi.fn(),
        onCommandOutput = vi.fn();
      let commentaryEnabled: boolean | undefined;
      await dispatch.dispatchReplyFromConfig({
        ctx: deny
          ? directContext()
          : buildTestCtx({
              Provider: surface,
              Surface: surface,
              ChatType: "group",
              From: `${surface}:group:fixture`,
              SessionKey: `agent:main:${surface}:group:fixture`,
              WasMentioned: mentioned,
            }),
        cfg: deny
          ? harness.emptyConfig
          : {
              ...dispatch.automaticGroupReplyConfig,
              agents: { defaults: { silentReply: { group: "allow" } } },
            },
        dispatcher,
        replyOptions: {
          ...suppressedProgress,
          progressRequiresReply: !deny,
          onItemEvent,
          onToolStart,
          onPlanUpdate,
          onCommandOutput,
        },
        replyResolver: async (_ctx, opts) => {
          commentaryEnabled = opts?.commentaryProgressEnabled;
          await opts?.onItemEvent?.({
            itemId: "preamble",
            kind: "preamble",
            phase: "end",
            progressText: "Inspecting the request",
          });
          await opts?.onToolStart?.(toolStart);
          await opts?.onPlanUpdate?.({
            phase: "update",
            steps: [{ step: "Inspect", status: "in_progress" }],
          });
          await opts?.onCommandOutput?.(commandOutput);
          if (deny) {
            await opts?.onItemEvent?.(toolItem);
            await opts?.onItemEvent?.(modelWait);
            await opts?.onToolResult?.({ text: "exec: ok" });
          }
          return deny ? { text: "done" } : undefined;
        },
      });
      for (const callback of [onItemEvent, onToolStart, onPlanUpdate, onCommandOutput]) {
        expect(callback).toHaveBeenCalledTimes(mentioned && !deny ? 1 : 0);
      }
      if (deny) {
        expect(commentaryEnabled).toBeUndefined();
      }
      expectNoAutomaticReply(dispatcher);
    },
  );

  it("keeps local model wait status transient when quiet channel progress is hidden", async () => {
    const dispatcher = quietSession();
    const onItemEvent = vi.fn();
    const waitEnd = { itemId: "model-wait", kind: "model-wait", phase: "end" } as const;
    await dispatch.dispatchReplyFromConfig({
      ctx: directContext("whatsapp:+1000"),
      cfg: harness.emptyConfig,
      dispatcher,
      replyResolver: async (_ctx, opts) => {
        await opts?.onItemEvent?.({ kind: "preamble", progressText: "Checking first" });
        await opts?.onItemEvent?.(modelWait);
        await opts?.onItemEvent?.(waitEnd);
        return { text: "Final answer" };
      },
      replyOptions: { onItemEvent, progressPreambleEnabled: true },
    });
    expect(onItemEvent.mock.calls.map(([payload]) => payload)).toEqual([modelWait, waitEnd]);
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "Final answer" });
  });
}
