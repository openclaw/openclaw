import { beforeEach, describe, expect, it } from "vitest";
import { prependSystemEvents } from "../auto-reply/reply/session-updates.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { isCronSystemEvent } from "./heartbeat-runner.js";
import {
  dropSystemEventsByContextKey,
  enqueueSystemEvent,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "./system-events.js";

const cfg = {} as unknown as OpenClawConfig;
const mainKey = resolveMainSessionKey(cfg);

describe("system events (session routing)", () => {
  beforeEach(() => {
    resetSystemEventsForTest();
  });

  it("does not leak session-scoped events into main", async () => {
    enqueueSystemEvent("Discord reaction added: ✅", {
      sessionKey: "discord:group:123",
      contextKey: "discord:reaction:added:msg:user:✅",
    });

    expect(peekSystemEvents(mainKey)).toEqual([]);
    expect(peekSystemEvents("discord:group:123")).toEqual(["Discord reaction added: ✅"]);

    const main = await prependSystemEvents({
      cfg,
      sessionKey: mainKey,
      isMainSession: true,
      isNewSession: false,
      prefixedBodyBase: "hello",
    });
    expect(main).toBe("hello");
    expect(peekSystemEvents("discord:group:123")).toEqual(["Discord reaction added: ✅"]);

    const discord = await prependSystemEvents({
      cfg,
      sessionKey: "discord:group:123",
      isMainSession: false,
      isNewSession: false,
      prefixedBodyBase: "hi",
    });
    expect(discord).toMatch(/^System: \[[^\]]+\] Discord reaction added: ✅\n\nhi$/);
    expect(peekSystemEvents("discord:group:123")).toEqual([]);
  });

  it("requires an explicit session key", () => {
    expect(() => enqueueSystemEvent("Node: Mac Studio", { sessionKey: " " })).toThrow("sessionKey");
  });
});

describe("dropSystemEventsByContextKey", () => {
  beforeEach(() => resetSystemEventsForTest());

  it("drops events matching the contextKey across all sessions", () => {
    enqueueSystemEvent("job1 msg", { sessionKey: mainKey, contextKey: "cron:abc" });
    enqueueSystemEvent("job2 msg", { sessionKey: mainKey, contextKey: "cron:def" });
    enqueueSystemEvent("other msg", { sessionKey: mainKey });

    const dropped = dropSystemEventsByContextKey("cron:abc");
    expect(dropped).toBe(1);
    expect(peekSystemEvents(mainKey)).toEqual(["job2 msg", "other msg"]);
  });

  it("drops from multiple session queues", () => {
    enqueueSystemEvent("a", { sessionKey: "sess1", contextKey: "cron:x" });
    enqueueSystemEvent("b", { sessionKey: "sess2", contextKey: "cron:x" });
    enqueueSystemEvent("c", { sessionKey: "sess2", contextKey: "cron:y" });

    const dropped = dropSystemEventsByContextKey("cron:x");
    expect(dropped).toBe(2);
    expect(peekSystemEvents("sess1")).toEqual([]);
    expect(peekSystemEvents("sess2")).toEqual(["c"]);
  });

  it("returns 0 when no events match", () => {
    enqueueSystemEvent("msg", { sessionKey: mainKey, contextKey: "cron:abc" });
    expect(dropSystemEventsByContextKey("cron:zzz")).toBe(0);
  });
});

describe("isCronSystemEvent", () => {
  it("returns false for empty entries", () => {
    expect(isCronSystemEvent("")).toBe(false);
    expect(isCronSystemEvent("   ")).toBe(false);
  });

  it("returns false for heartbeat ack markers", () => {
    expect(isCronSystemEvent("HEARTBEAT_OK")).toBe(false);
    expect(isCronSystemEvent("HEARTBEAT_OK 🦞")).toBe(false);
    expect(isCronSystemEvent("heartbeat_ok")).toBe(false);
    expect(isCronSystemEvent("HEARTBEAT_OK:")).toBe(false);
    expect(isCronSystemEvent("HEARTBEAT_OK, continue")).toBe(false);
  });

  it("returns false for heartbeat poll and wake noise", () => {
    expect(isCronSystemEvent("heartbeat poll: pending")).toBe(false);
    expect(isCronSystemEvent("heartbeat wake complete")).toBe(false);
  });

  it("returns false for exec completion events", () => {
    expect(isCronSystemEvent("Exec finished (gateway id=abc, code 0)")).toBe(false);
  });

  it("returns true for real cron reminder content", () => {
    expect(isCronSystemEvent("Reminder: Check Base Scout results")).toBe(true);
    expect(isCronSystemEvent("Send weekly status update to the team")).toBe(true);
  });
});
