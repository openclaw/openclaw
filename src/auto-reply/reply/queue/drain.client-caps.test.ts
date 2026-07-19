import { describe, expect, it } from "vitest";
import type { FollowupRun } from "../queue.js";
import { enqueueFollowupRun } from "../queue.js";
import { createDeferred, createQueueTestRun } from "../queue.test-helpers.js";
import { resolveFollowupDeliveryContextKey, scheduleFollowupDrain } from "./drain.js";

type CapabilityOverrides = Pick<
  FollowupRun["run"],
  "approvalReviewerDeviceId" | "clientCaps" | "toolBindings"
>;

describe("followup delivery context", () => {
  it("separates runs with different gateway client capabilities", () => {
    const withoutCaps = createQueueTestRun({ prompt: "without caps" });
    const withInlineWidgets = createQueueTestRun({ prompt: "with inline widgets" });
    withInlineWidgets.run.clientCaps = ["inline-widgets"];

    expect(resolveFollowupDeliveryContextKey(withoutCaps)).not.toBe(
      resolveFollowupDeliveryContextKey(withInlineWidgets),
    );
  });

  it("normalizes capability order and duplicates", () => {
    const first = createQueueTestRun({ prompt: "first" });
    first.run.clientCaps = ["tool-events", "inline-widgets"];
    const second = createQueueTestRun({ prompt: "second" });
    second.run.clientCaps = ["inline-widgets", "tool-events", "inline-widgets"];

    expect(resolveFollowupDeliveryContextKey(first)).toBe(
      resolveFollowupDeliveryContextKey(second),
    );
  });

  it("never collect-batches runs bound to different tool targets", () => {
    const first = createQueueTestRun({ prompt: "first" });
    first.run.toolBindings = { browser: { kind: "tab", targetId: "tab-a" } };
    const second = createQueueTestRun({ prompt: "second" });
    second.run.toolBindings = { browser: { kind: "tab", targetId: "tab-b" } };

    expect(resolveFollowupDeliveryContextKey(first)).not.toBe(
      resolveFollowupDeliveryContextKey(second),
    );
  });

  it("canonicalizes equivalent tool bindings", () => {
    const first = createQueueTestRun({ prompt: "first" });
    first.run.toolBindings = { browser: { targetId: "tab-a", kind: "tab" } };
    const second = createQueueTestRun({ prompt: "second" });
    second.run.toolBindings = { browser: { kind: "tab", targetId: "tab-a" } };

    expect(resolveFollowupDeliveryContextKey(first)).toBe(
      resolveFollowupDeliveryContextKey(second),
    );
  });

  it("retains only a digest of capability-bearing context", () => {
    const run = createQueueTestRun({ prompt: "private capability context" });
    run.run.approvalReviewerDeviceId = "reviewer-private";
    run.run.toolBindings = { browser: { kind: "tab", targetId: "target-private" } };

    const key = resolveFollowupDeliveryContextKey(run);

    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).not.toContain("reviewer-private");
    expect(key).not.toContain("target-private");
  });

  it.each<{
    first: Partial<CapabilityOverrides>;
    name: string;
    second: Partial<CapabilityOverrides>;
  }>([
    {
      name: "client capabilities",
      first: { clientCaps: ["tool-events"] },
      second: { clientCaps: ["tool-events", "inline-widgets"] },
    },
    {
      name: "tool bindings",
      first: { toolBindings: { browser: { kind: "tab", targetId: "tab-a" } } },
      second: { toolBindings: { browser: { kind: "tab", targetId: "tab-b" } } },
    },
    {
      name: "approval reviewer device",
      first: { approvalReviewerDeviceId: "device-a" },
      second: { approvalReviewerDeviceId: "device-b" },
    },
  ])("drains differing $name as separate collect runs", async ({ first, second }) => {
    const key = `test-collect-capability-${Date.now()}-${Math.random()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const settings = { mode: "collect" as const, debounceMs: 0 };
    const firstRun = createQueueTestRun({ prompt: "first" });
    Object.assign(firstRun.run, first);
    const secondRun = createQueueTestRun({ prompt: "second" });
    Object.assign(secondRun.run, second);

    enqueueFollowupRun(key, firstRun, settings);
    enqueueFollowupRun(key, secondRun, settings);
    scheduleFollowupDrain(key, async (run) => {
      calls.push(run);
      if (calls.length === 2) {
        done.resolve();
      }
    });
    await done.promise;

    expect(calls).toHaveLength(2);
    expect(calls[0]?.prompt).toContain("first");
    expect(calls[0]?.prompt).not.toContain("second");
    expect(calls[1]?.prompt).toContain("second");
    expect(calls[1]?.prompt).not.toContain("first");
  });

  it("separates runs with different parent policy provenance", () => {
    const first = createQueueTestRun({ prompt: "first" });
    first.run.spawnedBy = "agent:main:telegram:group:first";
    const second = createQueueTestRun({ prompt: "second" });
    second.run.spawnedBy = "agent:main:telegram:group:second";

    expect(resolveFollowupDeliveryContextKey(first)).not.toBe(
      resolveFollowupDeliveryContextKey(second),
    );
  });
});
