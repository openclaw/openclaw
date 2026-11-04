import { expect, it } from "vitest";
import { extractGroupMeta } from "./chat-message-timestamp-view.tsx";
import { createAssistantMessage, createMessageGroup } from "./chat-message.test-support.ts";

// One Claude CLI turn of two model calls: counters sum both, the marker keeps the last call.
const turnUsage = { input: 4, output: 89, cacheRead: 74_593, cacheWrite: 74_918 };

function contextPercent(usage: Record<string, unknown>) {
  const group = createMessageGroup(createAssistantMessage("done", { usage }), "assistant");
  return extractGroupMeta(group, 200_000)?.contextPercent;
}

it("sizes context from the marker when usage counters cover a whole turn", () => {
  const contextUsage = { state: "available", promptTokens: 74_920, totalTokens: 74_921 };
  expect(contextPercent({ ...turnUsage, contextUsage })).toBe(37);
});

it.each([undefined, { total: 0 }, { input: 0.2 }, { total: 0.5 }])(
  "preserves chat cost coverage %j",
  (cost) => {
    const group = createMessageGroup(
      createAssistantMessage("done", { usage: { input: 1, cost } }),
      "assistant",
    );
    expect(extractGroupMeta(group, null)?.cost).toBe(
      cost && "total" in cost ? cost.total : undefined,
    );
  },
);

it.each([0, 0.5])("retains billed %s even when token accounting is unavailable", (total) => {
  const usage = {
    usageReport: { state: "unavailable" },
    cost: { total, totalOrigin: "provider-billed" },
  };
  const group = createMessageGroup(createAssistantMessage("done", { usage }), "assistant");
  expect(extractGroupMeta(group, null)).toMatchObject({ usageUnavailable: true, cost: total });
  const estimated = createMessageGroup(
    createAssistantMessage("done", {
      usage: { ...usage, cost: { total } },
    }),
    "assistant",
  );
  expect(extractGroupMeta(estimated, null)?.cost).toBeUndefined();
});
