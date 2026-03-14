import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  commitPeekedSystemEvents,
  drainFormattedSystemEvents,
  peekFormattedSystemEvents,
  restorePeekedSystemEvents,
} from "../auto-reply/reply/session-updates.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { buildChannelSummary } from "./channel-summary.js";
import { isCronSystemEvent } from "./heartbeat-runner.js";
import {
  commitSystemEventReservation,
  drainSystemEventEntries,
  consumeSystemEventEntries,
  enqueueSystemEvent,
  hasSystemEvents,
  isSystemEventContextChanged,
  peekSystemEventEntries,
  peekSystemEvents,
  reserveSystemEventEntries,
  resetSystemEventsForTest,
  restoreSystemEventReservation,
} from "./system-events.js";

vi.mock("./channel-summary.js", () => ({
  buildChannelSummary: vi.fn(async () => []),
}));

const cfg = {} as unknown as OpenClawConfig;
const mainKey = resolveMainSessionKey(cfg);

describe("system events (session routing)", () => {
  beforeEach(() => {
    resetSystemEventsForTest();
    vi.clearAllMocks();
    vi.mocked(buildChannelSummary).mockResolvedValue([]);
  });

  it("does not leak session-scoped events into main", async () => {
    enqueueSystemEvent("Discord reaction added: ✅", {
      sessionKey: "discord:group:123",
      contextKey: "discord:reaction:added:msg:user:✅",
    });

    expect(peekSystemEvents(mainKey)).toEqual([]);
    expect(peekSystemEvents("discord:group:123")).toEqual(["Discord reaction added: ✅"]);

    // Main session gets no events — undefined returned
    const main = await drainFormattedSystemEvents({
      cfg,
      sessionKey: mainKey,
      isMainSession: true,
      isNewSession: false,
    });
    expect(main).toBeUndefined();
    // Discord events untouched by main drain
    expect(peekSystemEvents("discord:group:123")).toEqual(["Discord reaction added: ✅"]);

    // Discord session gets its own events block
    const discord = await drainFormattedSystemEvents({
      cfg,
      sessionKey: "discord:group:123",
      isMainSession: false,
      isNewSession: false,
    });
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

  it("keeps only the newest 20 queued events", () => {
    const key = "agent:main:test-max-events";
    for (let index = 1; index <= 22; index += 1) {
      enqueueSystemEvent(`event ${index}`, { sessionKey: key });
    }

    expect(peekSystemEvents(key)).toEqual(
      Array.from({ length: 20 }, (_, index) => `event ${index + 3}`),
    );
  });

  it("filters heartbeat/noise lines, returning undefined", async () => {
    const key = "agent:main:test-heartbeat-filter";
    enqueueSystemEvent("Read HEARTBEAT.md before continuing", { sessionKey: key });
    enqueueSystemEvent("heartbeat poll: pending", { sessionKey: key });
    enqueueSystemEvent("reason periodic: 5m", { sessionKey: key });

    const result = await drainFormattedSystemEvents({
      cfg,
      sessionKey: key,
      isMainSession: false,
      isNewSession: false,
    });
    expect(result).toBeUndefined();
    expect(peekSystemEvents(key)).toEqual([]);
  });

  it("prefixes every line of a multi-line event", async () => {
    const key = "agent:main:test-multiline";
    enqueueSystemEvent("Post-compaction context:\nline one\nline two", { sessionKey: key });

    const result = await drainFormattedSystemEvents({
      cfg,
      sessionKey: key,
      isMainSession: false,
      isNewSession: false,
    });
    expect(result).toBeDefined();
    const lines = result!.split("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^System:/);
    }
  });

  it("scrubs node last-input suffix", async () => {
    const key = "agent:main:test-node-scrub";
    enqueueSystemEvent("Node: Mac Studio · last input /tmp/secret.txt", { sessionKey: key });

    const result = await drainFormattedSystemEvents({
      cfg,
      sessionKey: key,
      isMainSession: false,
      isNewSession: false,
    });
    expect(result).toContain("Node: Mac Studio");
    expect(result).not.toContain("last input");
  });

  it("consumes only the previewed event snapshot, leaving newer events queued", () => {
    const key = "agent:main:test-consume-preview";
    enqueueSystemEvent("First event", { sessionKey: key });
    const previewed = peekSystemEventEntries(key);
    enqueueSystemEvent("Second event", { sessionKey: key });

    const consumed = consumeSystemEventEntries(key, previewed);

    expect(consumed.map((entry) => entry.text)).toEqual(["First event"]);
    expect(peekSystemEvents(key)).toEqual(["Second event"]);
  });

  it("hides reserved events from concurrent readers until they are committed", () => {
    const key = "agent:main:test-reserve";
    enqueueSystemEvent("First event", { sessionKey: key });

    const reservation = reserveSystemEventEntries(key);

    expect(reservation?.entries.map((entry) => entry.text)).toEqual(["First event"]);
    expect(peekSystemEvents(key)).toEqual([]);

    enqueueSystemEvent("Second event", { sessionKey: key });
    commitSystemEventReservation(reservation);

    expect(peekSystemEvents(key)).toEqual(["Second event"]);
  });

  it("restores reserved events ahead of newer queued events when a turn is skipped", () => {
    const key = "agent:main:test-restore";
    enqueueSystemEvent("First event", { sessionKey: key });
    const reservation = reserveSystemEventEntries(key);
    enqueueSystemEvent("Second event", { sessionKey: key });

    restoreSystemEventReservation(reservation);

    expect(peekSystemEvents(key)).toEqual(["First event", "Second event"]);
  });

  it("preserves original event order across multiple restored reservations", () => {
    const key = "agent:main:test-restore-order";
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1);
    try {
      enqueueSystemEvent("First event", { sessionKey: key });
      const firstReservation = reserveSystemEventEntries(key);
      enqueueSystemEvent("Second event", { sessionKey: key });
      const secondReservation = reserveSystemEventEntries(key);
      enqueueSystemEvent("Third event", { sessionKey: key });
      const thirdReservation = reserveSystemEventEntries(key);

      restoreSystemEventReservation(thirdReservation);
      restoreSystemEventReservation(firstReservation);
      restoreSystemEventReservation(secondReservation);

      expect(peekSystemEvents(key)).toEqual(["First event", "Second event", "Third event"]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("reapplies the max queue cap when restoring reserved events", () => {
    const key = "agent:main:test-restore-cap";
    for (let index = 1; index <= 20; index += 1) {
      enqueueSystemEvent(`event ${index}`, { sessionKey: key });
    }
    const reservation = reserveSystemEventEntries(key);
    for (let index = 21; index <= 25; index += 1) {
      enqueueSystemEvent(`event ${index}`, { sessionKey: key });
    }

    restoreSystemEventReservation(reservation);

    expect(peekSystemEvents(key)).toEqual(
      Array.from({ length: 20 }, (_, index) => `event ${index + 6}`),
    );
  });

  it("restores reserved events when formatting throws during peek", async () => {
    const key = "agent:main:test-peek-restore-on-throw";
    enqueueSystemEvent("First event", { sessionKey: key });
    vi.mocked(buildChannelSummary).mockRejectedValueOnce(new Error("summary failed"));

    await expect(
      peekFormattedSystemEvents({
        cfg,
        sessionKey: key,
        isMainSession: true,
        isNewSession: true,
      }),
    ).rejects.toThrow("summary failed");

    expect(peekSystemEvents(key)).toEqual(["First event"]);
  });

  it("restores first-turn main-session summaries when a peeked turn is skipped", async () => {
    vi.mocked(buildChannelSummary).mockResolvedValueOnce(["Slack (configured)"]);

    const preview = await peekFormattedSystemEvents({
      cfg,
      sessionKey: mainKey,
      isMainSession: true,
      isNewSession: true,
    });

    expect(preview.reservation).toBeUndefined();
    expect(preview.text).toContain("System: Slack (configured)");

    restorePeekedSystemEvents(preview);

    const replayed = await peekFormattedSystemEvents({
      cfg,
      sessionKey: mainKey,
      isMainSession: true,
      isNewSession: false,
    });

    expect(replayed.text).toContain("System: Slack (configured)");
    commitPeekedSystemEvents(replayed);
  });

  it("does not replay a consumed first-turn summary after another reservation restores", async () => {
    vi.mocked(buildChannelSummary).mockResolvedValue(["Slack (configured)"]);

    const committedPreview = await peekFormattedSystemEvents({
      cfg,
      sessionKey: mainKey,
      isMainSession: true,
      isNewSession: true,
    });
    const skippedPreview = await peekFormattedSystemEvents({
      cfg,
      sessionKey: mainKey,
      isMainSession: true,
      isNewSession: true,
    });

    expect(committedPreview.text).toContain("System: Slack (configured)");
    expect(skippedPreview.text).toContain("System: Slack (configured)");

    commitPeekedSystemEvents(committedPreview);
    restorePeekedSystemEvents(skippedPreview);

    const replayed = await peekFormattedSystemEvents({
      cfg,
      sessionKey: mainKey,
      isMainSession: true,
      isNewSession: false,
    });

    expect(replayed.text).toBeUndefined();
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
