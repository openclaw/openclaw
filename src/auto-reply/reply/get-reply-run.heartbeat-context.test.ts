import { describe, expect, it } from "vitest";
import {
  shouldIncludeHeartbeatInboundUserContext,
  shouldIncludeQueuedSystemEventsForRun,
} from "./get-reply-run.js";

describe("heartbeat context suppression", () => {
  it("hides inbound user context during heartbeat runs", () => {
    expect(shouldIncludeHeartbeatInboundUserContext({ isHeartbeat: true })).toBe(false);
    expect(shouldIncludeHeartbeatInboundUserContext({ isHeartbeat: false })).toBe(true);
  });

  it("keeps queued system events for non-heartbeat runs", () => {
    expect(
      shouldIncludeQueuedSystemEventsForRun({
        isHeartbeat: false,
        provider: "telegram",
      }),
    ).toBe(true);
  });

  it("keeps queued system events only for exec/cron heartbeat relays", () => {
    expect(
      shouldIncludeQueuedSystemEventsForRun({
        isHeartbeat: true,
        provider: "heartbeat",
      }),
    ).toBe(false);
    expect(
      shouldIncludeQueuedSystemEventsForRun({
        isHeartbeat: true,
        provider: "exec-event",
      }),
    ).toBe(true);
    expect(
      shouldIncludeQueuedSystemEventsForRun({
        isHeartbeat: true,
        provider: "cron-event",
      }),
    ).toBe(true);
  });
});
