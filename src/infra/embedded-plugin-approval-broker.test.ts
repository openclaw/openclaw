import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddedPluginApprovalBroker } from "./embedded-plugin-approval-broker.js";

function requestPayload() {
  return {
    title: "Apply workspace skill proposal",
    description: "Apply a pending workspace skill proposal into live workspace skills.",
    toolName: "skill_workshop",
    sessionKey: "agent:main:main",
    allowedDecisions: ["allow-once"] as const,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("EmbeddedPluginApprovalBroker", () => {
  it("lists, emits, and resolves pending approvals", async () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const broker = new EmbeddedPluginApprovalBroker((event) => {
      events.push(event);
    });

    const resultPromise = broker.request({
      request: requestPayload(),
      timeoutMs: 5_000,
    });
    const approval = expectDefined(
      broker.listPending()[0],
      "broker.listPending()[0] test invariant",
    );

    expect(approval.approvalKind).toBe("plugin");
    expect(approval?.request.toolName).toBe("skill_workshop");
    expect(events[0]).toEqual({
      event: "plugin.approval.requested",
      payload: approval,
    });
    expect(broker.resolve(approval?.id, "allow-once")).toBe(true);
    await expect(resultPromise).resolves.toMatchObject({ decision: "allow-once" });
    expect(broker.listPending()).toEqual([]);
    expect(events[1]).toMatchObject({
      event: "plugin.approval.resolved",
      payload: { id: approval?.id, decision: "allow-once" },
    });
  });

  it("rejects decisions outside the request decision set", async () => {
    const broker = new EmbeddedPluginApprovalBroker();
    const resultPromise = broker.request({
      request: requestPayload(),
      timeoutMs: 5_000,
    });
    const approval = expectDefined(
      broker.listPending()[0],
      "broker.listPending()[0] test invariant",
    );

    expect(broker.resolve(approval?.id, "allow-always")).toBe(false);
    broker.stop();
    await expect(resultPromise).rejects.toThrow("embedded plugin approval broker stopped");
  });

  it("keeps deny available as the canonical fail-closed decision", async () => {
    const broker = new EmbeddedPluginApprovalBroker();
    const resultPromise = broker.request({
      request: requestPayload(),
      timeoutMs: 5_000,
    });
    const approval = expectDefined(
      broker.listPending()[0],
      "broker.listPending()[0] test invariant",
    );

    expect(broker.resolve(approval?.id, "deny")).toBe(true);
    await expect(resultPromise).resolves.toMatchObject({ decision: "deny" });
  });

  it.each(["timeout", "abort"])("removes pending approvals on %s", async (cause) => {
    vi.useFakeTimers();
    const events: Array<{ event: string; payload: unknown }> = [];
    const broker = new EmbeddedPluginApprovalBroker((event) => {
      events.push(event);
    });
    const controller = new AbortController();
    const resultPromise = broker.request({
      request: requestPayload(),
      timeoutMs: 5_000,
      signal: controller.signal,
    });

    if (cause === "timeout") {
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(resultPromise).resolves.toMatchObject({ decision: null });
    } else {
      controller.abort(new Error("run aborted"));
      await expect(resultPromise).rejects.toThrow("run aborted");
    }
    expect(broker.listPending()).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      event: "plugin.approval.removed",
      payload: { id: expect.stringMatching(/^plugin:/) },
    });
  });

  it("isolates presentation failure while stopping every pending request", async () => {
    vi.useFakeTimers();
    const removedIds: string[] = [];
    const broker = new EmbeddedPluginApprovalBroker((event) => {
      if (event.event === "plugin.approval.removed") {
        removedIds.push(event.payload.id);
        throw new Error("removal listener failed");
      }
    });
    const first = broker.request({
      request: requestPayload(),
      timeoutMs: 5_000,
    });
    const second = broker.request({
      request: requestPayload(),
      timeoutMs: 5_000,
    });
    let stopError: unknown;

    try {
      broker.stop(new Error("local TUI stopped"));
    } catch (error) {
      stopError = error;
    }
    const settlementsPromise = Promise.allSettled([first, second]);
    await vi.runAllTimersAsync();
    const settlements = await settlementsPromise;

    expect(stopError).toBeUndefined();
    expect(settlements.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(removedIds).toHaveLength(2);
    expect(new Set(removedIds).size).toBe(2);
    expect(broker.listPending()).toEqual([]);
  });
});
