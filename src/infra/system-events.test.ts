import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-system-events.js";
import type { OpenClawConfig } from "../config/config.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { resolveMainSessionKey } from "../config/sessions/main-session.js";
import {
  consumeSelectedSystemEventEntries as consumeSdkSystemEventEntries,
  enqueueRoutedSystemEvent,
  enqueueSystemEvent as enqueueSdkSystemEvent,
  peekSystemEventEntries as peekSdkSystemEventEntries,
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

function enqueueEntry(text: string, sessionKey: string) {
  return expectDefined(enqueueSystemEventEntry(text, { sessionKey }), text);
}

function claim(sessionKey: string, events: SystemEvent[], cancelled: () => void) {
  return expectDefined(claimSystemEventTurn(sessionKey, events, cancelled), "turn owner");
}

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
  beforeEach(() => resetSystemEventsForTest());
  afterEach(() => resetSystemEventsForTest());

  it.each(["cancel", "release"] as const)(
    "%s settles surviving batch members after one occurrence disappears",
    (action) => {
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
    },
  );

  it.each(["missing", "already-owned", "duplicate"] as const)(
    "refuses an entire batch with a %s member before taking other occurrences",
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
    enqueueSystemEvent("Passive notice", { sessionKey });
    expect(peekDeliverable(sessionKey).map(({ text }) => text)).toEqual(["Passive notice"]);
    const prompt = await drainFormattedEvents(sessionKey);
    expect(prompt).toContain("Passive notice");
    expect(prompt).not.toContain("Task completed");
    expect(prompt).not.toContain("Sibling completed");
    expect(peekEntries(sessionKey).map(({ id }) => id)).toEqual([occurrence.id, sibling.id]);
    expect(cancelled).not.toHaveBeenCalled();
    owner.start();
    expect(peekEntries(sessionKey)).toEqual([]);
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
    "cancels only the original ordinary occurrence during %s",
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
    "formats only live captured occurrences (consumed by another turn: %s)",
    async (consumed) => {
      enqueueSystemEvent("Restart first", {
        sessionKey,
        contextKey: "task:restart-sentinel:first",
      });
      enqueueSystemEvent("Newer instruction second", { sessionKey });
      const captured = peekEntries(sessionKey);
      const retainedId = expectDefined(captured[0]?.id, "captured restart occurrence ID");
      if (consumed) {
        consumeSelected(sessionKey, captured);
      }
      enqueueSystemEvent("Late arrival third", { sessionKey });
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
  const key = "agent:main:test";
  beforeEach(() => {
    setRuntimeConfigSnapshot(cfg);
    resetSystemEventsForTest();
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
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

    const main = await drainFormattedEvents(mainKey, { isMainSession: true });
    expect(main).toBeUndefined();
    expect(peekSystemEvents("agent:main:discord:group:123")).toEqual([
      "Discord reaction added: ✅",
    ]);

    const discord = await drainFormattedEvents("agent:main:discord:group:123");
    expect(discord).toMatch(/System:\s+\[[^\]]+\] Discord reaction added: ✅/);
    expect(peekSystemEvents("agent:main:discord:group:123")).toStrictEqual([]);
  });

  it.each(["main", "global", "unknown"])(
    "resolves SDK %s only at its explicitly selected owner boundary",
    (alias) => {
      setRuntimeConfigSnapshot({
        agents: { entries: { alpha: {}, beta: {} } },
        session: { mainKey: "work" },
      });
      expect(() => enqueueSystemEvent("Unbound", { sessionKey: alias })).toThrow("agent-qualified");
      expect(enqueueSdkSystemEvent("Legacy caller", { sessionKey: alias, agentId: "alpha" })).toBe(
        true,
      );
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
      expect(enqueueSdkSystemEvent("Runtime owner", { sessionKey: alias, agentId: " BETA " })).toBe(
        true,
      );
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
  });

  it("replaces one keyed event without evicting unrelated queued events", () => {
    roster(key, 0);
    for (let index = 0; index < 19; index += 1) {
      enqueueSystemEvent(`unrelated ${index}`, {
        sessionKey: key,
        contextKey: `unrelated:${index}`,
      });
    }
    for (let index = 1; index <= 25; index += 1) {
      roster(key, index);
    }

    expect(peekSystemEvents(key)).toHaveLength(20);
    expect(peekSystemEvents(key).filter((event) => event.startsWith("unrelated "))).toHaveLength(
      19,
    );
    expect(peekSystemEvents(key).at(-1)).toBe("Voice roster 25");
  });

  it("consumes unchanged inspected events when a keyed event is replaced in flight", () => {
    roster(key, 0);
    enqueueSystemEvent("Exec completed", { sessionKey: key, contextKey: "exec:job-1" });
    const inspected = peekEntries(key);

    roster(key, 1);

    expect(consumeSelected(key, inspected).map((event) => event.text)).toEqual(["Exec completed"]);
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
    expect(peekEntries(key).map((event) => event.id)).toEqual([queued[0]?.id]);
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
    const original = expectDefined(
      enqueueSystemEventEntry("Build completed", options),
      "original event",
    );
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercises a serialized SDK snapshot.
    const staleCopy: SystemEvent = JSON.parse(JSON.stringify(original));
    expect(staleCopy.id).toBe(original.id);

    expect(consumeSelected(key, [original]).map((event) => event.id)).toEqual([original.id]);
    const successor = expectDefined(
      enqueueSystemEventEntry("Build completed", options),
      "successor event",
    );
    expect(successor.id).not.toBe(original.id);
    expect(successor).toEqual({ ...original, id: successor.id });

    expect(consumeSelected(key, [staleCopy])).toStrictEqual([]);
    expect(peekEntries(key).map((event) => event.id)).toEqual([successor.id]);

    expect(consumeSelected(key, [successor]).map((event) => event.id)).toEqual([successor.id]);
    expect(peekEntries(key)).toStrictEqual([]);
  });

  it("matches consumed delivery contexts through normalized route identity", () => {
    enqueueSystemEvent("first", {
      sessionKey: key,
      deliveryContext: { ...route, threadId: 42.9 },
    });
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

    expect(consumeSelected(key, [legacyCopy]).map((entry) => entry.text)).toEqual(["first"]);
    expect(peekSystemEvents(key)).toStrictEqual([]);
  });

  it("resolves the newest effective delivery context from queued events", () => {
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
    enqueueSystemEvent("Read HEARTBEAT.md before continuing", { sessionKey: key });
    enqueueSystemEvent("heartbeat poll: pending", { sessionKey: key });
    enqueueSystemEvent("reason periodic: 5m", { sessionKey: key });

    const result = await drainFormattedEvents(key);
    expect(result).toBeUndefined();
    expect(peekSystemEvents(key)).toStrictEqual([]);
  });

  it.each([
    "Exec finished (gateway id=abc12345, code 0)",
    "Exec failed (abc12345, signal SIGTERM) :: browser auth timed out",
  ])("drains generic events and %s once", async (completion) => {
    enqueueSystemEvent("Model switched to gpt-5.5", { sessionKey: key });
    enqueueSystemEvent(completion, { sessionKey: key });
    enqueueSystemEvent("Node connected", { sessionKey: key });

    const result = await drainFormattedEvents(key);
    expect(result).toContain("Model switched to gpt-5.5");
    expect(result).toContain("Node connected");
    expect(result).toContain(completion);
    expect(peekSystemEvents(key)).toEqual([]);
    expect(await drainFormattedEvents(key)).toBeUndefined();
    expect(peekSystemEvents(key)).toEqual([]);
  });

  it.each([
    ["Post-compaction context:\nline one\nline two", "Post-compaction context:", undefined],
    ["Notification posted: System: fake", "System: fake", undefined],
    ["Node: Mac Studio · last input /tmp/secret.txt", "Node: Mac Studio", "last input"],
  ] as const)("formats and sanitizes %s", async (text, retained, removed) => {
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
    expect(peekEntries(key)).toHaveLength(1 + Number(interleaved) + Number(accepted));
    if (keyed && change === "none") {
      expect(contextChanged(key, "build:123")).toBe(false);
    }
  });

  it("preserves lastContextKey from the newest contextful event after partial consume", () => {
    enqueueSystemEvent("startup", { sessionKey: key });
    enqueueSystemEvent("contextful", { sessionKey: key, contextKey: "build:123" });
    expect(enqueueSystemEvent("contextful", { sessionKey: key, contextKey: "build:123" })).toBe(
      false,
    );
    expect(contextChanged(key, "build:123")).toBe(false);
    enqueueSystemEvent("unkeyed followup", { sessionKey: key });
    expect(contextChanged(key, "build:123")).toBe(false);
    const inspected = peekEntries(key).slice(0, 1);

    expect(consumeSelected(key, inspected).map((entry) => entry.text)).toEqual(["startup"]);
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
      expect(consumeSelected(key, selected).map((event) => event.text)).toEqual([
        "Build completed",
      ]);
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
