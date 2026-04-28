import { describe, expect, it, vi } from "vitest";
import { matchesMessagingToolDeliveryTarget } from "./delivery-dispatch.js";

// Mock the announce flow dependencies to test the fallback behavior.
vi.mock("../../agents/subagent-announce.js", () => ({
  runSubagentAnnounceFlow: vi.fn(),
}));
vi.mock("../../agents/subagent-registry-read.js", () => ({
  countActiveDescendantRuns: vi.fn().mockReturnValue(0),
}));

describe("matchesMessagingToolDeliveryTarget", () => {
  it("matches when channel and to agree", () => {
    expect(
      matchesMessagingToolDeliveryTarget(
        { provider: "telegram", to: "123456" },
        { channel: "telegram", to: "123456" },
      ),
    ).toBe(true);
  });

  it("rejects when channel differs", () => {
    expect(
      matchesMessagingToolDeliveryTarget(
        { provider: "whatsapp", to: "123456" },
        { channel: "telegram", to: "123456" },
      ),
    ).toBe(false);
  });

  it("rejects when to is missing from delivery", () => {
    expect(
      matchesMessagingToolDeliveryTarget(
        { provider: "telegram", to: "123456" },
        { channel: "telegram", to: undefined },
      ),
    ).toBe(false);
  });

  it("rejects when channel is missing from delivery", () => {
    expect(
      matchesMessagingToolDeliveryTarget(
        { provider: "telegram", to: "123456" },
        { channel: undefined, to: "123456" },
      ),
    ).toBe(false);
  });

  it("strips :topic:NNN suffix from target.to before comparing", () => {
    expect(
      matchesMessagingToolDeliveryTarget(
        { provider: "telegram", to: "-1003597428309:topic:462" },
        { channel: "telegram", to: "-1003597428309" },
      ),
    ).toBe(true);
  });

  it("requires matching thread ids when both sides carry a thread", () => {
    expect(
      matchesMessagingToolDeliveryTarget(
        { provider: "slack", to: "C123", threadId: "1737500000.123456" },
        { channel: "slack", to: "C123", threadId: "1737500000.123456" },
      ),
    ).toBe(true);
    expect(
      matchesMessagingToolDeliveryTarget(
        { provider: "slack", to: "C123", threadId: "1737500000.999999" },
        { channel: "slack", to: "C123", threadId: "1737500000.123456" },
      ),
    ).toBe(false);
  });

  it("does not treat a base-room send as delivery to a threaded target", () => {
    expect(
      matchesMessagingToolDeliveryTarget(
        { provider: "topicchat", to: "room" },
        { channel: "topicchat", to: "room#42", threadId: 42 },
      ),
    ).toBe(false);
  });

  it("matches channel formatted current target ids for threaded delivery", () => {
    expect(
      matchesMessagingToolDeliveryTarget(
        { provider: "topicchat", to: "room#42", threadId: "42" },
        { channel: "topicchat", to: "room", threadId: 42 },
      ),
    ).toBe(true);
  });

  it("matches exact threaded target ids when both to values include the thread suffix", () => {
    expect(
      matchesMessagingToolDeliveryTarget(
        { provider: "topicchat", to: "room#42" },
        { channel: "topicchat", to: "room#42", threadId: 42 },
      ),
    ).toBe(true);
  });

  it("does not match thread ids by substring inside the target", () => {
    expect(
      matchesMessagingToolDeliveryTarget(
        { provider: "topicchat", to: "room123" },
        { channel: "topicchat", to: "room123", threadId: 12 },
      ),
    ).toBe(false);
  });

  it("matches topic suffixes only when the thread id is delimiter-bound", () => {
    expect(
      matchesMessagingToolDeliveryTarget(
        { provider: "telegram", to: "-1003597428309:topic:462" },
        { channel: "telegram", to: "-1003597428309", threadId: 462 },
      ),
    ).toBe(true);
  });

  it("matches when provider is 'message' (generic)", () => {
    expect(
      matchesMessagingToolDeliveryTarget(
        { provider: "message", to: "123456" },
        { channel: "telegram", to: "123456" },
      ),
    ).toBe(true);
  });

  it("rejects when accountIds differ", () => {
    expect(
      matchesMessagingToolDeliveryTarget(
        { provider: "telegram", to: "123456", accountId: "bot-a" },
        { channel: "telegram", to: "123456", accountId: "bot-b" },
      ),
    ).toBe(false);
  });

  it("matches when delivery has accountId and target omits it (tool fills accountId at exec)", () => {
    expect(
      matchesMessagingToolDeliveryTarget(
        { provider: "message", to: "123456" },
        { channel: "telegram", to: "123456", accountId: "bot-a" },
      ),
    ).toBe(true);
  });

  it("matches when delivery and target carry the same accountId", () => {
    expect(
      matchesMessagingToolDeliveryTarget(
        { provider: "telegram", to: "123456", accountId: "bot-a" },
        { channel: "telegram", to: "123456", accountId: "bot-a" },
      ),
    ).toBe(true);
  });
});

describe("resolveCronDeliveryBestEffort", () => {
  // Import dynamically to avoid top-level side effects
  it("returns false by default (no bestEffort set)", async () => {
    const { resolveCronDeliveryBestEffort } = await import("./delivery-dispatch.js");
    const job = { delivery: {}, payload: { kind: "agentTurn" } } as never;
    expect(resolveCronDeliveryBestEffort(job)).toBe(false);
  });

  it("returns true when delivery.bestEffort is true", async () => {
    const { resolveCronDeliveryBestEffort } = await import("./delivery-dispatch.js");
    const job = { delivery: { bestEffort: true }, payload: { kind: "agentTurn" } } as never;
    expect(resolveCronDeliveryBestEffort(job)).toBe(true);
  });
});
