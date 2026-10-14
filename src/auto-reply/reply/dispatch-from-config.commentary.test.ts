import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { GetReplyOptions } from "../types.js";
import {
  createDispatcher,
  emptyConfig,
  sessionStoreMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  setNoAbort,
} from "./dispatch-from-config.test-support.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);

describe("durable commentary delivery", () => {
  beforeEach(describe0BeforeEach0);

  it.each([
    { surface: "telegram", verbose: "on" },
    { surface: "discord", verbose: "on" },
    { surface: "slack", verbose: "on" },
    { surface: "telegram", verbose: "off" },
  ] as const)(
    "delivers each $surface preamble once before the answer with verbose $verbose",
    async ({ surface, verbose }) => {
      setNoAbort();
      sessionStoreMocks.currentEntry = { verboseLevel: verbose };
      const dispatcher = createDispatcher();
      const visible: string[] = [];
      dispatcher.appendBeforeDeliver?.((payload, info) => {
        visible.push(`${info.kind}:${payload.text}`);
        return payload;
      });
      let callbacks: GetReplyOptions | undefined;

      await dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: surface,
          Surface: surface,
          ChatType: "direct",
          SessionKey: `agent:main:${surface}:direct:U1`,
        }),
        cfg: emptyConfig,
        dispatcher,
        replyOptions: {
          preserveProgressCallbackStartOrder: true,
          onToolStart: async () => false,
          onPartialReply: () => {
            visible.push("preview:Done.");
          },
        },
        replyResolver: async (_ctx, options) => {
          callbacks = options;
          const preamble = {
            kind: "preamble",
            itemId: "inspect",
            progressText: "Inspecting files.",
          };
          await options?.onItemEvent?.({ ...preamble, phase: "update" });
          await options?.onToolStart?.({ name: "read", phase: "start" });
          await options?.onItemEvent?.({ ...preamble, phase: "end" });
          const tool = options?.onToolResult?.({ text: "Read" });
          await options?.onItemEvent?.({
            kind: "preamble",
            itemId: "summary",
            progressText: "Writing the answer.",
            phase: "end",
          });
          await options?.onPartialReply?.({ text: "Done." });
          await tool;
          return { text: "Done." };
        },
      });

      const progress = visible.filter((entry) => entry.startsWith("tool:"));
      expect(progress.toSorted()).toEqual(
        verbose === "on"
          ? ["tool:Read", "tool:💬 Inspecting files.", "tool:💬 Writing the answer."].toSorted()
          : [],
      );
      expect(visible.slice(-2)).toEqual(["preview:Done.", "final:Done."]);
      await callbacks?.onItemEvent?.({
        kind: "preamble",
        itemId: "late",
        progressText: "Too late.",
      });
      await callbacks?.onToolResult?.({ text: "Late tool summary" });
      await dispatcher.waitForIdle();
      expect(visible.slice(-2)).toEqual(["preview:Done.", "final:Done."]);
    },
  );
});
