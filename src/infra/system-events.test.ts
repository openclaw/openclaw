import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-system-events.js";
import type { OpenClawConfig } from "../config/config.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { resolveMainSessionKey } from "../config/sessions/main-session.js";
import {
  consumeSelectedSystemEventEntries as sdkConsume,
  enqueueRoutedSystemEvent,
  enqueueSystemEvent as sdkEnqueue,
  peekSystemEventEntries as sdkPeek,
} from "../plugin-sdk/system-event-runtime.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { withSystemEventOwner } from "./system-event-ownership.js";
import {
  claimSystemEventTurn,
  consumeSelectedSystemEventEntries as consumeSelected,
  drainSystemEventEntries,
  enqueueSystemEvent,
  enqueueSystemEventEntry,
  enqueueSystemEventWithReceipt,
  holdSystemEventDelivery,
  isSystemEventContextChanged as contextChanged,
  peekDeliverableSystemEventEntries as peekDeliverable,
  peekSystemEventEntries as peekEntries,
  peekSystemEvents,
  resetSystemEventsForTest,
  resolveSystemEventDeliveryContext as resolveDeliveryContext,
  type SystemEvent,
} from "./system-events.js";

function enqueueEntry(
  text: string,
  sessionKey: string,
  options: Partial<Parameters<typeof enqueueSystemEventEntry>[1]> = {},
) {
  return expectDefined(enqueueSystemEventEntry(text, { ...options, sessionKey }), text);
}

function claim(sessionKey: string, events: SystemEvent[], cancelled: () => void) {
  return expectDefined(claimSystemEventTurn(sessionKey, events, cancelled), "turn owner");
}

const key = "agent:main:test";
const cfg: OpenClawConfig = {};
beforeEach(() => {
  setRuntimeConfigSnapshot(cfg);
  resetSystemEventsForTest();
});
afterEach(() => {
  resetSystemEventsForTest();
  clearRuntimeConfigSnapshot();
  vi.useRealTimers();
});
const put = (text: string, options: Partial<Parameters<typeof enqueueSystemEvent>[1]> = {}) =>
  enqueueSystemEvent(text, { sessionKey: key, ...options });
const texts = (events: SystemEvent[]) => events.map(({ text }) => text);
const ids = (events: SystemEvent[]) => events.map(({ id }) => id);
const route = { channel: "telegram", to: "-100123", threadId: "42" };
const rosterContext = "discord:voice-membership:default:g1";
function roster(sessionKey: string, index: number) {
  return enqueueSystemEvent(`Voice roster ${index}`, {
    sessionKey,
    contextKey: rosterContext,
    replace: true,
  });
}

describe("delivery-owned system event selection", () => {
  const sessionKey = "agent:main:test";

  it.each(["cancel", "release"] as const)("%s settles surviving batch members", (action) => {
    const first = enqueueEntry("First", sessionKey);
    const second = enqueueEntry("Second", sessionKey);
    const cancelled = vi.fn();
    const owner = claim(sessionKey, [first, second], cancelled);
    expect(peekDeliverable(sessionKey)).toEqual([]);
    consumeSelected(sessionKey, [first]);
    const replacement = enqueueEntry("Replacement", sessionKey);
    expect(() => owner.start()).toThrow("cancelled before admission");
    expect(owner[action]()).toBe(true);
    expect(peekDeliverable(sessionKey)).toEqual(
      action === "cancel" ? [replacement] : [second, replacement],
    );
    expect(owner.cancel()).toBe(false);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it.each(["missing", "already-owned", "duplicate"] as const)(
    "rejects a batch containing a %s occurrence",
    (invalid) => {
      const first = enqueueEntry("First", sessionKey);
      const second = enqueueEntry("Second", sessionKey);
      if (invalid === "missing") {
        consumeSelected(sessionKey, [second]);
      } else if (invalid === "already-owned") {
        expect(claimSystemEventTurn(sessionKey, [second], () => {})).toBeDefined();
      }
      expect(
        claimSystemEventTurn(
          sessionKey,
          [first, invalid === "duplicate" ? first : second],
          () => {},
        ),
      ).toBeUndefined();
      expect(peekDeliverable(sessionKey)).toContainEqual(first);
    },
  );

  it("leaves an ordinary occurrence with its owner through periodic and user selection", async () => {
    const occurrence = enqueueEntry("Task completed", sessionKey);
    const cancelled = vi.fn();
    const sibling = enqueueEntry("Sibling completed", sessionKey);
    const owner = expectDefined(
      claimSystemEventTurn(sessionKey, [occurrence, sibling], cancelled, "main"),
      "ordinary owner",
    );
    put("Passive notice");
    const held = enqueueEntry("Exec finished (gateway id=uncertain, code 0)", sessionKey);
    holdSystemEventDelivery(sessionKey, [held]);
    expect(texts(peekDeliverable(sessionKey))).toEqual(["Passive notice"]);
    const prompt = await drainFormattedEvents(sessionKey);
    expect(prompt).toContain("Passive notice");
    expect(prompt).not.toContain("Task completed");
    expect(prompt).not.toContain("Sibling completed");
    expect(ids(peekEntries(sessionKey))).toEqual([occurrence.id, sibling.id, held.id]);
    expect(cancelled).not.toHaveBeenCalled();
    owner.start();
    expect(ids(peekEntries(sessionKey))).toEqual([held.id]);
    expect(cancelled).not.toHaveBeenCalled();
    expect(owner.cancel()).toBe(false);
  });

  it("retires ordinary owners on soft restart while keeping passive receipt custody", async () => {
    const occurrence = enqueueEntry("Ordinary task", sessionKey);
    const cancelled = vi.fn();
    const owner = claim(sessionKey, [occurrence], cancelled);
    const passiveReceipt = expectDefined(
      enqueueSystemEventWithReceipt("Deferred notice", { sessionKey }),
      "passive receipt",
    );
    await drainGlobalSingletonLifecycleState("restart");
    expect(cancelled).toHaveBeenCalledOnce();
    expect(() => owner.start()).toThrow("cancelled before admission");
    expect(peekSystemEvents(sessionKey)).toEqual(["Deferred notice"]);
    expect(passiveReceipt()).toBe(true);
    expect(peekSystemEvents(sessionKey)).toEqual([]);
  });

  it("returns only a rejected claim to passive custody and rejects its stale handles", () => {
    const occurrence = enqueueEntry("Deferred", sessionKey);
    const cancelled = vi.fn();
    const first = claim(sessionKey, [occurrence], cancelled);
    expect(first.release()).toBe(true);
    expect(peekDeliverable(sessionKey)).toEqual([occurrence]);
    const successor = claim(sessionKey, [occurrence], cancelled);
    expect(first.release()).toBe(false);
    expect(first.cancel()).toBe(false);
    expect(() => first.start()).toThrow("cancelled before admission");
    successor.start();
    expect(successor.release()).toBe(false);
    expect(peekEntries(sessionKey)).toEqual([]);
    expect(cancelled).not.toHaveBeenCalled();
  });

  it.each(["replace", "drain", "reset"] as const)(
    "%s cancels only the original occurrence",
    (boundary) => {
      const options = { sessionKey, contextKey: "task:completion" };
      const occurrence = expectDefined(enqueueSystemEventEntry("Original", options), "original");
      const cancelled = vi.fn();
      const owner = claim(sessionKey, [occurrence], cancelled);
      if (boundary === "replace") {
        enqueueSystemEvent("Replacement", { ...options, replace: true });
      } else if (boundary === "drain") {
        drainSystemEventEntries(sessionKey);
        enqueueSystemEvent("Replacement", options);
      } else {
        resetSystemEventsForTest();
        enqueueSystemEvent("Replacement", options);
      }
      expect(cancelled).toHaveBeenCalledOnce();
      expect(owner.cancel()).toBe(false);
      expect(() => owner.start()).toThrow("cancelled before admission");
      expect(peekSystemEvents(sessionKey)).toEqual(["Replacement"]);
    },
  );

  it.each([false, true])(
    "formats live captured occurrences (already consumed: %s)",
    async (consumed) => {
      put("Restart first", { contextKey: "task:restart-sentinel:first" });
      put("Newer instruction second");
      const captured = peekEntries(sessionKey);
      const retainedId = expectDefined(captured[0]?.id, "captured restart occurrence ID");
      if (consumed) {
        consumeSelected(sessionKey, captured);
      }
      put("Late arrival third");
      const text = await drainFormattedEvents(sessionKey, {
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
        consumeSelected(sessionKey, [captured[0]!]);
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
  it("does not leak session-scoped events into main", async () => {
    enqueueSystemEvent("Discord reaction added: ✅", {
      sessionKey: "agent:main:discord:group:123",
      contextKey: "discord:reaction:added:msg:user:✅",
    });

    expect(peekSystemEvents(mainKey)).toStrictEqual([]);
    expect(peekSystemEvents("agent:main:discord:group:123")).toEqual([
      "Discord reaction added: ✅",
    ]);

    const main = await drainFormattedEvents(mainKey, { isMainSession: true });
    expect(main).toBeUndefined();
    expect(peekSystemEvents("agent:main:discord:group:123")).toEqual([
      "Discord reaction added: ✅",
    ]);

    const discord = await drainFormattedEvents("agent:main:discord:group:123");
    expect(discord).toMatch(/System:\s+\[[^\]]+\] Discord reaction added: ✅/);
    expect(peekSystemEvents("agent:main:discord:group:123")).toStrictEqual([]);
  });

  it.each(["main", "global", "unknown"])("routes SDK %s through its explicit owner", (alias) => {
    setRuntimeConfigSnapshot({
      agents: { entries: { alpha: {}, beta: {} } },
      session: { mainKey: "work" },
    });
    expect(() => enqueueSystemEvent("Unbound", { sessionKey: alias })).toThrow("agent-qualified");
    expect(sdkEnqueue("Legacy caller", { sessionKey: alias, agentId: "alpha" })).toBe(true);
    const suffix = alias === "main" ? "work" : alias;
    expect(peekSystemEvents(`agent:alpha:${suffix}`)).toEqual(["Legacy caller"]);
    expect(peekSystemEvents(`agent:beta:${suffix}`)).toEqual([]);
    enqueueRoutedSystemEvent("Owned caller", { agentId: " BETA ", sessionKey: alias });
    expect(texts(sdkPeek(alias, " BETA "))).toEqual(["Owned caller"]);
    expect(texts(sdkPeek(alias, "alpha"))).toEqual(["Legacy caller"]);
    expect(sdkEnqueue("Runtime owner", { sessionKey: alias, agentId: " BETA " })).toBe(true);
    expect(peekSystemEvents(`agent:beta:${suffix}`)).toEqual(["Owned caller", "Runtime owner"]);
    expect(() =>
      sdkEnqueue("Mismatched owner", {
        sessionKey: `agent:alpha:${suffix}`,
        agentId: "beta",
      }),
    ).toThrow("owner does not match");
    expect(() => sdkPeek(`agent:alpha:${suffix}`, "beta")).toThrow("owner does not match");
    setRuntimeConfigSnapshot({
      agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } },
    });
    expect(() => sdkEnqueue("Ambiguous", { sessionKey: alias })).toThrow();
    expect(peekSystemEvents(`agent:alpha:${suffix}`)).toEqual(["Legacy caller"]);
  });

  it.each([
    { agentId: "!!!", sessionKey: "global", operation: "enqueue" },
    { agentId: "", sessionKey: "agent:main:global", operation: "enqueue" },
    { agentId: "!!!", sessionKey: "agent:main:global", operation: "peek" },
    { agentId: " ", sessionKey: "global", operation: "peek" },
    { agentId: "!!!", sessionKey: "global", operation: "routed" },
    { agentId: " ", sessionKey: "agent:main:global", operation: "routed" },
  ])("rejects SDK $operation with owner '$agentId' for $sessionKey", (params) => {
    setRuntimeConfigSnapshot({
      agents: { entries: { main: {}, beta: {} } },
      session: { scope: "global" },
    });
    enqueueSystemEvent("Main canary", { sessionKey: "agent:main:global" });
    enqueueSystemEvent("Beta canary", { sessionKey: "agent:beta:global" });
    expect(() => {
      const { sessionKey, agentId, operation } = params;
      if (operation === "peek") {
        return sdkPeek(sessionKey, agentId);
      }
      return operation === "routed"
        ? enqueueRoutedSystemEvent("Invalid owner", { sessionKey, agentId })
        : sdkEnqueue("Invalid owner", { sessionKey, agentId });
    }).toThrow(/agentId/);
    expect(peekSystemEvents("agent:main:global")).toEqual(["Main canary"]);
    expect(peekSystemEvents("agent:beta:global")).toEqual(["Beta canary"]);
  });

  it("consumes unchanged inspected events when a keyed event is replaced in flight", () => {
    roster(key, 0);
    put("Exec completed", { contextKey: "exec:job-1" });
    const inspected = peekEntries(key);

    roster(key, 1);

    expect(texts(consumeSelected(key, inspected))).toEqual(["Exec completed"]);
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

  it("keeps structurally identical receipt-owned siblings distinct", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T00:00:00Z"));
    const options = { sessionKey: " " + key + " ", contextKey: "exec:reused-slug" };
    const first = enqueueSystemEventWithReceipt("completed", options, {
      allowDuplicate: true,
    });
    expect(first).not.toBeNull();
    const second = enqueueSystemEventWithReceipt("completed", options, {
      allowDuplicate: true,
    });
    const queued = peekEntries(key);

    expect(queued[0]).toEqual({ ...queued[1], id: queued[0]?.id });
    expect(queued[0]?.id).not.toBe(queued[1]?.id);
    expect(second?.()).toBe(true);
    expect(ids(peekEntries(key))).toEqual([queued[0]?.id]);
    expect(second?.()).toBe(false);
    expect(first?.()).toBe(true);
    expect(peekEntries(key)).toStrictEqual([]);
  });

  it("does not consume an identical successor from a serialized stale snapshot", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T00:00:00Z"));
    const options = {
      sessionKey: key,
      contextKey: "build:123",
      deliveryContext: { ...route },
    };
    const original = enqueueEntry("Build completed", key, options);
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercises a serialized SDK snapshot.
    const staleCopy: SystemEvent = JSON.parse(JSON.stringify(original));
    expect(staleCopy.id).toBe(original.id);

    expect(ids(consumeSelected(key, [original]))).toEqual([original.id]);
    const successor = enqueueEntry("Build completed", key, options);
    expect(successor.id).not.toBe(original.id);
    expect(successor).toEqual({ ...original, id: successor.id });

    expect(consumeSelected(key, [staleCopy])).toStrictEqual([]);
    expect(ids(peekEntries(key))).toEqual([successor.id]);

    expect(ids(consumeSelected(key, [successor]))).toEqual([successor.id]);
    expect(peekEntries(key)).toStrictEqual([]);
  });

  it("matches consumed delivery contexts through normalized route identity", () => {
    put("first", { deliveryContext: { ...route, threadId: 42.9 } });
    const current = expectDefined(peekEntries(key)[0], "queued event");
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

    expect(texts(consumeSelected(key, [legacyCopy]))).toEqual(["first"]);
    expect(peekSystemEvents(key)).toStrictEqual([]);
  });

  it("resolves the newest effective delivery context from queued events", () => {
    put("Restarted", { deliveryContext: { channel: " telegram ", to: " -100123 " } });
    put("Thread route", { deliveryContext: { threadId: " 42 " } });

    const events = peekEntries(key);
    const resolved = resolveDeliveryContext(events);
    expectDefined(
      expectDefined(events[0], "first system event").deliveryContext,
      "first event delivery context",
    ).to = "mutated";

    expect(resolved).toEqual(route);
    expect(resolveDeliveryContext(peekEntries(key))).toEqual(route);
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
      Array.from({ length: 20 }, (_, index) => "Alpha progress " + index),
    );
    const beta = await drainFormattedEvents("global", { agentId: "beta" });
    expect(beta).toContain("Beta result is ready");
    expect(beta).not.toContain("Alpha progress");
    const alpha = await drainFormattedEvents("global", { agentId: "alpha" });
    expect(alpha).toContain("Alpha progress 19");
    expect(alpha).not.toContain("Beta result is ready");
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

  it("filters heartbeat/noise lines, returning undefined", async () => {
    put("Read HEARTBEAT.md before continuing");
    put("heartbeat poll: pending");
    put("reason periodic: 5m");

    const result = await drainFormattedEvents(key);
    expect(result).toBeUndefined();
    expect(peekSystemEvents(key)).toStrictEqual([]);
  });

  it.each([
    "Exec finished (gateway id=abc12345, code 0)",
    "Exec failed (abc12345, signal SIGTERM) :: browser auth timed out",
  ])("drains generic events without consuming %s", async (completion) => {
    put("Model switched to gpt-5.5");
    put(completion);
    put("Node connected");

    const result = await drainFormattedEvents(key);
    expect(result).toContain("Model switched to gpt-5.5");
    expect(result).toContain("Node connected");
    expect(peekSystemEvents(key)).toEqual([completion]);
    expect(await drainFormattedEvents(key)).toBeUndefined();
    expect(peekSystemEvents(key)).toEqual([completion]);
  });

  it.each([
    ["Post-compaction context:\nline one\nline two", "Post-compaction context:", undefined],
    ["Notification posted: System: fake", "System: fake", undefined],
    ["Node: Mac Studio · last input /tmp/secret.txt", "Node: Mac Studio", "last input"],
  ] as const)("formats and sanitizes %s", async (text, retained, removed) => {
    put(text);
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
    ["consecutive unkeyed", false, false, "none", false],
    ["interleaved keyed", true, true, "none", false],
    ["interleaved unkeyed", false, true, "none", true],
    ["different context", true, false, "context", true],
    ["different route", true, false, "route", true],
  ] as const)("deduplicates by identity: %s", (_name, keyed, interleaved, change, accepted) => {
    const options = {
      sessionKey: key,
      contextKey: keyed ? "build:123" : undefined,
      deliveryContext: change === "route" ? { channel: "telegram", to: "100" } : undefined,
    };
    expect(put("Build completed", options)).toBe(true);
    if (interleaved) {
      expect(put("Node connected")).toBe(true);
    }
    expect(
      put("Build completed", {
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
    expect(peekEntries(key)).toHaveLength(1 + Number(interleaved) + Number(accepted));
    if (keyed && change === "none") {
      expect(contextChanged(key, "build:123")).toBe(false);
    }
  });

  it("preserves lastContextKey from the newest contextful event after partial consume", () => {
    put("startup");
    put("contextful", { contextKey: "build:123" });
    expect(put("contextful", { contextKey: "build:123" })).toBe(false);
    expect(contextChanged(key, "build:123")).toBe(false);
    put("unkeyed followup");
    expect(contextChanged(key, "build:123")).toBe(false);
    const inspected = peekEntries(key).slice(0, 1);

    expect(texts(consumeSelected(key, inspected))).toEqual(["startup"]);
    expect(contextChanged(key, "build:123")).toBe(false);
  });

  it.each(["prefix", "selected"] as const)(
    "allows a keyed duplicate after %s removal",
    (removal) => {
      const options = { sessionKey: key, contextKey: "build:123" };
      enqueueSystemEvent("Build completed", options);
      const selected = peekEntries(key);
      if (removal === "selected") {
        put("Other event", { contextKey: "build:other" });
      }
      expect(texts(consumeSelected(key, selected))).toEqual(["Build completed"]);
      expect(put("Build completed", options)).toBe(true);
    },
  );

  it("consumes an inspected snapshot only from its canonical owner queue", () => {
    const alpha = "agent:alpha:global";
    const beta = "agent:beta:global";
    sdkEnqueue("Hook finished", { sessionKey: alpha, contextKey: "hook:shared" });
    sdkEnqueue("Hook finished", { sessionKey: beta, contextKey: "hook:shared" });
    const selected = sdkPeek(alpha);
    sdkEnqueue("Later alpha event", { sessionKey: alpha });
    expect(sdkConsume(beta, selected)).toEqual([]);
    expect(texts(sdkConsume(alpha, selected))).toEqual(["Hook finished"]);
    expect(texts(sdkPeek(beta))).toEqual(["Hook finished"]);
    expect(texts(sdkPeek(alpha))).toEqual(["Later alpha event"]);
  });

  it.each([
    [() => put("Unbound", { sessionKey: " " }), "sessionKey"],
    [
      () => put("Roster", { sessionKey: "agent:main:main", contextKey: " ", replace: true }),
      "contextKey",
    ],
    [
      () => enqueueRoutedSystemEvent("Unbound", { agentId: " ", sessionKey: "global" }),
      "route.agentId",
    ],
    [
      () => enqueueRoutedSystemEvent("Unbound", { agentId: "alpha", sessionKey: " " }),
      "sessionKey",
    ],
  ] as const)("rejects invalid event routing: %s (%s)", (run, error) => {
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
