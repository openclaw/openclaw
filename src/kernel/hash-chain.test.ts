import { describe, it, expect } from "vitest";
import { createHashChainLedger } from "./hash-chain.js";

describe("HashChainLedger", () => {
  it("starts empty", () => {
    const ledger = createHashChainLedger();
    expect(ledger.length).toBe(0);
    expect(ledger.head()).toBeUndefined();
    expect(ledger.entries()).toHaveLength(0);
  });

  it("appends entries with sequential numbering", () => {
    const ledger = createHashChainLedger();
    const e0 = ledger.append("governance", "test:first", { key: "val" });
    const e1 = ledger.append("skill", "test:second", { n: 2 });

    expect(e0.seq).toBe(0);
    expect(e1.seq).toBe(1);
    expect(ledger.length).toBe(2);
  });

  it("genesis entry has empty prev hash", () => {
    const ledger = createHashChainLedger();
    const e0 = ledger.append("governance", "genesis", {});
    expect(e0.prev).toBe("");
  });

  it("subsequent entries chain to the previous hash", () => {
    const ledger = createHashChainLedger();
    const e0 = ledger.append("governance", "first", {});
    const e1 = ledger.append("governance", "second", {});
    expect(e1.prev).toBe(e0.hash);
  });

  it("produces unique hashes for different payloads", () => {
    const ledger = createHashChainLedger();
    const e0 = ledger.append("governance", "action", { a: 1 });
    const e1 = ledger.append("governance", "action", { a: 2 });
    expect(e0.hash).not.toBe(e1.hash);
  });

  it("verify() returns -1 for a valid chain", () => {
    const ledger = createHashChainLedger();
    ledger.append("governance", "a", {});
    ledger.append("skill", "b", { x: 1 });
    ledger.append("memory", "c", { y: 2 });
    expect(ledger.verify()).toBe(-1);
  });

  it("head() returns the latest entry", () => {
    const ledger = createHashChainLedger();
    ledger.append("governance", "a", {});
    const last = ledger.append("skill", "b", {});
    expect(ledger.head()).toEqual(last);
  });

  it("entries() returns a frozen copy", () => {
    const ledger = createHashChainLedger();
    ledger.append("governance", "a", {});
    const entries = ledger.entries();
    expect(Object.isFrozen(entries)).toBe(true);
  });
});
