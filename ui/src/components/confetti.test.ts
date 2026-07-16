import { describe, expect, it } from "vitest";
import { shouldFireFirstReplyConfetti } from "./confetti.ts";

function createStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    values,
  };
}

describe("shouldFireFirstReplyConfetti", () => {
  it("claims the first reply once", () => {
    const storage = createStorage();

    expect(shouldFireFirstReplyConfetti(storage)).toBe(true);
    expect(storage.values.get("openclaw.confetti.firstReply")).toBe("1");
    expect(shouldFireFirstReplyConfetti(storage)).toBe(false);
  });

  it("skips a browser profile that already celebrated", () => {
    const storage = createStorage({ "openclaw.confetti.firstReply": "1" });

    expect(shouldFireFirstReplyConfetti(storage)).toBe(false);
  });

  it("fails closed when storage is unavailable", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => undefined,
    };

    expect(shouldFireFirstReplyConfetti(storage)).toBe(false);
  });
});
