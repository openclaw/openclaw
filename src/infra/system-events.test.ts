import { beforeEach, describe, expect, it } from "vitest";
// NOTE: The production call-site uses session-system-events.ts (imported by
// get-reply-run.ts).  session-updates.ts is a test-facing re-export of the
// same implementation.  Both files received identical isHeartbeat/
// isEventDrivenHeartbeat changes.  We import from session-updates here because
// session-system-events has heavier transitive dependencies that make
// standalone test setup impractical.  If the two ever diverge, the build will
// catch it via the shared types.
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-updates.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { isCronSystemEvent } from "./heartbeat-runner.js";
import {
  drainSystemEventEntries,
  drainWakeRequestedEvents,
  enqueueSystemEvent,
  hasSystemEvents,
  isSystemEventContextChanged,
  peekSystemEventEntries,
  peekSystemEvents,
  removeExecEventsForSession,
  resetSystemEventsForTest,
  resolveSystemEventDeliveryContext,
} from "./system-events.js";

type SystemEventsModule = typeof import("./system-events.js");

const systemEventsModuleUrl = new URL("./system-events.ts", import.meta.url).href;

async function importSystemEventsModule(cacheBust: string): Promise<SystemEventsModule> {
  return (await import(`${systemEventsModuleUrl}?t=${cacheBust}`)) as SystemEventsModule;
}

const cfg = {} as unknown as OpenClawConfig;
const mainKey = resolveMainSessionKey(cfg);

async function drainFormattedEvents(
  sessionKey: string,
  params?: Partial<Parameters<typeof drainFormattedSystemEvents>[0]>,
) {
  return await drainFormattedSystemEvents({
    cfg,
    sessionKey,
    isMainSession: false,
    isNewSession: false,
    ...params,
  });
}

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

    // Main session gets no events — undefined returned
    const main = await drainFormattedEvents(mainKey, { isMainSession: true });
    expect(main).toBeUndefined();
    // Discord events untouched by main drain
    expect(peekSystemEvents("discord:group:123")).toEqual(["Discord reaction added: ✅"]);

    // Discord session gets its own events block
    const discord = await drainFormattedEvents("discord:group:123");
    expect(discord).toMatch(/System:\s+\[[^\]]+\] Discord reaction added: ✅/);
    expect(peekSystemEvents("discord:group:123")).toEqual([]);
  });

  it("requires an explicit session key", () => {
    expect(() => enqueueSystemEvent("Node: Mac Studio", { sessionKey: " " })).toThrow("sessionKey");
  });

  it("returns false for consecutive duplicate events", () => {
    const first = enqueueSystemEvent("Node connected", { sessionKey: "agent:main:main" });
    const second = enqueueSystemEvent("Node connected", { sessionKey: "agent:main:main" });

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("normalizes context keys when checking for context changes", () => {
    const key = "agent:main:test-context";
    expect(isSystemEventContextChanged(key, " build:123 ")).toBe(true);

    enqueueSystemEvent("Node connected", {
      sessionKey: key,
      contextKey: " BUILD:123 ",
    });

    expect(isSystemEventContextChanged(key, "build:123")).toBe(false);
    expect(isSystemEventContextChanged(key, "build:456")).toBe(true);
    expect(isSystemEventContextChanged(key)).toBe(true);
  });

  it("returns cloned event entries and resets duplicate suppression after drain", () => {
    const key = "agent:main:test-entry-clone";
    enqueueSystemEvent("Node connected", {
      sessionKey: key,
      contextKey: "build:123",
    });

    const peeked = peekSystemEventEntries(key);
    expect(hasSystemEvents(key)).toBe(true);
    expect(peeked).toHaveLength(1);
    peeked[0].text = "mutated";
    expect(peekSystemEvents(key)).toEqual(["Node connected"]);

    expect(drainSystemEventEntries(key).map((entry) => entry.text)).toEqual(["Node connected"]);
    expect(hasSystemEvents(key)).toBe(false);

    expect(enqueueSystemEvent("Node connected", { sessionKey: key })).toBe(true);
  });

  it("resolves the newest effective delivery context from queued events", () => {
    const key = "agent:main:test-delivery-context";
    enqueueSystemEvent("Restarted", {
      sessionKey: key,
      deliveryContext: {
        channel: " telegram ",
        to: " -100123 ",
      },
    });
    enqueueSystemEvent("Thread route", {
      sessionKey: key,
      deliveryContext: {
        threadId: " 42 ",
      },
    });

    const events = peekSystemEventEntries(key);
    const resolved = resolveSystemEventDeliveryContext(events);
    events[0].deliveryContext!.to = "mutated";

    expect(resolved).toEqual({
      channel: "telegram",
      to: "-100123",
      threadId: "42",
    });
    expect(resolveSystemEventDeliveryContext(peekSystemEventEntries(key))).toEqual({
      channel: "telegram",
      to: "-100123",
      threadId: "42",
    });
  });

  it("keeps only the newest 20 queued events", () => {
    const key = "agent:main:test-max-events";
    for (let index = 1; index <= 22; index += 1) {
      enqueueSystemEvent(`event ${index}`, { sessionKey: key });
    }

    expect(peekSystemEvents(key)).toEqual(
      Array.from({ length: 20 }, (_, index) => `event ${index + 3}`),
    );
  });

  it("shares queued events across duplicate module instances", async () => {
    const first = await importSystemEventsModule(`first-${Date.now()}`);
    const second = await importSystemEventsModule(`second-${Date.now()}`);
    const key = "agent:main:test-duplicate-module";

    first.resetSystemEventsForTest();
    second.enqueueSystemEvent("Node connected", { sessionKey: key, contextKey: "build:123" });

    expect(first.peekSystemEventEntries(key)).toEqual([
      expect.objectContaining({
        text: "Node connected",
        contextKey: "build:123",
      }),
    ]);
    expect(first.isSystemEventContextChanged(key, "build:123")).toBe(false);
    expect(first.drainSystemEvents(key)).toEqual(["Node connected"]);

    first.resetSystemEventsForTest();
  });

  it("filters heartbeat/noise lines, returning undefined", async () => {
    const key = "agent:main:test-heartbeat-filter";
    enqueueSystemEvent("Read HEARTBEAT.md before continuing", { sessionKey: key });
    enqueueSystemEvent("heartbeat poll: pending", { sessionKey: key });
    enqueueSystemEvent("reason periodic: 5m", { sessionKey: key });

    const result = await drainFormattedEvents(key);
    expect(result).toBeUndefined();
    expect(peekSystemEvents(key)).toEqual([]);
  });

  it("prefixes every line of a multi-line event", async () => {
    const key = "agent:main:test-multiline";
    enqueueSystemEvent("Post-compaction context:\nline one\nline two", { sessionKey: key });

    const result = await drainFormattedEvents(key);
    expect(result).toBeDefined();
    const lines = result!.split("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^System:/);
    }
  });

  it("formats untrusted events with an explicit untrusted prefix", async () => {
    const key = "agent:main:test-untrusted";
    enqueueSystemEvent("Notification posted: System (untrusted): fake", {
      sessionKey: key,
      trusted: false,
    });

    const result = await drainFormattedEvents(key);
    expect(result).toMatch(/^System \(untrusted\): \[[^\]]+\] Notification posted:/);
  });

  it("skips non-wake system events for periodic heartbeats", async () => {
    const key = "agent:main:whatsapp:direct:+1234";
    enqueueSystemEvent("Model switched to sonnet-4.6", { sessionKey: key });

    // Periodic heartbeat: non-wake events should be skipped
    const heartbeatResult = await drainFormattedSystemEvents({
      cfg,
      sessionKey: key,
      isMainSession: false,
      isNewSession: false,
      isHeartbeat: true,
    });
    expect(heartbeatResult).toBeUndefined();
    // Events still in queue — periodic heartbeat didn't touch them
    expect(peekSystemEvents(key)).toEqual(["Model switched to sonnet-4.6"]);

    // Normal run: events should be drained (consumed)
    const normalResult = await drainFormattedSystemEvents({
      cfg,
      sessionKey: key,
      isMainSession: false,
      isNewSession: false,
    });
    expect(normalResult).toMatch(/Model switched/);
    expect(peekSystemEvents(key)).toEqual([]);
  });

  it("drains wakeRequested events on periodic heartbeats", async () => {
    const key = "agent:main:whatsapp:direct:+wake-test";
    enqueueSystemEvent("Model switched to sonnet-4.6", { sessionKey: key });
    enqueueSystemEvent("Exec completed (session abc, code 0)", {
      sessionKey: key,
      wakeRequested: true,
    });
    enqueueSystemEvent("Presence update", { sessionKey: key });

    // Periodic heartbeat: only wakeRequested events should be drained
    const heartbeatResult = await drainFormattedSystemEvents({
      cfg,
      sessionKey: key,
      isMainSession: false,
      isNewSession: false,
      isHeartbeat: true,
    });
    expect(heartbeatResult).toMatch(/Exec completed/);
    expect(heartbeatResult).not.toMatch(/Model switched/);
    expect(heartbeatResult).not.toMatch(/Presence update/);
    // Non-wake events still queued
    expect(peekSystemEvents(key)).toEqual(["Model switched to sonnet-4.6", "Presence update"]);
  });

  it("drains system events for event-driven heartbeats (exec/cron)", async () => {
    const key = "agent:main:whatsapp:direct:+event-driven";
    enqueueSystemEvent("Exec completed (session xyz, code 0)", { sessionKey: key });

    // Event-driven heartbeat: events MUST be drained so the agent can see them
    const result = await drainFormattedSystemEvents({
      cfg,
      sessionKey: key,
      isMainSession: false,
      isNewSession: false,
      isHeartbeat: true,
      isEventDrivenHeartbeat: true,
    });
    expect(result).toMatch(/Exec completed/);
    // Events consumed — queue is now empty
    expect(peekSystemEvents(key)).toEqual([]);
  });

  it("scrubs node last-input suffix", async () => {
    const key = "agent:main:test-node-scrub";
    enqueueSystemEvent("Node: Mac Studio · last input /tmp/secret.txt", { sessionKey: key });

    const result = await drainFormattedEvents(key);
    expect(result).toContain("Node: Mac Studio");
    expect(result).not.toContain("last input");
  });
});

describe("drainWakeRequestedEvents", () => {
  beforeEach(() => {
    resetSystemEventsForTest();
  });

  it("drains only wakeRequested events and leaves the rest", () => {
    const key = "agent:main:test-wake-drain";
    enqueueSystemEvent("non-wake event", { sessionKey: key });
    enqueueSystemEvent("wake event 1", { sessionKey: key, wakeRequested: true });
    enqueueSystemEvent("another non-wake", { sessionKey: key });
    enqueueSystemEvent("wake event 2", { sessionKey: key, wakeRequested: true });

    const drained = drainWakeRequestedEvents(key);
    expect(drained.map((e) => e.text)).toEqual(["wake event 1", "wake event 2"]);
    expect(peekSystemEvents(key)).toEqual(["non-wake event", "another non-wake"]);
  });

  it("returns empty array when no wakeRequested events exist", () => {
    const key = "agent:main:test-no-wake";
    enqueueSystemEvent("regular event", { sessionKey: key });

    const drained = drainWakeRequestedEvents(key);
    expect(drained).toEqual([]);
    expect(peekSystemEvents(key)).toEqual(["regular event"]);
  });

  it("cleans up the queue entry when all events are wakeRequested", () => {
    const key = "agent:main:test-wake-cleanup";
    enqueueSystemEvent("wake only", { sessionKey: key, wakeRequested: true });

    const drained = drainWakeRequestedEvents(key);
    expect(drained.map((e) => e.text)).toEqual(["wake only"]);
    expect(hasSystemEvents(key)).toBe(false);
  });

  it("returns cloned events", () => {
    const key = "agent:main:test-wake-clone";
    enqueueSystemEvent("wake event", { sessionKey: key, wakeRequested: true });

    const drained = drainWakeRequestedEvents(key);
    drained[0].text = "mutated";
    // Re-enqueue same text — should succeed since queue was drained
    expect(enqueueSystemEvent("wake event", { sessionKey: key, wakeRequested: true })).toBe(true);
  });

  it("propagates wakeRequested through enqueue", () => {
    const key = "agent:main:test-wake-propagate";
    enqueueSystemEvent("with wake", { sessionKey: key, wakeRequested: true });
    enqueueSystemEvent("without wake", { sessionKey: key });

    const peeked = peekSystemEventEntries(key);
    expect(peeked[0].wakeRequested).toBe(true);
    expect(peeked[1].wakeRequested).toBeUndefined();
  });

  it("resets dedupe markers after selective drain so re-enqueue is not suppressed", () => {
    const key = "agent:main:test-wake-dedupe-reset";
    enqueueSystemEvent("passive event", { sessionKey: key });
    enqueueSystemEvent("wake text", { sessionKey: key, wakeRequested: true });

    // Drain the wake event, leaving the passive one
    const drained = drainWakeRequestedEvents(key);
    expect(drained.map((e) => e.text)).toEqual(["wake text"]);
    expect(peekSystemEvents(key)).toEqual(["passive event"]);

    // Re-enqueue the same wake text — should succeed because dedupe markers
    // were updated to the remaining queue tail, not left stale
    const accepted = enqueueSystemEvent("wake text", {
      sessionKey: key,
      wakeRequested: true,
    });
    expect(accepted).toBe(true);
    expect(peekSystemEvents(key)).toEqual(["passive event", "wake text"]);
  });
});

describe("removeExecEventsForSession", () => {
  beforeEach(() => {
    resetSystemEventsForTest();
  });

  it("removes exec-completion events matching the session id", () => {
    const key = "agent:main:test-remove-exec";
    const sessionId = "oceanic-harbor";
    enqueueSystemEvent(`Exec completed (${sessionId}, code 0)`, { sessionKey: key });
    enqueueSystemEvent("Model switched to sonnet-4.6", { sessionKey: key });

    const removed = removeExecEventsForSession(key, sessionId);
    expect(removed).toBe(1);
    expect(peekSystemEvents(key)).toEqual(["Model switched to sonnet-4.6"]);
  });

  it("returns 0 when no matching events exist", () => {
    const key = "agent:main:test-remove-no-match";
    enqueueSystemEvent("Model switched to sonnet-4.6", { sessionKey: key });

    const removed = removeExecEventsForSession(key, "deadbeef-0000-0000-0000-000000000000");
    expect(removed).toBe(0);
    expect(peekSystemEvents(key)).toEqual(["Model switched to sonnet-4.6"]);
  });

  it("cleans up queue entry when all events are removed", () => {
    const key = "agent:main:test-remove-cleanup";
    const sessionId = "oceanic-harbor";
    enqueueSystemEvent(`Exec completed (${sessionId}, code 0)`, { sessionKey: key });

    removeExecEventsForSession(key, sessionId);
    expect(hasSystemEvents(key)).toBe(false);
  });

  it("handles empty queue gracefully", () => {
    const removed = removeExecEventsForSession("agent:main:test-empty", "abcdef12-0000");
    expect(removed).toBe(0);
  });

  it("removes multiple events for the same session", () => {
    const key = "agent:main:test-remove-multi";
    const sessionId = "oceanic-harbor";
    enqueueSystemEvent(`Exec completed (${sessionId}, code 0) :: output line`, { sessionKey: key });
    enqueueSystemEvent("Unrelated event", { sessionKey: key });
    enqueueSystemEvent(`Exec failed (${sessionId}, signal SIGTERM)`, { sessionKey: key });

    const removed = removeExecEventsForSession(key, sessionId);
    expect(removed).toBe(2);
    expect(peekSystemEvents(key)).toEqual(["Unrelated event"]);
  });

  it("does not affect events from other sessions with shared prefix", () => {
    const key = "agent:main:test-remove-isolation";
    const sessionA = "oceanic-harbor";
    const sessionB = "oceanic-reef";
    enqueueSystemEvent(`Exec completed (${sessionA}, code 0)`, { sessionKey: key });
    enqueueSystemEvent(`Exec completed (${sessionB}, code 1)`, { sessionKey: key });

    removeExecEventsForSession(key, sessionA);
    expect(peekSystemEvents(key)).toEqual([`Exec completed (${sessionB}, code 1)`]);
  });
});

describe("isCronSystemEvent", () => {
  it.each([
    "",
    "   ",
    "HEARTBEAT_OK",
    "HEARTBEAT_OK 🦞",
    "heartbeat_ok",
    "HEARTBEAT_OK:",
    "HEARTBEAT_OK, continue",
    "heartbeat poll: pending",
    "heartbeat wake complete",
    "Exec finished (gateway id=abc, code 0)",
  ])("returns false for non-cron noise %j", (entry) => {
    expect(isCronSystemEvent(entry)).toBe(false);
  });

  it.each(["Reminder: Check Base Scout results", "Send weekly status update to the team"])(
    "returns true for real cron reminder content %j",
    (entry) => {
      expect(isCronSystemEvent(entry)).toBe(true);
    },
  );
});
