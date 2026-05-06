import { describe, expect, it } from "vitest";
import { generateChainId } from "./secure-random.js";

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("generateChainId continuation chain ids", () => {
  it("returns a UUIDv7-shaped string", () => {
    const id = generateChainId();
    expect(id).toMatch(UUID_V7_RE);
  });

  it("returns unique ids across calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(generateChainId());
    }
    expect(ids.size).toBe(1000);
  });

  it("preserves lexicographic ordering across mints (time-ordered)", async () => {
    // UUIDv7 first 48 bits are unix-millis. Two ids minted with a >=2ms
    // gap MUST sort id_a < id_b lexicographically.
    const earlier = generateChainId();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const later = generateChainId();
    expect(earlier < later).toBe(true);
  });

  it("encodes the mint timestamp in the first 48 bits", () => {
    const before = Date.now();
    const id = generateChainId();
    const after = Date.now();
    // First 48 bits = first 12 hex chars (split: 8 + "-" + 4).
    const tsHex = id.slice(0, 8) + id.slice(9, 13);
    const ts = Number.parseInt(tsHex, 16);
    // Allow ±50ms window for clock granularity / test timing slack.
    expect(ts).toBeGreaterThanOrEqual(before - 50);
    expect(ts).toBeLessThanOrEqual(after + 50);
  });
});
