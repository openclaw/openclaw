import { expect, it, vi } from "vitest";
import { tryFastAbortFromMessage } from "./abort.js";
import { buildTestCtx } from "./test-ctx.js";

vi.mock("../../agents/subagents/registry/subagent-control.js", () => {
  throw new Error("ordinary messages must not initialize cancellation owners");
});

it.each(["continue the conversation", "[example] /stop", "Ada: /stop"])(
  "keeps ordinary group text outside cancellation runtime: %j",
  async (body) => {
    await expect(
      tryFastAbortFromMessage({
        ctx: buildTestCtx({ CommandBody: body, ChatType: "group" }),
        cfg: {},
      }),
    ).resolves.toEqual({ handled: false, aborted: false });
  },
);
