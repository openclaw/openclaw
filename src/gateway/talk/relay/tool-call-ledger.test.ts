import { describe, expect, it, vi } from "vitest";
import { RelayToolCallLedger } from "./tool-call-ledger.js";

describe("RelayToolCallLedger", () => {
  it("preserves the first cancellation turn until agent completion wins", () => {
    const ledger = new RelayToolCallLedger({ onOverflow: vi.fn() });

    expect(ledger.tryAdmit(["call-1"])).toBe(true);
    expect(ledger.markCancelled(["call-1"], "turn-1")).toBe(true);
    expect(ledger.markCancelled(["call-1"], "turn-2")).toBe(true);
    expect(ledger.cancelledTurnId("call-1")).toBe("turn-1");

    expect(ledger.markAgentCompleted(["call-1"])).toBe(true);
    expect(ledger.hasCancelled("call-1")).toBe(false);
    expect(ledger.markCancelled(["call-1"], "turn-3")).toBe(true);
    expect(ledger.markProviderCompleted(["call-1"])).toBe(true);

    expect(ledger.size).toBe(1);
    expect(ledger.cancelledTurnId("call-1")).toBeUndefined();
    expect(ledger.isAgentCompleted("call-1")).toBe(true);
    expect(ledger.isProviderCompleted("call-1")).toBe(true);
  });

  it("rejects overflowing batches atomically while admitting retained duplicates", () => {
    const onOverflow = vi.fn();
    const ledger = new RelayToolCallLedger({ onOverflow });

    expect(ledger.tryAdmit(["call-1"])).toBe(true);
    expect(ledger.markAgentCompleted(Array.from({ length: 2048 }, (_, i) => `call-${i + 2}`))).toBe(
      false,
    );
    expect(ledger.size).toBe(1);
    expect(ledger.has("call-2")).toBe(false);
    expect(ledger.has("call-3")).toBe(false);
    expect(onOverflow).toHaveBeenCalledOnce();

    expect(ledger.tryAdmit(["call-1"])).toBe(true);
    expect(onOverflow).toHaveBeenCalledOnce();
  });

  it("rejects identity bytes that exceed the session budget", () => {
    const onOverflow = vi.fn();
    const ledger = new RelayToolCallLedger({ onOverflow });

    expect(ledger.tryAdmit(["\u00e9".repeat(524_289)])).toBe(false);
    expect(ledger.size).toBe(0);
    expect(onOverflow).toHaveBeenCalledOnce();
  });

  it("clears lifecycle facts without releasing the retained identity", () => {
    const ledger = new RelayToolCallLedger({ onOverflow: vi.fn() });

    ledger.tryAdmit(Array.from({ length: 2047 }, (_, i) => `retained-${i}`));
    ledger.markCancelled(["call-1"], "turn-1");
    ledger.deleteCancelled("call-1");
    ledger.markAgentCompleted(["call-1"]);
    ledger.markProviderCompleted(["call-1"]);
    ledger.deleteAgentCompleted("call-1");
    ledger.clearProviderCompleted();

    expect(ledger.has("call-1")).toBe(true);
    expect(ledger.size).toBe(2048);
    expect(ledger.hasCancelled("call-1")).toBe(false);
    expect(ledger.isAgentCompleted("call-1")).toBe(false);
    expect(ledger.isProviderCompleted("call-1")).toBe(false);
    expect(ledger.tryAdmit(["call-2"])).toBe(false);
  });
});
