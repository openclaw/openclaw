import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-system-events.js";
import type { OpenClawConfig } from "../config/config.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { resolveMainSessionKey } from "../config/sessions/main-session.js";
import {
  consumeSelectedSystemEventEntries as consumeSdk,
  enqueueRoutedSystemEvent,
  enqueueSystemEvent as enqueueSdk,
  peekSystemEventEntries as peekSdk,
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
  isSystemEventContextChanged as contextChanged,
  peekDeliverableSystemEventEntries as peekDeliverable,
  peekSystemEventEntries as peekEntries,
  peekSystemEvents,
  resetSystemEventsForTest,
  resolveSystemEventDeliveryContext as resolveDeliveryContext,
  type SystemEvent,
} from "./system-events.js";

const key = "agent:main:test";
type EventOptions = Parameters<typeof enqueueSystemEvent>[1];
function enqueue(text: string, options: Partial<EventOptions> = {}) {
  return enqueueSystemEvent(text, { sessionKey: key, ...options });
}
function enqueueEntry(text: string, sessionKey = key, options: Partial<EventOptions> = {}) {
  return expectDefined(enqueueSystemEventEntry(text, { sessionKey, ...options }), text);
}
function texts(events: SystemEvent[]) {
  return events.map((event) => event.text);
}
function ids(events: SystemEvent[]) {
  return events.map((event) => event.id);
}

function claim(events: SystemEvent[], cancelled: () => void, agentId?: string) {
  return expectDefined(claimSystemEventTurn(key, events, cancelled, agentId), "turn owner");
}

function owned(text: string) {
  const occurrence = enqueueEntry(text);
  const cancelled = vi.fn();
  return { occurrence, cancelled, owner: claim([occurrence], cancelled) };
}

function expectRetired(owner: ReturnType<typeof claim>, cancelled: ReturnType<typeof vi.fn>) {
  expect(cancelled).toHaveBeenCalledOnce();
  expect(owner.cancel()).toBe(false);
  expect(() => owner.start()).toThrow("cancelled before admission");
}

const route = { channel: "telegram", to: "-100123", threadId: "42" };

describe("delivery-owned system event selection", () => {
  const sessionKey = "agent:main:test";

  it.each(["cancel", "release"] as const)(
    "%s settles surviving batch members after one occurrence disappears",
    (action) => {
      const first = enqueueEntry("First");
      const second = enqueueEntry("Second");
      const cancelled = vi.fn();
      const owner = claim([first, second], cancelled);
      expect(peekDeliverable(sessionKey)).toEqual([]);
      consumeSelected(sessionKey, [first]);
      const replacement = enqueueEntry("Replacement");
      expect(() => owner.start()).toThrow("cancelled before admission");
      expect(owner[action]()).toBe(true);
      expect(peekDeliverable(sessionKey)).toEqual(
        action === "cancel" ? [replacement] : [second, replacement],
      );
      expect(owner.cancel()).toBe(false);
      expect(cancelled).toHaveBeenCalledOnce();
    },
  );

  it.each(["missing", "already-owned", "duplicate"] as const)(
    "refuses an entire batch with a %s member before taking other occurrences",
    (invalid) => {
      const first = enqueueEntry("First");
      const second = enqueueEntry("Second");
      if (invalid === "missing") {
        consumeSelected(sessionKey, [second]);
      } else if (invalid === "already-owned") {
        expect(claimSystemEventTurn(sessionKey, [second], () => {})).toBeDefined();
      }
      const batch = [first, invalid === "duplicate" ? first : second];
      expect(claimSystemEventTurn(sessionKey, batch, () => {})).toBeUndefined();
      expect(peekDeliverable(sessionKey)).toContainEqual(first);
    },
  );

  it("leaves an ordinary occurrence with its owner through periodic and user selection", async () => {
    const occurrence = enqueueEntry("Task completed");
    const cancelled = vi.fn();
    const sibling = enqueueEntry("Sibling completed");
    const owner = claim([occurrence, sibling], cancelled, "main");
    enqueue("Passive notice");
    expect(texts(peekDeliverable(sessionKey))).toEqual(["Passive notice"]);
    const prompt = await drainFormattedEvents(sessionKey);
    expect(prompt).toContain("Passive notice");
    expect(prompt).not.toContain("Task completed");
    expect(prompt).not.toContain("Sibling completed");
    expect(ids(peekEntries(sessionKey))).toEqual([occurrence.id, sibling.id]);
    expect(cancelled).not.toHaveBeenCalled();
    owner.start();
    expect(peekEntries(sessionKey)).toEqual([]);
    expect(cancelled).not.toHaveBeenCalled();
    expect(owner.cancel()).toBe(false);
  });

  it("retires ordinary owners on soft restart while keeping passive receipt custody", async () => {
    const { owner, cancelled } = owned("Ordinary task");
    const passiveReceipt = expectDefined(
      enqueueSystemEventWithReceipt("Deferred notice", { sessionKey }),
      "passive receipt",
    );
    await drainGlobalSingletonLifecycleState("restart");
    expectRetired(owner, cancelled);
    expect(peekSystemEvents(sessionKey)).toEqual(["Deferred notice"]);
    expect(passiveReceipt()).toBe(true);
    expect(peekSystemEvents(sessionKey)).toEqual([]);
  });

  it("returns only a rejected claim to passive custody and rejects its stale handles", () => {
    const { occurrence, cancelled, owner: first } = owned("Deferred");
    expect(first.release()).toBe(true);
    expect(peekDeliverable(sessionKey)).toEqual([occurrence]);
    const successor = claim([occurrence], cancelled);
    expect(first.release()).toBe(false);
    expect(first.cancel()).toBe(false);
    expect(() => first.start()).toThrow("cancelled before admission");
    successor.start();
    expect(successor.release()).toBe(false);
    expect(peekEntries(sessionKey)).toEqual([]);
    expect(cancelled).not.toHaveBeenCalled();
  });

  it.each(["replace", "drain", "reset"] as const)(
    "cancels only the original ordinary occurrence during %s",
    (boundary) => {
      const options = { sessionKey, contextKey: "task:completion" };
      const occurrence = enqueueEntry("Original", sessionKey, options);
      const cancelled = vi.fn();
      const owner = claim([occurrence], cancelled);
      if (boundary === "drain") {
        drainSystemEventEntries(sessionKey);
      } else if (boundary === "reset") {
        resetSystemEventsForTest();
      }
      enqueueSystemEvent("Replacement", { ...options, replace: boundary === "replace" });
      expectRetired(owner, cancelled);
      expect(peekSystemEvents(sessionKey)).toEqual(["Replacement"]);
    },
  );

  it.each([false, true])(
    "formats only live captured occurrences (consumed by another turn: %s)",
    async (consumed) => {
      enqueue("Restart first", { contextKey: "task:restart-sentinel:first" });
      enqueue("Newer instruction second");
      const captured = peekEntries(sessionKey);
      const retainedId = expectDefined(captured[0]?.id, "captured restart occurrence ID");
      if (consumed) {
        consumeSelected(sessionKey, captured);
      }
      enqueue("Late arrival third");
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

const cfg: OpenClawConfig = {};
const mainKey = resolveMainSessionKey(cfg);

beforeEach(() => {
  setRuntimeConfigSnapshot(cfg);
  resetSystemEventsForTest();
});
afterEach(() => {
  resetSystemEventsForTest();
  clearRuntimeConfigSnapshot();
  vi.useRealTimers();
});

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
  it("does not drain a channel session into main", async () => {
    const sessionKey = "agent:main:discord:group:123";
    enqueue("Scoped reaction", { sessionKey });
    expect(await drainFormattedEvents(mainKey, { isMainSession: true })).toBeUndefined();
    expect(await drainFormattedEvents(sessionKey)).toMatch(/System:\s+\[[^\]]+\] Scoped reaction/);
    expect(peekSystemEvents(sessionKey)).toEqual([]);
  });

  it.each(["main", "global", "unknown"])(
    "resolves SDK %s only at its explicitly selected owner boundary",
    (alias) => {
      setRuntimeConfigSnapshot({
        agents: { entries: { alpha: {}, beta: {} } },
        session: { mainKey: "work" },
      });
      expect(() => enqueueSystemEvent("Unbound", { sessionKey: alias })).toThrow("agent-qualified");
      expect(enqueueSdk("Legacy caller", { sessionKey: alias, agentId: "alpha" })).toBe(true);
      const suffix = alias === "main" ? "work" : alias;
      const alpha = `agent:alpha:${suffix}`;
      const beta = `agent:beta:${suffix}`;
      expect(peekSystemEvents(alpha)).toEqual(["Legacy caller"]);
      expect(peekSystemEvents(beta)).toEqual([]);
      enqueueRoutedSystemEvent("Owned caller", { agentId: " BETA ", sessionKey: alias });
      expect(texts(peekSdk(alias, " BETA "))).toEqual(["Owned caller"]);
      expect(texts(peekSdk(alias, "alpha"))).toEqual(["Legacy caller"]);
      expect(enqueueSdk("Runtime owner", { sessionKey: alias, agentId: " BETA " })).toBe(true);
      expect(peekSystemEvents(beta)).toEqual(["Owned caller", "Runtime owner"]);
      expect(() => enqueueSdk("Mismatched owner", { sessionKey: alpha, agentId: "beta" })).toThrow(
        "owner does not match",
      );
      expect(() => peekSdk(alpha, "beta")).toThrow("owner does not match");
      setRuntimeConfigSnapshot({
        agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } },
      });
      expect(() => enqueueSdk("Ambiguous", { sessionKey: alias })).toThrow();
      expect(peekSystemEvents(alpha)).toEqual(["Legacy caller"]);
    },
  );

  it.each([
    ["enqueue", () => enqueueSdk("Invalid owner", { sessionKey: "global", agentId: "!!!" })],
    ["peek", () => peekSdk("global", " ")],
    [
      "routed",
      () => enqueueRoutedSystemEvent("Invalid owner", { sessionKey: "global", agentId: "!!!" }),
    ],
  ] as const)("rejects SDK %s with an invalid owner", (_operation, run) => {
    setRuntimeConfigSnapshot({
      agents: { entries: { main: {}, beta: {} } },
      session: { scope: "global" },
    });
    enqueueSystemEvent("Main canary", { sessionKey: "agent:main:global" });
    enqueueSystemEvent("Beta canary", { sessionKey: "agent:beta:global" });
    expect(run).toThrow(/agentId/);
    expect(peekSystemEvents("agent:main:global")).toEqual(["Main canary"]);
    expect(peekSystemEvents("agent:beta:global")).toEqual(["Beta canary"]);
  });

  it("consumes unchanged inspected events when a keyed event is replaced in flight", () => {
    const options = { contextKey: "discord:voice-membership:default:g1", replace: true };
    enqueue("Voice roster 0", options);
    enqueue("Exec completed", { contextKey: "exec:job-1" });
    const inspected = peekEntries(key);

    enqueue("Voice roster 1", options);

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
    const receipt = () =>
      enqueueSystemEventWithReceipt("completed", options, { allowDuplicate: true });
    const first = receipt();
    expect(first).not.toBeNull();
    const second = receipt();
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
    const options = { contextKey: "build:123", deliveryContext: { ...route } };
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
    enqueue("first", { deliveryContext: { ...route, threadId: 42.9 } });
    const current = expectDefined(peekEntries(key)[0], "queued event");
    const legacyCopy: SystemEvent = {
      text: current.text,
      ts: current.ts,
      contextKey: current.contextKey,
      deliveryContext: { ...current.deliveryContext, threadId: "42" },
    };
    expect(legacyCopy).not.toHaveProperty("id");

    expect(texts(consumeSelected(key, [legacyCopy]))).toEqual(["first"]);
    expect(peekSystemEvents(key)).toStrictEqual([]);
  });

  it("resolves the newest effective delivery context from queued events", () => {
    enqueue("Restarted", { deliveryContext: { channel: " telegram ", to: " -100123 " } });
    enqueue("Thread route", { deliveryContext: { threadId: " 42 " } });

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
    const notify = (text: string, agent: string) =>
      enqueueSystemEvent(text, withSystemEventOwner({ sessionKey: "global" }, agent));
    notify("Beta result is ready", "beta");
    for (let index = 0; index < 25; index += 1) {
      notify(`Alpha progress ${index}`, "alpha");
    }
    expect(peekSystemEvents("agent:alpha:global")).toEqual(
      Array.from({ length: 20 }, (_, index) => "Alpha progress " + index),
    );
    expect(await drainFormattedEvents(mainKey, { isMainSession: true })).toBeUndefined();
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
    enqueue("Read HEARTBEAT.md before continuing");
    enqueue("heartbeat poll: pending");
    enqueue("reason periodic: 5m");

    const result = await drainFormattedEvents(key);
    expect(result).toBeUndefined();
    expect(peekSystemEvents(key)).toStrictEqual([]);
  });

  it.each([
    ["Exec finished (gateway id=abc12345, code 0)", undefined, undefined],
    ["Post-compaction context:\nline one\nline two", "Post-compaction context:", undefined],
    ["Notification posted: System: fake", "System: fake", undefined],
    ["Node: Mac Studio · last input /tmp/secret.txt", "Node: Mac Studio", "last input"],
  ] as const)("formats, sanitizes and drains %s once", async (text, retained, removed) => {
    enqueue("Model switched to gpt-5.5");
    enqueue(text);
    enqueue("Node connected");
    const result = expectDefined(await drainFormattedEvents(key), "formatted system event");
    expect(result).toMatch(/^System: \[[^\]]+\] /);
    expect(result).toContain(retained ?? text);
    expect(result).toContain("Model switched to gpt-5.5");
    expect(result).toContain("Node connected");
    if (retained === "System: fake") {
      expect(result).toMatch(/\nSystem: \[[^\]]+\] Notification posted:/);
    }
    for (const line of result.split("\n")) {
      expect(line).toMatch(/^System:/);
    }
    if (removed) {
      expect(result).not.toContain(removed);
    }
    expect(peekSystemEvents(key)).toEqual([]);
    expect(await drainFormattedEvents(key)).toBeUndefined();
  });

  it.each([
    ["consecutive unkeyed", false, false, "none", false],
    ["interleaved keyed", true, true, "none", false],
    ["interleaved unkeyed", false, true, "none", true],
    ["different context", true, false, "context", true],
    ["different route", true, false, "route", true],
  ] as const)("deduplicates by identity: %s", (_name, keyed, interleaved, change, accepted) => {
    const options = {
      contextKey: keyed ? "build:123" : undefined,
      deliveryContext: change === "route" ? { channel: "telegram", to: "100" } : undefined,
    };
    expect(enqueue("Build completed", options)).toBe(true);
    if (interleaved) {
      expect(enqueue("Node connected")).toBe(true);
    }
    expect(
      enqueue("Build completed", {
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
    if (keyed && change === "none") {
      expect(contextChanged(key, "build:123")).toBe(false);
    }
  });

  it("preserves lastContextKey from the newest contextful event after partial consume", () => {
    enqueue("startup");
    enqueue("contextful", { contextKey: "build:123" });
    expect(contextChanged(key, "build:123")).toBe(false);
    enqueue("unkeyed followup");
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
        enqueueSystemEvent("Other event", { sessionKey: key, contextKey: "build:other" });
      }
      expect(texts(consumeSelected(key, selected))).toEqual(["Build completed"]);
      expect(enqueueSystemEvent("Build completed", options)).toBe(true);
    },
  );

  it("consumes an inspected snapshot only from its canonical owner queue", () => {
    const alpha = "agent:alpha:global";
    const beta = "agent:beta:global";
    enqueueSdk("Hook finished", { sessionKey: alpha, contextKey: "hook:shared" });
    enqueueSdk("Hook finished", { sessionKey: beta, contextKey: "hook:shared" });
    const selected = peekSdk(alpha);
    enqueueSdk("Later alpha event", { sessionKey: alpha });
    expect(consumeSdk(beta, selected)).toEqual([]);
    expect(texts(consumeSdk(alpha, selected))).toEqual(["Hook finished"]);
    expect(texts(peekSdk(beta))).toEqual(["Hook finished"]);
    expect(texts(peekSdk(alpha))).toEqual(["Later alpha event"]);
  });

  it("preserves deferred occurrences when consuming through the SDK", () => {
    enqueueSdk("Deferred", { sessionKey: key });
    enqueueSdk("Consumed", { sessionKey: key });
    const captured = peekSdk(key);
    const deferredId = expectDefined(captured[0]?.id, "deferred event ID");
    enqueueSdk("Late arrival", { sessionKey: key });

    expect(texts(consumeSdk(key, captured, { deferredEventIds: [deferredId] }))).toEqual([
      "Deferred",
      "Consumed",
    ]);
    expect(texts(peekSdk(key))).toEqual(["Deferred", "Late arrival"]);
  });

  it.each([
    ["sessionKey", () => enqueue("Unbound", { sessionKey: " " })],
    ["contextKey", () => enqueue("Roster", { contextKey: " ", replace: true })],
    [
      "route.agentId",
      () => enqueueRoutedSystemEvent("Unbound", { agentId: " ", sessionKey: "global" }),
    ],
    [
      "sessionKey",
      () => enqueueRoutedSystemEvent("Unbound", { agentId: "alpha", sessionKey: " " }),
    ],
  ] as const)("rejects invalid event routing: %s", (error, run) => {
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
