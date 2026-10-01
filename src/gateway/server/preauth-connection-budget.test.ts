/**
 * Pre-auth WebSocket connection-budget regression tests.
 */
import { describe, expect, it } from "vitest";
import { withEnv } from "../../test-utils/env.js";
import { createPreauthConnectionBudget } from "./preauth-connection-budget.js";

describe("createPreauthConnectionBudget", () => {
  it("caps connections with a finite configured limit", () => {
    const budget = createPreauthConnectionBudget(2);

    expect(budget.acquire("127.0.0.1")).toBe(true);
    expect(budget.acquire("127.0.0.1")).toBe(true);
    expect(budget.acquire("127.0.0.1")).toBe(false);

    budget.release("127.0.0.1");
    expect(budget.acquire("127.0.0.1")).toBe(true);
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY])(
    "allows shared-IP bursts up to the default cap when limit is %s",
    (limit) => {
      const budget = createPreauthConnectionBudget(limit);

      for (let i = 0; i < 128; i += 1) {
        expect(budget.acquire("127.0.0.1")).toBe(true);
      }
      expect(budget.acquire("127.0.0.1")).toBe(false);
      expect(budget.acquire("192.0.2.1")).toBe(true);
    },
  );

  it("shares one capped bucket for missing client IPs", () => {
    const budget = createPreauthConnectionBudget(2);

    for (let i = 0; i < 2; i += 1) {
      expect(budget.acquire(i % 2 === 0 ? undefined : "  ")).toBe(true);
    }
    expect(budget.acquire(undefined)).toBe(false);
  });

  it("accepts strict plus-signed env limits", () => {
    withEnv({ OPENCLAW_MAX_PREAUTH_CONNECTIONS_PER_IP: "+02" }, () => {
      const budget = createPreauthConnectionBudget();

      expect(budget.acquire("127.0.0.1")).toBe(true);
      expect(budget.acquire("127.0.0.1")).toBe(true);
      expect(budget.acquire("127.0.0.1")).toBe(false);
    });
  });

  it("ignores non-decimal env limits", () => {
    withEnv({ OPENCLAW_MAX_PREAUTH_CONNECTIONS_PER_IP: "0x2" }, () => {
      const budget = createPreauthConnectionBudget();

      for (let i = 0; i < 128; i += 1) {
        expect(budget.acquire("127.0.0.1")).toBe(true);
      }
      expect(budget.acquire("127.0.0.1")).toBe(false);
    });
  });
});
