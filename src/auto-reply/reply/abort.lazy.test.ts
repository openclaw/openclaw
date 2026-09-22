import { expect, it, vi } from "vitest";
import { buildTestCtx } from "./test-ctx.js";

vi.mock("../../agents/subagents/registry/subagent-control.js", () => {
  throw new Error("ordinary messages must not initialize cancellation owners");
});

it.each(["direct", "group"])(
  "keeps %s ordinary messages outside cancellation runtime",
  async (chatType) => {
    const { tryFastAbortFromMessage } = await import("./abort.js");
    await expect(
      tryFastAbortFromMessage({
        ctx: buildTestCtx({ CommandBody: "continue the conversation", ChatType: chatType }),
        cfg: {},
      }),
    ).resolves.toEqual({ handled: false, aborted: false });
  },
);
