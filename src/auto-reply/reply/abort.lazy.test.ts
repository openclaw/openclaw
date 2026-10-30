import { expect, it, vi } from "vitest";
import { tryFastAbortFromMessage } from "./abort.js";
import { buildTestCtx } from "./test-ctx.js";

vi.mock("../../agents/subagents/registry/subagent-control.js", () => {
  throw new Error("ordinary messages must not initialize cancellation owners");
});

it("keeps ordinary group messages outside cancellation runtime", async () => {
  await expect(
    tryFastAbortFromMessage({
      ctx: buildTestCtx({ CommandBody: "continue the conversation", ChatType: "group" }),
      cfg: {},
    }),
  ).resolves.toEqual({ handled: false, aborted: false });
});
