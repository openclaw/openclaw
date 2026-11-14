import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { GetReplyOptions } from "../types.js";
import * as fixture from "./dispatch-from-config.shared.test-harness.js";
import * as dispatch from "./dispatch-from-config.test-support.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(dispatch.globalBeforeAll0);
beforeEach(() => {
  dispatch.describe0BeforeEach0();
  dispatch.setNoAbort();
});
const preamble = (itemId: string, progressText: string, phase?: "update" | "end") => ({
  kind: "preamble",
  itemId,
  progressText,
  ...(phase ? { phase } : {}),
});

it.each([
  { surface: "webchat", verbose: "off" },
  { surface: "telegram", verbose: "on" },
  { surface: "discord", verbose: "on" },
  { surface: "slack", verbose: "on" },
  { surface: "telegram", verbose: "off" },
] as const)("delivers $surface progress with verbose $verbose", async ({ surface, verbose }) => {
  const webchat = surface === "webchat";
  fixture.sessionStoreMocks.currentEntry = { verboseLevel: verbose };
  const dispatcher = fixture.createDispatcher();
  const onItemEvent = vi.fn(async () => true);
  const visible: string[] = [];
  if (!webchat) {
    dispatcher.appendBeforeDeliver?.((payload, info) => {
      visible.push(`${info.kind}:${payload.text}`);
      return payload;
    });
  }
  let callbacks: GetReplyOptions | undefined;
  await dispatch.dispatchReplyFromConfig({
    ctx: buildTestCtx({
      Provider: surface,
      Surface: surface,
      SessionKey: webchat ? "agent:main:main" : `agent:main:${surface}:direct:U1`,
    }),
    cfg: fixture.emptyConfig,
    dispatcher,
    replyOptions: webchat
      ? {
          progressRequiresReply: true,
          suppressDefaultToolProgressMessages: true,
          onItemEvent,
        }
      : {
          preserveProgressCallbackStartOrder: true,
          onToolStart: async () => false,
          onPartialReply: () => {
            visible.push("preview:Done.");
          },
        },
    replyResolver: async (_ctx, options) => {
      callbacks = options;
      if (webchat) {
        await options?.onItemEvent?.({ kind: "tool", name: "read", status: "running" });
      } else {
        await options?.onItemEvent?.(preamble("inspect", "Inspecting files.", "update"));
        await options?.onToolStart?.({ name: "read", phase: "start" });
        await options?.onItemEvent?.(preamble("inspect", "Inspecting files.", "end"));
        const tool = options?.onToolResult?.({ text: "Read" });
        await options?.onItemEvent?.(preamble("summary", "Writing the answer.", "end"));
        await options?.onPartialReply?.({ text: "Done." });
        await tool;
      }
      return { text: "Done." };
    },
  });
  if (webchat) {
    expect(onItemEvent).toHaveBeenCalledExactlyOnceWith({
      kind: "tool",
      name: "read",
      status: "running",
    });
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Done." }),
    );
    return;
  }
  expect(visible.filter((entry) => entry.startsWith("tool:")).toSorted()).toEqual(
    verbose === "on"
      ? ["tool:Read", "tool:💬 Inspecting files.", "tool:💬 Writing the answer."].toSorted()
      : [],
  );
  expect(visible.slice(-2)).toEqual(["preview:Done.", "final:Done."]);
  await callbacks?.onItemEvent?.(preamble("late", "Too late."));
  await callbacks?.onToolResult?.({ text: "Late tool summary" });
  await dispatcher.waitForIdle();
  expect(visible.slice(-2)).toEqual(["preview:Done.", "final:Done."]);
});
