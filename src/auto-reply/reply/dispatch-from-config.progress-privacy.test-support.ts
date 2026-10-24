import { expect, it, vi } from "vitest";
import {
  createDispatcher,
  emptyConfig,
  sessionStoreMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  automaticGroupReplyConfig,
  dispatchReplyFromConfig,
  setNoAbort,
} from "./dispatch-from-config.test-support.js";
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

function quietSession(deny = false) {
  setNoAbort();
  sessionStoreMocks.currentEntry = {
    verboseLevel: "off",
    ...(deny ? { sendPolicy: "deny" as const } : {}),
  };
  return createDispatcher();
}

function expectNoAutomaticReply(dispatcher: ReturnType<typeof createDispatcher>) {
  expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
  expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
}

export function registerProgressPrivacyTests() {
  it.each([
    { surface: "telegram", mentioned: false },
    { surface: "telegram", mentioned: true },
    { surface: "discord", mentioned: false },
    { surface: "discord", mentioned: true },
  ])(
    "keeps optional $surface draft progress private (mentioned: $mentioned)",
    async ({ surface, mentioned }) => {
      const dispatcher = quietSession();
      const onItemEvent = vi.fn(),
        onToolStart = vi.fn(),
        onPlanUpdate = vi.fn();
      await dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: surface,
          Surface: surface,
          ChatType: "group",
          From: `${surface}:group:fixture`,
          SessionKey: `agent:main:${surface}:group:fixture`,
          WasMentioned: mentioned,
        }),
        cfg: {
          ...automaticGroupReplyConfig,
          agents: { defaults: { silentReply: { group: "allow" } } },
        },
        dispatcher,
        replyOptions: {
          ...suppressedProgress,
          progressRequiresReply: true,
          onItemEvent,
          onToolStart,
          onPlanUpdate,
        },
        replyResolver: async (_ctx, opts) => {
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
          return undefined;
        },
      });
      for (const callback of [onItemEvent, onToolStart, onPlanUpdate]) {
        expect(callback).toHaveBeenCalledTimes(mentioned ? 1 : 0);
      }
      expectNoAutomaticReply(dispatcher);
    },
  );

  it.each([false, true])(
    "gates channel-owned native progress when send policy denies delivery: %s",
    async (deny) => {
      const dispatcher = quietSession(deny);
      const onToolStart = vi.fn(),
        onItemEvent = vi.fn(),
        onCommandOutput = vi.fn(),
        onToolResult = vi.fn();
      let commentaryEnabled: boolean | undefined;
      await dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "telegram",
          Surface: "telegram",
          ChatType: deny ? "direct" : "group",
          From: deny ? "telegram:123" : "telegram:group:-100123",
          SessionKey: deny ? "agent:main:telegram:dm:123" : "agent:main:telegram:group:-100123",
        }),
        cfg: deny ? emptyConfig : automaticGroupReplyConfig,
        dispatcher,
        replyResolver: async (_ctx, opts) => {
          commentaryEnabled = opts?.commentaryProgressEnabled;
          await opts?.onToolStart?.(toolStart);
          await opts?.onItemEvent?.(toolItem);
          if (deny) {
            await opts?.onItemEvent?.(modelWait);
          }
          await opts?.onCommandOutput?.(commandOutput);
          await opts?.onToolResult?.({ text: "exec: ok" });
          return { text: "done" };
        },
        replyOptions: {
          ...suppressedProgress,
          onToolStart,
          onItemEvent,
          onCommandOutput,
          ...(!deny ? { onToolResult } : {}),
        },
      });
      if (deny) {
        for (const callback of [onToolStart, onItemEvent, onCommandOutput]) {
          expect(callback).not.toHaveBeenCalled();
        }
        expect(commentaryEnabled).toBeUndefined();
      } else {
        expect(onToolStart).toHaveBeenCalledWith(toolStart);
        expect(onItemEvent).toHaveBeenCalledWith(toolItem);
        expect(onCommandOutput).toHaveBeenCalledWith(commandOutput);
        expect(onToolResult).not.toHaveBeenCalled();
      }
      expectNoAutomaticReply(dispatcher);
    },
  );

  it("keeps local model wait status transient when quiet channel progress is hidden", async () => {
    const dispatcher = quietSession();
    const onItemEvent = vi.fn();
    let itemEventHandlerPresent = false;
    const waitEnd = { itemId: "model-wait", kind: "model-wait", phase: "end" } as const;
    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        ChatType: "direct",
        SessionKey: "agent:main:telegram:dm:123",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async (_ctx, opts) => {
        itemEventHandlerPresent = Boolean(opts?.onItemEvent);
        await opts?.onItemEvent?.({ kind: "preamble", progressText: "Checking first" });
        await opts?.onItemEvent?.(modelWait);
        await opts?.onItemEvent?.(waitEnd);
        return { text: "Final answer" };
      },
      replyOptions: { onItemEvent, progressPreambleEnabled: true },
    });
    expect(itemEventHandlerPresent).toBe(true);
    expect(onItemEvent.mock.calls.map(([payload]) => payload)).toEqual([modelWait, waitEnd]);
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "Final answer" });
  });
}
