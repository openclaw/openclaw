import { describe, expect, it } from "vitest";
import { createQueueCase } from "./queue.case.test-support.js";
import { createQueueTestRun, installQueueRuntimeErrorSilencer } from "./queue.test-helpers.js";
import { createOverflowSummaryRetrySource } from "./queue/delivery-context.js";

installQueueRuntimeErrorSilencer();

function source(prompt: string, messageId: string, causalMessageId = messageId) {
  return { ...createQueueTestRun({ prompt, messageId }), causalMessageId };
}

describe("causal identity through the followup queue", () => {
  it("keeps each ordinary followup's own causal id", async () => {
    const q = createQueueCase({ mode: "followup" }, 2);
    q.add(source("first", "routing-A", "inbound-A"));
    q.add(source("second", "routing-B", "inbound-B"));
    await q.drain();
    expect(q.calls.map((run) => run.causalMessageId)).toEqual(["inbound-A", "inbound-B"]);
  });

  it.each([1, 2])(
    "preserves routing and only single-source causal identity (%s sources)",
    async (count) => {
      const q = createQueueCase();
      for (let i = 1; i <= count; i++) q.add(source(`work-${i}`, `route-${i}`, `causal-${i}`));
      await q.drain();
      expect(q.calls).toHaveLength(1);
      expect(q.calls[0]?.messageId).toBe(`route-${count}`);
      expect(q.calls[0]?.causalMessageId).toBe(count === 1 ? "causal-1" : undefined);
    },
  );

  it("withholds causal identity from synthetic overflow and its retry source", async () => {
    const q = createQueueCase({ cap: 1 }, 2);
    q.add(source("dropped", "route-old", "causal-old"));
    q.add(source("surviving", "route-new", "causal-new"));
    await q.drain();
    const overflow = q.calls.find((run) => run.prompt.includes("[Queue overflow]"));
    expect(overflow).toBeDefined();
    expect(overflow?.causalMessageId).toBeUndefined();
    expect(q.calls.find((run) => !run.prompt.includes("[Queue overflow]"))?.causalMessageId).toBe(
      "causal-new",
    );
    expect(createOverflowSummaryRetrySource(source("retry", "route", "causal"))).not.toHaveProperty(
      "causalMessageId",
    );
  });

  it.each(["old", "new"] as const)(
    "never transfers a %s-dropped source's causal metadata",
    async (dropPolicy) => {
      const q = createQueueCase({ mode: "followup", cap: 1, dropPolicy });
      q.add(source("old", "route-old", "causal-old"));
      q.add(source("new", "route-new", "causal-new"));
      await q.drain();
      expect(q.calls[0]?.causalMessageId).toBe(dropPolicy === "old" ? "causal-new" : "causal-old");
    },
  );

  it("keeps existing message-id dedupe independent from causal metadata", async () => {
    const sameRoute = createQueueCase({ mode: "followup" });
    expect(sameRoute.add(source("first", "same-route", "causal-A"))).toBe(true);
    expect(sameRoute.add(source("duplicate", "same-route", "causal-B"))).toBe(false);
    await sameRoute.drain();
    const distinctRoutes = createQueueCase({ mode: "followup" }, 2);
    expect(distinctRoutes.add(source("one", "route-A", "same-causal"))).toBe(true);
    expect(distinctRoutes.add(source("two", "route-B", "same-causal"))).toBe(true);
    await distinctRoutes.drain();
    expect(distinctRoutes.calls).toHaveLength(2);
  });
});
