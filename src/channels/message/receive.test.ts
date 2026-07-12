/**
 * Tests for createMessageReceiveContext with ack/nack idempotency.
 */
import { describe, expect, it, vi } from "vitest";
import { createMessageReceiveContext } from "./receive.js";

describe("createMessageReceiveContext ack/nack", () => {
  it("nack ignores duplicate calls (idempotent guard) (#104903)", async () => {
    const onNack = vi.fn();
    const ctx = createMessageReceiveContext({
      id: "test",
      channel: "test",
      message: {},
      onNack,
    });

    await ctx.nack(new Error("first"));
    await ctx.nack(new Error("second"));

    // onNack must only fire once — duplicate calls are no-ops.
    expect(onNack).toHaveBeenCalledTimes(1);
  });

  it("nack preserves the first error message on duplicate calls", async () => {
    const ctx = createMessageReceiveContext({
      id: "test",
      channel: "test",
      message: {},
    });

    await ctx.nack(new Error("first error"));

    // Second call must not overwrite the first nack error.
    await ctx.nack(new Error("duplicate error"));

    expect(ctx.nackErrorMessage).toContain("first error");
    expect(ctx.nackErrorMessage).not.toContain("duplicate error");
  });

  it("ack remains idempotent (regression guard)", async () => {
    const onAck = vi.fn();
    const ctx = createMessageReceiveContext({
      id: "test",
      channel: "test",
      message: {},
      onAck,
    });

    await ctx.ack();
    await ctx.ack();

    expect(onAck).toHaveBeenCalledTimes(1);
  });

  it("nack after ack is a no-op", async () => {
    const onAck = vi.fn();
    const onNack = vi.fn();
    const ctx = createMessageReceiveContext({
      id: "test",
      channel: "test",
      message: {},
      onAck,
      onNack,
    });

    await ctx.ack();
    await ctx.nack(new Error("after ack"));

    expect(onAck).toHaveBeenCalledTimes(1);
    expect(onNack).not.toHaveBeenCalled();
  });

  it("nack sets ackState correctly", async () => {
    const ctx = createMessageReceiveContext({
      id: "test",
      channel: "test",
      message: {},
    });
    expect(ctx.ackState).toBe("pending");

    await ctx.nack(new Error("test"));
    expect(ctx.ackState).toBe("nacked");
  });
});
