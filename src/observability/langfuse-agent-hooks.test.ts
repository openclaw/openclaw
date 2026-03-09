import { describe, expect, it } from "vitest";
import { redactPayload, truncateString } from "./langfuse-agent-hooks.js";

describe("langfuse agent hook payload safety", () => {
  it("redacts sensitive keys recursively", () => {
    expect(
      redactPayload({
        token: "secret-token",
        nested: {
          password: "p@ss",
          ok: "visible",
        },
      }),
    ).toEqual({
      token: "[REDACTED]",
      nested: {
        password: "[REDACTED]",
        ok: "visible",
      },
    });
  });

  it("truncates oversized strings and arrays", () => {
    const long = "x".repeat(2_100);
    const result = redactPayload({
      long,
      items: Array.from({ length: 25 }, (_, i) => i + 1),
    }) as { long: string; items: unknown[] };

    expect(result.long).toContain("…[truncated]");
    expect(result.long.length).toBeLessThan(long.length);
    expect(result.items).toHaveLength(21);
    expect(result.items.at(-1)).toBe("…[5 more items]");
  });

  it("truncateString adds truncation marker", () => {
    expect(truncateString("abcdef", 4)).toBe("abcd…[truncated]");
    expect(truncateString("abc", 4)).toBe("abc");
  });
});
