import { describe, expect, it } from "vitest";
import {
  CONNECT_QUEUE_DELAY_MS,
  RECONNECT_BACKOFF_MULTIPLIER,
  RECONNECT_INITIAL_BACKOFF_MS,
  RECONNECT_MAX_BACKOFF_MS,
} from "../../ui/src/ui/gateway.ts";

describe("gateway reconnect constants", () => {
  it("keeps reconnect timings positive and bounded", () => {
    expect(RECONNECT_INITIAL_BACKOFF_MS).toBeGreaterThan(0);
    expect(RECONNECT_MAX_BACKOFF_MS).toBeGreaterThan(RECONNECT_INITIAL_BACKOFF_MS);
    expect(RECONNECT_BACKOFF_MULTIPLIER).toBeGreaterThan(1);
    expect(CONNECT_QUEUE_DELAY_MS).toBeGreaterThan(0);
  });
});
