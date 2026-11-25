import { describe, expect, it } from "vitest";
import { createQueueTestRun } from "../queue.test-helpers.js";
import { resolveFollowupDeliveryStorageKey } from "./delivery-context.js";

describe("followup delivery context", () => {
  it("separates runs with different gateway client capabilities", () => {
    const withoutCaps = createQueueTestRun({ prompt: "without caps" });
    const withInlineWidgets = createQueueTestRun({ prompt: "with inline widgets" });
    withInlineWidgets.run.clientCaps = ["inline-widgets"];

    expect(resolveFollowupDeliveryStorageKey(withoutCaps)).not.toBe(
      resolveFollowupDeliveryStorageKey(withInlineWidgets),
    );
  });

  it("never collect-batches runs bound to different tool targets", () => {
    const first = createQueueTestRun({ prompt: "first" });
    first.run.toolBindings = { browser: { kind: "tab", targetId: "tab-a" } };
    const second = createQueueTestRun({ prompt: "second" });
    second.run.toolBindings = { browser: { kind: "tab", targetId: "tab-b" } };

    expect(resolveFollowupDeliveryStorageKey(first)).not.toBe(
      resolveFollowupDeliveryStorageKey(second),
    );
  });

  it("separates runs with different parent policy provenance", () => {
    const first = createQueueTestRun({ prompt: "first" });
    first.run.spawnedBy = "agent:main:telegram:group:first";
    const second = createQueueTestRun({ prompt: "second" });
    second.run.spawnedBy = "agent:main:telegram:group:second";

    expect(resolveFollowupDeliveryStorageKey(first)).not.toBe(
      resolveFollowupDeliveryStorageKey(second),
    );
  });
});
