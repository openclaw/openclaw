import { describe, expect, it } from "vitest";
import { resolveSystemEventQueueKey } from "./system-event-queue-key.js";

describe("resolveSystemEventQueueKey", () => {
  it("keeps a derived agent-global queue distinct from a literal scoped session key", () => {
    const derived = resolveSystemEventQueueKey({ sessionKey: "global", agentId: "ops" });
    const literal = resolveSystemEventQueueKey({ sessionKey: "agent:ops:global" });

    expect(derived).not.toBe(literal);
    expect(literal).toBe("agent:ops:global");
    expect(() => resolveSystemEventQueueKey({ sessionKey: derived })).toThrow(
      "reserved derived-queue namespace",
    );
  });
});
