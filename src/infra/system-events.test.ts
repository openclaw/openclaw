// Covers system event queue routing, draining, and formatting.

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-system-events.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/io.js";
import { resolveMainSessionKey } from "../config/sessions/main-session.js";
import {
  enqueueRoutedSystemEvent,
  enqueueSystemEvent as enqueueSdkSystemEvent,
  peekSystemEventEntries as peekSdkSystemEventEntries,
} from "../plugin-sdk/system-event-runtime.js";
import { isCronSystemEvent } from "./heartbeat-events-filter.js";
import { withSystemEventOwner } from "./system-event-ownership.js";
import {
  consumeSelectedSystemEventEntries,
  drainSystemEventEntries,
  enqueueSystemEvent,
  enqueueSystemEventEntry,
  enqueueSystemEventWithReceipt,
  hasSystemEvents,
  isSystemEventContextChanged,
  peekSystemEventEntries,
  peekSystemEvents,
  resetSystemEventsForTest,
  resolveSystemEventDeliveryContext,
  type SystemEvent,
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
    agentId: "main",
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not leak session-scoped events into main", async () => {
    enqueueSystemEvent("Discord reaction added: ✅", {
      sessionKey: "agent:main:discord:group:123",
      contextKey: "discord:reaction:added:msg:user:✅",
    });

    expect(peekSystemEvents(mainKey)).toStrictEqual([]);
    expect(peekSystemEvents("agent:main:discord:group:123")).toEqual([
      "Discord reaction added: ✅",
    ]);

    // Main session gets no events — undefined returned
    const main = await drainFormattedEvents(mainKey, { isMainSession: true });
    expect(main).toBeUndefined();
    // Discord events untouched by main drain
    expect(peekSystemEvents("agent:main:discord:group:123")).toEqual([
      "Discord reaction added: ✅",
    ]);

    // Discord session gets its own events block
    const discord = await drainFormattedEvents("agent:main:discord:group:123");
    expect(discord).toMatch(/System:\s+\[[^\]]+\] Discord reaction added: ✅/);
    expect(peekSystemEvents("agent:main:discord:group:123")).toStrictEqual([]);
  });

  it("requires an explicit session key", () => {
    expect(() => enqueueSystemEvent("Node: Mac Studio", { sessionKey: " " })).toThrow("sessionKey");
  });

  it.each(["main", "global", "unknown"])(
    "resolves legacy SDK %s only at its configured owner boundary",
    (alias) => {
      const previous = getRuntimeConfigSnapshot();
      try {
        setRuntimeConfigSnapshot({
          agents: { entries: { alpha: { default: true }, beta: {} } },
          session: { mainKey: "work" },
        });
        expect(() => enqueueSystemEvent("Unbound", { sessionKey: alias })).toThrow(
          "agent-qualified",
        );
        expect(enqueueSdkSystemEvent("Legacy caller", { sessionKey: alias })).toBe(true);
        const suffix = alias === "main" ? "work" : alias;
        expect(peekSystemEvents(`agent:alpha:${suffix}`)).toEqual(["Legacy caller"]);
        expect(peekSystemEvents(`agent:beta:${suffix}`)).toEqual([]);
        enqueueRoutedSystemEvent("Owned caller", { agentId: " BETA ", sessionKey: alias });
        expect(peekSdkSystemEventEntries(alias, " BETA ").map((event) => event.text)).toEqual([
          "Owned caller",
        ]);
        expect(peekSdkSystemEventEntries(alias).map((event) => event.text)).toEqual([
          "Legacy caller",
        ]);
        expect(
          enqueueSdkSystemEvent("Runtime owner", { sessionKey: alias, agentId: " BETA " }),
        ).toBe(true);
        expect(peekSystemEvents(`agent:beta:${suffix}`)).toEqual(["Owned caller", "Runtime owner"]);
        expect(() =>
          enqueueSdkSystemEvent("Mismatched owner", {
            sessionKey: `agent:alpha:${suffix}`,
            agentId: "beta",
          }),
        ).toThrow("owner does not match");
        expect(() => peekSdkSystemEventEntries(`agent:alpha:${suffix}`, "beta")).toThrow(
          "owner does not match",
        );
        setRuntimeConfigSnapshot({
          agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } },
        });
        expect(() => enqueueSdkSystemEvent("Ambiguous", { sessionKey: alias })).toThrow();
        expect(peekSystemEvents(`agent:alpha:${suffix}`)).toEqual(["Legacy caller"]);
      } finally {
        if (previous) {
          setRuntimeConfigSnapshot(previous);
        } else {
          clearRuntimeConfigSnapshot();
        }
      }
    },
  );

  it.each(
    ["!!!", "", " "].flatMap((agentId) =>
      ["global", "agent:main:global"].flatMap((sessionKey) =>
        ["enqueue", "peek", "routed"].map((operation) => ({ agentId, sessionKey, operation })),
      ),
    ),
  )("rejects SDK $operation with owner '$agentId' for $sessionKey", (params) => {
    const previous = getRuntimeConfigSnapshot();
    try {
      setRuntimeConfigSnapshot({
        agents: { entries: { main: { default: true }, beta: {} } },
        session: { scope: "global" },
      });
      enqueueSystemEvent("Main canary", { sessionKey: "agent:main:global" });
      enqueueSystemEvent("Beta canary", { sessionKey: "agent:beta:global" });
      expect(() => {
        const { sessionKey, agentId, operation } = params;
        if (operation === "peek") {
          return peekSdkSystemEventEntries(sessionKey, agentId);
        }
        return operation === "routed"
          ? enqueueRoutedSystemEvent("Invalid owner", { sessionKey, agentId })
          : enqueueSdkSystemEvent("Invalid owner", { sessionKey, agentId });
      }).toThrow(/agentId/);
      expect(peekSystemEvents("agent:main:global")).toEqual(["Main canary"]);
      expect(peekSystemEvents("agent:beta:global")).toEqual(["Beta canary"]);
    } finally {
      if (previous) {
        setRuntimeConfigSnapshot(previous);
      } else {
        clearRuntimeConfigSnapshot();
      }
    }
  });

  it.each(["global", "agent:beta-team:global"])(
    "preserves representable SDK owner normalization for %s",
    (sessionKey) => {
      const previous = getRuntimeConfigSnapshot();
      try {
        setRuntimeConfigSnapshot({ agents: { entries: { "beta-team": { default: true } } } });
        expect(enqueueSdkSystemEvent("Team event", { sessionKey, agentId: " Beta Team " })).toBe(
          true,
        );
        expect(
          peekSdkSystemEventEntries(sessionKey, " Beta Team ").map((event) => event.text),
        ).toEqual(["Team event"]);
        expect(peekSystemEvents("agent:main:global")).toEqual([]);
      } finally {
        if (previous) {
          setRuntimeConfigSnapshot(previous);
        } else {
          clearRuntimeConfigSnapshot();
        }
      }
    },
  );

  it("requires a context key when replacing an event", () => {
    expect(() =>
      enqueueSystemEvent("Voice roster", {
        sessionKey: "agent:main:main",
        contextKey: " ",
        replace: true,
      }),
    ).toThrow("contextKey");
  });

  it("replaces one keyed event without evicting unrelated queued events", () => {
    const key = "agent:main:test-upsert";
    enqueueSystemEvent("Voice roster 0", {
      sessionKey: key,
      contextKey: "discord:voice-membership:default:g1",
      replace: true,
    });
    for (let index = 0; index < 19; index += 1) {
      enqueueSystemEvent(`unrelated ${index}`, {
        sessionKey: key,
        contextKey: `unrelated:${index}`,
      });
    }
    for (let index = 1; index <= 25; index += 1) {
      enqueueSystemEvent(`Voice roster ${index}`, {
        sessionKey: key,
        contextKey: "discord:voice-membership:default:g1",
        replace: true,
      });
    }

    expect(peekSystemEvents(key)).toHaveLength(20);
    expect(peekSystemEvents(key).filter((event) => event.startsWith("unrelated "))).toHaveLength(
      19,
    );
    expect(peekSystemEvents(key).at(-1)).toBe("Voice roster 25");
  });

  it("consumes unchanged inspected events when a keyed event is replaced in flight", () => {
    const key = "agent:main:test-upsert-consume-race";
    enqueueSystemEvent("Voice roster 0", {
      sessionKey: key,
      contextKey: "discord:voice-membership:default:g1",
      replace: true,
    });
    enqueueSystemEvent("Exec completed", { sessionKey: key, contextKey: "exec:job-1" });
    const inspected = peekSystemEventEntries(key);

    enqueueSystemEvent("Voice roster 1", {
      sessionKey: key,
      contextKey: "discord:voice-membership:default:g1",
      replace: true,
    });

    expect(consumeSelectedSystemEventEntries(key, inspected).map((event) => event.text)).toEqual([
      "Exec completed",
    ]);
    expect(peekSystemEvents(key)).toEqual(["Voice roster 1"]);
  });

  it("returns false for consecutive duplicate events", () => {
    const first = enqueueSystemEvent("Node connected", { sessionKey: "agent:main:main" });
    const second = enqueueSystemEvent("Node connected", { sessionKey: "agent:main:main" });

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("normalizes structural case without changing opaque channel IDs", () => {
    expect(enqueueSystemEvent("Global", { sessionKey: "AGENT:Ops:GLOBAL" })).toBe(true);
    expect(enqueueSystemEvent("Global", { sessionKey: "agent:ops:global" })).toBe(false);
    expect(peekSystemEvents("agent:ops:global")).toEqual(["Global"]);
    enqueueSystemEvent("Opaque room", { sessionKey: "AGENT:Ops:Signal:Group:AbC+123=" });
    expect(peekSystemEvents("agent:ops:signal:group:AbC+123=")).toEqual(["Opaque room"]);
    expect(peekSystemEvents("agent:ops:signal:group:abc+123=")).toEqual([]);
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
    expectDefined(peeked[0], "peeked[0] test invariant").text = "mutated";
    expect(peekSystemEvents(key)).toEqual(["Node connected"]);

    expect(drainSystemEventEntries(key).map((entry) => entry.text)).toEqual(["Node connected"]);
    expect(hasSystemEvents(key)).toBe(false);

    expect(enqueueSystemEvent("Node connected", { sessionKey: key })).toBe(true);
  });

  it("consumes only the inspected prefix and leaves later queued events intact", () => {
    const key = "agent:main:test-consume-prefix";
    enqueueSystemEvent("first", { sessionKey: key, contextKey: "cron:first" });
    const inspected = peekSystemEventEntries(key);
    enqueueSystemEvent("second", { sessionKey: key, contextKey: "cron:second" });

    expect(consumeSelectedSystemEventEntries(key, inspected).map((entry) => entry.text)).toEqual([
      "first",
    ]);
    expect(peekSystemEvents(key)).toEqual(["second"]);
  });

  it("consumes selected inspected entries and preserves unselected queued events", () => {
    const key = "agent:main:test-consume-selected";
    enqueueSystemEvent("first", { sessionKey: key, contextKey: "event:first" });
    enqueueSystemEvent("second", { sessionKey: key, contextKey: "event:second" });
    enqueueSystemEvent("third", { sessionKey: key, contextKey: "event:third" });
    const selected = peekSystemEventEntries(key).filter((event) => event.text !== "second");

    expect(consumeSelectedSystemEventEntries(key, selected).map((entry) => entry.text)).toEqual([
      "first",
      "third",
    ]);
    expect(peekSystemEvents(key)).toEqual(["second"]);
  });

  it("removes an exact receipt once while preserving its sibling", () => {
    const key = "agent:main:test-receipt";
    const receipt = enqueueSystemEventWithReceipt("first", {
      sessionKey: ` ${key} `,
      contextKey: "exec:first",
    });
    expect(receipt).not.toBeNull();
    enqueueSystemEvent("sibling", { sessionKey: key, contextKey: "exec:sibling" });

    expect(receipt?.()).toBe(true);
    expect(peekSystemEvents(key)).toEqual(["sibling"]);
    expect(receipt?.()).toBe(false);
  });

  it("keeps structurally identical receipt-owned siblings distinct", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T00:00:00Z"));
    const key = "agent:main:test-identical-receipts";
    const options = { sessionKey: key, contextKey: "exec:reused-slug" };
    const first = enqueueSystemEventWithReceipt("completed", options, {
      allowDuplicate: true,
    });
    const second = enqueueSystemEventWithReceipt("completed", options, {
      allowDuplicate: true,
    });
    const queued = peekSystemEventEntries(key);

    expect(queued[0]).toEqual({ ...queued[1], id: queued[0]?.id });
    expect(queued[0]?.id).not.toBe(queued[1]?.id);
    expect(second?.()).toBe(true);
    expect(peekSystemEventEntries(key).map((event) => event.id)).toEqual([queued[0]?.id]);
    expect(second?.()).toBe(false);
    expect(first?.()).toBe(true);
    expect(peekSystemEventEntries(key)).toStrictEqual([]);
  });

  it.each([
    {
      name: "object spread",
      copy: (event: SystemEvent): SystemEvent => ({ ...event }),
    },
    {
      name: "structuredClone",
      copy: (event: SystemEvent): SystemEvent => structuredClone(event),
    },
    {
      name: "JSON round trip",
      // oxlint-disable-next-line unicorn/prefer-structured-clone -- This case exercises JSON transport.
      copy: (event: SystemEvent): SystemEvent => JSON.parse(JSON.stringify(event)) as SystemEvent,
    },
  ])("does not consume an identical successor from a stale copy: $name", ({ copy }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T00:00:00Z"));

    const key = "agent:main:test-stale-copied-snapshot";
    const options = {
      sessionKey: key,
      contextKey: "build:123",
      deliveryContext: { channel: "telegram", to: "-100123", threadId: "42" },
    };
    const original = expectDefined(
      enqueueSystemEventEntry("Build completed", options),
      "original event",
    );
    const staleCopy = copy(original);
    expect(staleCopy.id).toBe(original.id);

    expect(consumeSelectedSystemEventEntries(key, [original]).map((event) => event.id)).toEqual([
      original.id,
    ]);
    const successor = expectDefined(
      enqueueSystemEventEntry("Build completed", options),
      "successor event",
    );
    expect(successor.id).not.toBe(original.id);
    expect(successor).toEqual({ ...original, id: successor.id });

    expect(consumeSelectedSystemEventEntries(key, [staleCopy])).toStrictEqual([]);
    expect(peekSystemEventEntries(key).map((event) => event.id)).toEqual([successor.id]);

    expect(consumeSelectedSystemEventEntries(key, [successor]).map((event) => event.id)).toEqual([
      successor.id,
    ]);
    expect(peekSystemEventEntries(key)).toStrictEqual([]);
  });

  it("matches consumed delivery contexts through normalized route identity", () => {
    const key = "agent:main:test-consume-route-context";
    enqueueSystemEvent("first", {
      sessionKey: key,
      deliveryContext: {
        channel: "telegram",
        to: "-100123",
        threadId: 42.9,
      },
    });
    const current = expectDefined(peekSystemEventEntries(key)[0], "queued event");
    const legacyCopy: SystemEvent = {
      text: current.text,
      ts: current.ts,
      contextKey: current.contextKey,
      deliveryContext: {
        channel: current.deliveryContext?.channel,
        to: current.deliveryContext?.to,
        threadId: "42",
      },
    };
    expect(legacyCopy).not.toHaveProperty("id");

    expect(consumeSelectedSystemEventEntries(key, [legacyCopy]).map((entry) => entry.text)).toEqual(
      ["first"],
    );
    expect(peekSystemEvents(key)).toStrictEqual([]);
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
    expectDefined(
      expectDefined(events[0], "first system event").deliveryContext,
      "first event delivery context",
    ).to = "mutated";

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

  it("does not evict another agent's global notification when one queue fills", async () => {
    enqueueSystemEvent(
      "Beta result is ready",
      withSystemEventOwner({ sessionKey: "global" }, "beta"),
    );
    for (let index = 0; index < 25; index += 1) {
      enqueueSystemEvent(
        `Alpha progress ${index}`,
        withSystemEventOwner({ sessionKey: "global" }, "alpha"),
      );
    }
    const beta = await drainFormattedEvents("global", { agentId: "beta" });
    expect(beta).toContain("Beta result is ready");
    expect(beta).not.toContain("Alpha progress");
    const alpha = await drainFormattedEvents("global", { agentId: "alpha" });
    expect(alpha).toContain("Alpha progress 24");
    expect(alpha).not.toContain("Beta result is ready");
  });

  it("qualifies enqueue options without changing the caller's session target", () => {
    const options = { sessionKey: "global", contextKey: "hook:ready" };
    enqueueSystemEvent("Ready", withSystemEventOwner(options, "alpha"));
    expect(options).toEqual({ sessionKey: "global", contextKey: "hook:ready" });
    expect(peekSystemEvents("agent:alpha:global")).toEqual(["Ready"]);
  });

  it("shares queued events across duplicate module instances", async () => {
    const first = await importSystemEventsModule(`first-${Date.now()}`);
    const second = await importSystemEventsModule(`second-${Date.now()}`);
    const key = "agent:main:test-duplicate-module";

    first.resetSystemEventsForTest();
    second.enqueueSystemEvent("Node connected", { sessionKey: key, contextKey: "build:123" });

    const entries = first.peekSystemEventEntries(key);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.text).toBe("Node connected");
    expect(entries[0]?.contextKey).toBe("build:123");
    expect(first.isSystemEventContextChanged(key, "build:123")).toBe(false);
    expect(first.drainSystemEvents(key)).toEqual(["Node connected"]);

    first.resetSystemEventsForTest();
  });

  it("keeps per-agent queues isolated across duplicate module instances", async () => {
    const first = await importSystemEventsModule(`owned-first-${Date.now()}`);
    const second = await importSystemEventsModule(`owned-second-${Date.now()}`);
    const alpha = "agent:alpha:global";
    const beta = "agent:beta:global";
    const options = { contextKey: "hook:shared" };
    expect(first.enqueueSystemEvent("Hook finished", { ...options, sessionKey: alpha })).toBe(true);
    expect(second.enqueueSystemEvent("Hook finished", { ...options, sessionKey: alpha })).toBe(
      false,
    );
    expect(second.enqueueSystemEvent("Hook finished", { ...options, sessionKey: beta })).toBe(true);
    expect(first.drainSystemEvents(beta)).toEqual(["Hook finished"]);
    expect(second.peekSystemEvents(alpha)).toEqual(["Hook finished"]);
    expect(first.drainSystemEvents(alpha)).toEqual(["Hook finished"]);
    expect(second.peekSystemEvents(beta)).toEqual([]);
  });

  it("filters heartbeat/noise lines, returning undefined", async () => {
    const key = "agent:main:test-heartbeat-filter";
    enqueueSystemEvent("Read HEARTBEAT.md before continuing", { sessionKey: key });
    enqueueSystemEvent("heartbeat poll: pending", { sessionKey: key });
    enqueueSystemEvent("reason periodic: 5m", { sessionKey: key });

    const result = await drainFormattedEvents(key);
    expect(result).toBeUndefined();
    expect(peekSystemEvents(key)).toStrictEqual([]);
  });

  it("leaves exec completion events queued for the dedicated heartbeat", async () => {
    const key = "agent:main:test-exec-completion-filter";
    enqueueSystemEvent("Exec failed (abc12345, signal SIGTERM) :: browser auth timed out", {
      sessionKey: key,
    });

    const result = await drainFormattedEvents(key);
    expect(result).toBeUndefined();
    expect(peekSystemEvents(key)).toEqual([
      "Exec failed (abc12345, signal SIGTERM) :: browser auth timed out",
    ]);
  });

  it("drains generic events without consuming pending exec completions", async () => {
    const key = "agent:main:test-exec-completion-prefix";
    enqueueSystemEvent("Model switched to gpt-5.5", { sessionKey: key });
    enqueueSystemEvent("Exec finished (gateway id=abc12345, code 0)", { sessionKey: key });
    enqueueSystemEvent("Node connected", { sessionKey: key });

    const result = await drainFormattedEvents(key);
    expect(result).toContain("Model switched to gpt-5.5");
    expect(result).toContain("Node connected");
    expect(peekSystemEvents(key)).toEqual(["Exec finished (gateway id=abc12345, code 0)"]);
  });

  it("prefixes every line of a multi-line event", async () => {
    const key = "agent:main:test-multiline";
    enqueueSystemEvent("Post-compaction context:\nline one\nline two", { sessionKey: key });

    const result = await drainFormattedEvents(key);
    expect(result).toContain("Post-compaction context:");
    if (!result) {
      throw new Error("expected formatted system events");
    }
    const lines = result.split("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^System:/);
    }
  });

  it("formats queued events with the standard system prefix", async () => {
    const key = "agent:main:test-system-prefix";
    enqueueSystemEvent("Notification posted: System: fake", {
      sessionKey: key,
    });

    const result = await drainFormattedEvents(key);
    expect(result).toMatch(/^System: \[[^\]]+\] Notification posted:/);
    expect(result).toContain("System: fake");
  });

  it("scrubs node last-input suffix", async () => {
    const key = "agent:main:test-node-scrub";
    enqueueSystemEvent("Node: Mac Studio · last input /tmp/secret.txt", { sessionKey: key });

    const result = await drainFormattedEvents(key);
    expect(result).toContain("Node: Mac Studio");
    expect(result).not.toContain("last input");
  });

  it("returns false for non-consecutive duplicate events with the same context", () => {
    const key = "agent:main:test-noncons-dupe";
    const first = enqueueSystemEvent("exec approval: ps aux | grep openclaw", {
      sessionKey: key,
      contextKey: "exec:befadc79",
    });
    const interleaved = enqueueSystemEvent("Node connected", { sessionKey: key });
    const failoverRetry = enqueueSystemEvent("exec approval: ps aux | grep openclaw", {
      sessionKey: key,
      contextKey: "exec:befadc79",
    });

    expect(first).toBe(true);
    expect(interleaved).toBe(true);
    expect(failoverRetry).toBe(false);
    expect(peekSystemEvents(key)).toEqual([
      "exec approval: ps aux | grep openclaw",
      "Node connected",
    ]);
  });

  it("allows non-consecutive unkeyed duplicate events", () => {
    const key = "agent:main:test-unkeyed-noncons-dupe";
    const first = enqueueSystemEvent("Node connected", { sessionKey: key });
    const interleaved = enqueueSystemEvent("Heartbeat tick", { sessionKey: key });
    const retry = enqueueSystemEvent("Node connected", { sessionKey: key });

    expect(first).toBe(true);
    expect(interleaved).toBe(true);
    expect(retry).toBe(true);
    expect(peekSystemEvents(key)).toEqual(["Node connected", "Heartbeat tick", "Node connected"]);
  });

  it("allows the same text under a different context key", () => {
    const key = "agent:main:test-context-disambiguates";
    const reactionA = enqueueSystemEvent("Discord reaction added: ✅", {
      sessionKey: key,
      contextKey: "discord:reaction:msg-1",
    });
    const reactionB = enqueueSystemEvent("Discord reaction added: ✅", {
      sessionKey: key,
      contextKey: "discord:reaction:msg-2",
    });

    expect(reactionA).toBe(true);
    expect(reactionB).toBe(true);
    expect(peekSystemEventEntries(key)).toHaveLength(2);
  });

  it("allows the same text and context under a different delivery route", () => {
    const key = "agent:main:test-context-route-disambiguates";
    const first = enqueueSystemEvent("Build completed", {
      sessionKey: key,
      contextKey: "build:123",
      deliveryContext: { channel: "telegram", to: "100" },
    });
    const second = enqueueSystemEvent("Build completed", {
      sessionKey: key,
      contextKey: "build:123",
      deliveryContext: { channel: "telegram", to: "200" },
    });

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(peekSystemEventEntries(key)).toHaveLength(2);
  });

  it("preserves lastContextKey when a duplicate is skipped", () => {
    const key = "agent:main:test-context-preserved";
    enqueueSystemEvent("Node connected", { sessionKey: key, contextKey: "build:123" });

    const skipped = enqueueSystemEvent("Node connected", {
      sessionKey: key,
      contextKey: "build:123",
    });

    expect(skipped).toBe(false);
    expect(isSystemEventContextChanged(key, "build:123")).toBe(false);
  });

  it("does not overwrite lastContextKey when the caller omits a contextKey", () => {
    const key = "agent:main:test-no-context-clobber";
    enqueueSystemEvent("Node connected", { sessionKey: key, contextKey: "build:123" });
    enqueueSystemEvent("Heartbeat tick", { sessionKey: key });

    expect(isSystemEventContextChanged(key, "build:123")).toBe(false);
  });

  it("preserves lastContextKey from the newest contextful event after partial consume", () => {
    const key = "agent:main:test-context-preserved-after-consume";
    enqueueSystemEvent("startup", { sessionKey: key });
    enqueueSystemEvent("contextful", { sessionKey: key, contextKey: "build:123" });
    enqueueSystemEvent("unkeyed followup", { sessionKey: key });
    const inspected = peekSystemEventEntries(key).slice(0, 1);

    expect(consumeSelectedSystemEventEntries(key, inspected).map((entry) => entry.text)).toEqual([
      "startup",
    ]);
    expect(isSystemEventContextChanged(key, "build:123")).toBe(false);
  });

  it("allows a keyed duplicate after the original is evicted", () => {
    const key = "agent:main:test-keyed-duplicate-after-eviction";
    enqueueSystemEvent("Build completed", { sessionKey: key, contextKey: "build:123" });
    for (let index = 0; index < 20; index += 1) {
      enqueueSystemEvent(`event ${index}`, { sessionKey: key, contextKey: `event:${index}` });
    }

    expect(
      enqueueSystemEvent("Build completed", { sessionKey: key, contextKey: "build:123" }),
    ).toBe(true);
  });

  it("allows a keyed duplicate after the original is consumed from the prefix", () => {
    const key = "agent:main:test-keyed-duplicate-after-prefix-consume";
    enqueueSystemEvent("Build completed", { sessionKey: key, contextKey: "build:123" });
    const inspected = peekSystemEventEntries(key);

    expect(consumeSelectedSystemEventEntries(key, inspected).map((entry) => entry.text)).toEqual([
      "Build completed",
    ]);
    expect(
      enqueueSystemEvent("Build completed", { sessionKey: key, contextKey: "build:123" }),
    ).toBe(true);
  });

  it("allows a keyed duplicate after the original is selectively consumed", () => {
    const key = "agent:main:test-keyed-duplicate-after-selected-consume";
    enqueueSystemEvent("Build completed", { sessionKey: key, contextKey: "build:123" });
    enqueueSystemEvent("Other event", { sessionKey: key, contextKey: "build:other" });
    const selected = peekSystemEventEntries(key).filter(
      (entry) => entry.text === "Build completed",
    );

    expect(consumeSelectedSystemEventEntries(key, selected).map((entry) => entry.text)).toEqual([
      "Build completed",
    ]);
    expect(
      enqueueSystemEvent("Build completed", { sessionKey: key, contextKey: "build:123" }),
    ).toBe(true);
  });

  it("consumes an inspected snapshot only from its canonical owner queue", () => {
    const alpha = "agent:alpha:global";
    const beta = "agent:beta:global";
    enqueueSystemEvent("Hook finished", { sessionKey: alpha, contextKey: "hook:shared" });
    enqueueSystemEvent("Hook finished", { sessionKey: beta, contextKey: "hook:shared" });
    const selected = peekSystemEventEntries(alpha);
    enqueueSystemEvent("Later alpha event", { sessionKey: alpha });
    expect(consumeSelectedSystemEventEntries(beta, selected)).toEqual([]);
    expect(consumeSelectedSystemEventEntries(alpha, selected).map((event) => event.text)).toEqual([
      "Hook finished",
    ]);
    expect(peekSystemEvents(beta)).toEqual(["Hook finished"]);
    expect(peekSystemEvents(alpha)).toEqual(["Later alpha event"]);
  });

  it("keeps routed global Slack and Discord events isolated by route owner", async () => {
    const slackRoute = { agentId: "alpha", sessionKey: "global" };
    const discordRoute = { agentId: "beta", sessionKey: "global" };
    enqueueRoutedSystemEvent("Slack event for alpha", slackRoute);
    enqueueRoutedSystemEvent("Discord event for beta", discordRoute);

    const alpha = await drainFormattedEvents("agent:alpha:global", { agentId: "alpha" });
    expect(alpha).toContain("Slack event for alpha");
    expect(alpha).not.toContain("Discord event for beta");
    expect(peekSystemEvents("agent:beta:global")).toEqual(["Discord event for beta"]);

    const beta = await drainFormattedEvents("agent:beta:global", { agentId: "beta" });
    expect(beta).toContain("Discord event for beta");
    expect(peekSystemEvents("agent:beta:global")).toStrictEqual([]);
  });

  it("rejects routed system events without an owner", () => {
    expect(() =>
      enqueueRoutedSystemEvent("Unbound event", { agentId: " ", sessionKey: "global" }),
    ).toThrow("route.agentId");
    expect(() =>
      enqueueRoutedSystemEvent("Unbound event", { agentId: "alpha", sessionKey: " " }),
    ).toThrow("sessionKey");
    expect(peekSystemEvents("agent:beta:global")).toStrictEqual([]);
  });

  it("replaces only the matching owner's keyed event", () => {
    const options = { contextKey: "hook:shared", replace: true };
    enqueueRoutedSystemEvent("Alpha pending", { agentId: "alpha", sessionKey: "global" }, options);
    enqueueRoutedSystemEvent("Beta pending", { agentId: "beta", sessionKey: "global" }, options);
    enqueueRoutedSystemEvent("Alpha finished", { agentId: "ALPHA", sessionKey: "global" }, options);
    expect(peekSystemEvents("agent:alpha:global")).toEqual(["Alpha finished"]);
    expect(peekSystemEvents("agent:beta:global")).toEqual(["Beta pending"]);
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
