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
  consumeSelectedSystemEventEntries as consumeSdkSystemEventEntries,
  enqueueRoutedSystemEvent,
  enqueueSystemEvent as enqueueSdkSystemEvent,
  peekSystemEventEntries as peekSdkSystemEventEntries,
} from "../plugin-sdk/system-event-runtime.js";
import { publishSystemEventStoreResolver, withSystemEventOwner } from "./system-event-ownership.js";
import {
  claimSystemEventTurn,
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

describe("delivery-owned system event selection", () => {
  beforeEach(() => resetSystemEventsForTest());
  afterEach(() => resetSystemEventsForTest());

  it.each([false, true])(
    "formats only live captured occurrences (consumed by another turn: %s)",
    async (consumed) => {
      const sessionKey = "agent:main:deferred-order-proof";
      enqueueSystemEvent("Restart first", {
        sessionKey,
        contextKey: "task:restart-sentinel:first",
      });
      enqueueSystemEvent("Newer instruction second", { sessionKey });
      const captured = peekSystemEventEntries(sessionKey);
      const retainedId = expectDefined(captured[0]?.id, "captured restart occurrence ID");
      if (consumed) {
        consumeSelectedSystemEventEntries(sessionKey, captured);
      }
      enqueueSystemEvent("Late arrival third", { sessionKey });
      const text = await drainFormattedSystemEvents({
        cfg: {},
        agentId: "main",
        sessionKey,
        isMainSession: false,
        isNewSession: false,
        events: captured,
        deferredEventIds: [retainedId],
      });
      if (consumed) {
        expect(text).toBeUndefined();
      } else {
        expect(text?.indexOf("Restart first")).toBeLessThan(
          text!.indexOf("Newer instruction second"),
        );
        expect(text).not.toContain("Late arrival third");
        expect(peekSystemEvents(sessionKey)).toEqual(["Restart first", "Late arrival third"]);
        consumeSelectedSystemEventEntries(sessionKey, [captured[0]!]);
      }
      expect(peekSystemEvents(sessionKey)).toEqual(["Late arrival third"]);
    },
  );
});

type SystemEventsModule = typeof import("./system-events.js");

const systemEventsModuleUrl = new URL("./system-events.ts", import.meta.url).href;

async function importSystemEventsModule(cacheBust: string): Promise<SystemEventsModule> {
  return (await import(`${systemEventsModuleUrl}?t=${cacheBust}`)) as SystemEventsModule;
}

const cfg: OpenClawConfig = {};
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
    publishSystemEventStoreResolver(undefined);
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

  it.each(["main", "global", "unknown"])(
    "resolves SDK %s only at its explicitly selected owner boundary",
    (alias) => {
      const previous = getRuntimeConfigSnapshot();
      try {
        setRuntimeConfigSnapshot({
          agents: { entries: { alpha: {}, beta: {} } },
          session: { mainKey: "work" },
        });
        expect(() => enqueueSystemEvent("Unbound", { sessionKey: alias })).toThrow(
          "agent-qualified",
        );
        expect(
          enqueueSdkSystemEvent("Legacy caller", { sessionKey: alias, agentId: "alpha" }),
        ).toBe(true);
        const suffix = alias === "main" ? "work" : alias;
        expect(peekSystemEvents(`agent:alpha:${suffix}`)).toEqual(["Legacy caller"]);
        expect(peekSystemEvents(`agent:beta:${suffix}`)).toEqual([]);
        enqueueRoutedSystemEvent("Owned caller", { agentId: " BETA ", sessionKey: alias });
        expect(peekSdkSystemEventEntries(alias, " BETA ").map((event) => event.text)).toEqual([
          "Owned caller",
        ]);
        expect(peekSdkSystemEventEntries(alias, "alpha").map((event) => event.text)).toEqual([
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

  it.each([
    { agentId: "!!!", sessionKey: "global", operation: "enqueue" },
    { agentId: "", sessionKey: "agent:main:global", operation: "enqueue" },
    { agentId: "!!!", sessionKey: "agent:main:global", operation: "peek" },
    { agentId: " ", sessionKey: "global", operation: "peek" },
    { agentId: "!!!", sessionKey: "global", operation: "routed" },
    { agentId: " ", sessionKey: "agent:main:global", operation: "routed" },
  ])("rejects SDK $operation with owner '$agentId' for $sessionKey", (params) => {
    const previous = getRuntimeConfigSnapshot();
    try {
      setRuntimeConfigSnapshot({
        agents: { entries: { main: {}, beta: {} } },
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
        setRuntimeConfigSnapshot({ agents: { entries: { "beta-team": {} } } });
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

  it("keeps structurally identical receipt-owned siblings distinct", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T00:00:00Z"));
    const key = "agent:main:test-identical-receipts";
    const options = { sessionKey: " " + key + " ", contextKey: "exec:reused-slug" };
    const first = enqueueSystemEventWithReceipt("completed", options, {
      allowDuplicate: true,
    });
    expect(first).not.toBeNull();
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

  it("does not consume an identical successor from a serialized stale snapshot", () => {
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
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercises a serialized SDK snapshot.
    const staleCopy: SystemEvent = JSON.parse(JSON.stringify(original));
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
    expect(peekSystemEvents("agent:alpha:global")).toEqual(
      Array.from({ length: 20 }, (_, index) => "Alpha progress " + (index + 5)),
    );
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
    expect(first.peekSystemEventEntries(alpha)).toMatchObject([
      { text: "Hook finished", contextKey: "hook:shared" },
    ]);
    expect(first.isSystemEventContextChanged(alpha, "hook:shared")).toBe(false);
    expect(first.drainSystemEvents(beta)).toEqual(["Hook finished"]);
    expect(second.peekSystemEvents(alpha)).toEqual(["Hook finished"]);
    expect(first.drainSystemEvents(alpha)).toEqual(["Hook finished"]);
    expect(second.peekSystemEvents(beta)).toEqual([]);
  });

  it("leaves an owned occurrence pending when an unrelated user drains its context", async () => {
    const key = "agent:main:test-owned-completion";
    const occurrence = expectDefined(
      enqueueSystemEventEntry("Build completed", { sessionKey: key }),
      "owned occurrence",
    );
    const cancelled = vi.fn();
    const owner = expectDefined(
      claimSystemEventTurn(key, occurrence, cancelled, "main"),
      "occurrence owner",
    );
    enqueueSystemEvent("Node connected", { sessionKey: key });

    expect(await drainFormattedEvents(key)).toContain("Node connected");
    expect(await drainFormattedEvents(key)).toBeUndefined();
    expect(peekSystemEventEntries(key).map((event) => event.id)).toEqual([occurrence.id]);
    expect(cancelled).not.toHaveBeenCalled();

    owner.start();
    expect(peekSystemEvents(key)).toEqual([]);
    expect(cancelled).not.toHaveBeenCalled();
    expect(owner.cancel()).toBe(false);
  });

  it("drains ordinary notices regardless of text that formerly selected heartbeat execution", async () => {
    const key = "agent:main:test-ordinary-notices";
    const notices = [
      "Read HEARTBEAT.md before continuing",
      "heartbeat poll: pending",
      "reason periodic: 5m",
      "Exec finished (gateway id=abc12345, code 0)",
      "Exec failed (abc12345, signal SIGTERM) :: browser auth timed out",
    ];
    for (const text of notices) {
      enqueueSystemEvent(text, { sessionKey: key });
    }

    const result = await drainFormattedEvents(key);
    for (const text of notices) {
      expect(result).toContain(text);
    }
    expect(peekSystemEvents(key)).toEqual([]);
  });

  it("cancels only the claimed occurrence among identical pending turns", () => {
    const key = "agent:main:test-owned-identical";
    const create = () =>
      expectDefined(
        enqueueSystemEventEntry(
          "Build completed",
          { sessionKey: key, contextKey: "build:reused" },
          { allowDuplicate: true },
        ),
        "queued occurrence",
      );
    const first = create();
    const second = create();
    const firstCancelled = vi.fn();
    const secondCancelled = vi.fn();
    const firstOwner = expectDefined(
      claimSystemEventTurn(key, first, firstCancelled, "main"),
      "first owner",
    );
    const secondOwner = expectDefined(
      claimSystemEventTurn(key, second, secondCancelled, "main"),
      "second owner",
    );

    expect(firstOwner.cancel()).toBe(true);
    expect(firstOwner.cancel()).toBe(false);
    expect(firstCancelled).toHaveBeenCalledOnce();
    expect(secondCancelled).not.toHaveBeenCalled();
    expect(peekSystemEventEntries(key).map((event) => event.id)).toEqual([second.id]);
    expect(() => firstOwner.start()).toThrow("cancelled before admission");

    secondOwner.start();
    expect(peekSystemEvents(key)).toEqual([]);
    expect(secondCancelled).not.toHaveBeenCalled();
  });

  it.each(["store replacement", "teardown"] as const)(
    "retires pending occurrence custody on %s without cancelling an already started turn",
    (retirement) => {
      const key = "agent:main:test-owned-retirement";
      publishSystemEventStoreResolver(() => "/original/agent.sqlite");
      const startedCancelled = vi.fn();
      const pendingCancelled = vi.fn();
      const create = (text: string, cancel: () => void) => {
        const occurrence = expectDefined(
          enqueueSystemEventEntry(text, { sessionKey: key }),
          "queued occurrence",
        );
        return expectDefined(claimSystemEventTurn(key, occurrence, cancel, "main"), "owner");
      };
      create("Started", startedCancelled).start();
      const pending = create("Pending", pendingCancelled);

      if (retirement === "store replacement") {
        publishSystemEventStoreResolver(() => "/replacement/agent.sqlite");
      } else {
        resetSystemEventsForTest();
      }

      expect(pendingCancelled).toHaveBeenCalledOnce();
      expect(startedCancelled).not.toHaveBeenCalled();
      expect(peekSystemEvents(key)).toEqual([]);
      expect(() => pending.start()).toThrow("cancelled before admission");
      expect(pending.cancel()).toBe(false);
    },
  );

  it.each([
    {
      text: "Post-compaction context:\nline one\nline two",
      retained: "Post-compaction context:",
      removed: undefined,
    },
    {
      text: "Notification posted: System: fake",
      retained: "System: fake",
      removed: undefined,
    },
    {
      text: "Node: Mac Studio · last input /tmp/secret.txt",
      retained: "Node: Mac Studio",
      removed: "last input",
    },
  ])("formats and sanitizes $text", async ({ text, retained, removed }) => {
    const key = "agent:main:format";
    enqueueSystemEvent(text, { sessionKey: key });
    const result = expectDefined(await drainFormattedEvents(key), "formatted system event");
    expect(result).toMatch(/^System: \[[^\]]+\] /);
    expect(result).toContain(retained);
    if (retained === "System: fake") {
      expect(result).toMatch(/^System: \[[^\]]+\] Notification posted:/);
    }
    for (const line of result.split("\n")) {
      expect(line).toMatch(/^System:/);
    }
    if (removed) {
      expect(result).not.toContain(removed);
    }
  });

  it.each([
    {
      name: "consecutive unkeyed",
      keyed: false,
      interleaved: false,
      change: "none",
      accepted: false,
    },
    { name: "interleaved keyed", keyed: true, interleaved: true, change: "none", accepted: false },
    {
      name: "interleaved unkeyed",
      keyed: false,
      interleaved: true,
      change: "none",
      accepted: true,
    },
    {
      name: "different context",
      keyed: true,
      interleaved: false,
      change: "context",
      accepted: true,
    },
    { name: "different route", keyed: true, interleaved: false, change: "route", accepted: true },
  ])("deduplicates by identity: $name", ({ keyed, interleaved, change, accepted }) => {
    const key = "agent:main:dedupe";
    const options = {
      sessionKey: key,
      contextKey: keyed ? "build:123" : undefined,
      deliveryContext: change === "route" ? { channel: "telegram", to: "100" } : undefined,
    };
    expect(enqueueSystemEvent("Build completed", options)).toBe(true);
    if (interleaved) {
      expect(enqueueSystemEvent("Node connected", { sessionKey: key })).toBe(true);
    }
    expect(
      enqueueSystemEvent("Build completed", {
        ...options,
        contextKey: change === "context" ? "build:456" : options.contextKey,
        deliveryContext: change === "route" ? { channel: "telegram", to: "200" } : undefined,
      }),
    ).toBe(accepted);
    expect(peekSystemEvents(key)).toEqual([
      "Build completed",
      ...(interleaved ? ["Node connected"] : []),
      ...(accepted ? ["Build completed"] : []),
    ]);
    expect(peekSystemEventEntries(key)).toHaveLength(1 + Number(interleaved) + Number(accepted));
    if (keyed && change === "none") {
      expect(isSystemEventContextChanged(key, "build:123")).toBe(false);
    }
  });

  it("preserves lastContextKey from the newest contextful event after partial consume", () => {
    const key = "agent:main:test-context-preserved-after-consume";
    enqueueSystemEvent("startup", { sessionKey: key });
    enqueueSystemEvent("contextful", { sessionKey: key, contextKey: "build:123" });
    expect(enqueueSystemEvent("contextful", { sessionKey: key, contextKey: "build:123" })).toBe(
      false,
    );
    expect(isSystemEventContextChanged(key, "build:123")).toBe(false);
    enqueueSystemEvent("unkeyed followup", { sessionKey: key });
    expect(isSystemEventContextChanged(key, "build:123")).toBe(false);
    const inspected = peekSystemEventEntries(key).slice(0, 1);

    expect(consumeSelectedSystemEventEntries(key, inspected).map((entry) => entry.text)).toEqual([
      "startup",
    ]);
    expect(isSystemEventContextChanged(key, "build:123")).toBe(false);
  });

  it.each(["eviction", "prefix", "selected"] as const)(
    "allows a keyed duplicate after %s removal",
    (removal) => {
      const key = "agent:main:duplicate-after-removal";
      const options = { sessionKey: key, contextKey: "build:123" };
      enqueueSystemEvent("Build completed", options);
      const selected = peekSystemEventEntries(key);
      if (removal === "eviction") {
        for (let index = 0; index < 20; index++) {
          enqueueSystemEvent("event " + index, { sessionKey: key, contextKey: "event:" + index });
        }
      } else {
        if (removal === "selected") {
          enqueueSystemEvent("Other event", { sessionKey: key, contextKey: "build:other" });
        }
        expect(consumeSelectedSystemEventEntries(key, selected).map((event) => event.text)).toEqual(
          ["Build completed"],
        );
      }
      expect(enqueueSystemEvent("Build completed", options)).toBe(true);
    },
  );

  it("consumes an inspected snapshot only from its canonical owner queue", () => {
    const alpha = "agent:alpha:global";
    const beta = "agent:beta:global";
    enqueueSdkSystemEvent("Hook finished", { sessionKey: alpha, contextKey: "hook:shared" });
    enqueueSdkSystemEvent("Hook finished", { sessionKey: beta, contextKey: "hook:shared" });
    const selected = peekSdkSystemEventEntries(alpha);
    enqueueSdkSystemEvent("Later alpha event", { sessionKey: alpha });
    expect(consumeSdkSystemEventEntries(beta, selected)).toEqual([]);
    expect(consumeSdkSystemEventEntries(alpha, selected).map((event) => event.text)).toEqual([
      "Hook finished",
    ]);
    expect(peekSdkSystemEventEntries(beta).map((event) => event.text)).toEqual(["Hook finished"]);
    expect(peekSdkSystemEventEntries(alpha).map((event) => event.text)).toEqual([
      "Later alpha event",
    ]);
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

  it.each([
    { run: () => enqueueSystemEvent("Unbound", { sessionKey: " " }), error: "sessionKey" },
    {
      run: () =>
        enqueueSystemEvent("Roster", {
          sessionKey: "agent:main:main",
          contextKey: " ",
          replace: true,
        }),
      error: "contextKey",
    },
    {
      run: () => enqueueRoutedSystemEvent("Unbound", { agentId: " ", sessionKey: "global" }),
      error: "route.agentId",
    },
    {
      run: () => enqueueRoutedSystemEvent("Unbound", { agentId: "alpha", sessionKey: " " }),
      error: "sessionKey",
    },
  ])("rejects invalid event routing: $error", ({ run, error }) => {
    expect(run).toThrow(error);
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
