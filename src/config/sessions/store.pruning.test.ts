// Session store pruning tests cover pruning decisions and retention ordering.
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFixtureSuite } from "../../test-utils/fixture-suite.js";
import {
  collectSessionMaintenancePreserveKeys,
  registerSessionMaintenancePreserveKeysProvider,
} from "./store-maintenance-preserve.js";
import {
  isProtectedSessionMaintenanceEntry,
  resolveMaintenanceConfigFromInput,
  resolveQuotaSuspensionEntryMaintenance,
  resolveSessionEntryMaintenanceHighWater,
} from "./store-maintenance.js";
import { capEntryCount, getActiveSessionMaintenanceWarning, pruneStaleEntries } from "./store.js";
import type { SessionEntry } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

const fixtureSuite = createFixtureSuite("openclaw-pruning-suite-");

beforeAll(async () => {
  await fixtureSuite.setup();
});

afterAll(async () => {
  await fixtureSuite.cleanup();
});

function makeEntry(updatedAt: number): SessionEntry {
  return { sessionId: crypto.randomUUID(), updatedAt };
}

function makeStore(entries: Array<[string, SessionEntry]>): Record<string, SessionEntry> {
  return Object.fromEntries(entries);
}

// ---------------------------------------------------------------------------
// Unit tests — each function called with explicit override parameters.
// No config loading needed; overrides bypass resolveMaintenanceConfig().
// ---------------------------------------------------------------------------

describe("pruneStaleEntries", () => {
  it("removes entries older than maxAgeDays", () => {
    const now = Date.now();
    const store = makeStore([
      ["old", makeEntry(now - 31 * DAY_MS)],
      ["fresh", makeEntry(now - DAY_MS)],
    ]);

    const pruned = pruneStaleEntries(store, 30 * DAY_MS);

    expect(pruned).toBe(1);
    expect(store.old).toBeUndefined();
    expect(store).toHaveProperty("fresh");
  });

  it("does not remove entries under the universal cleanup age floor even with an aggressive max age", () => {
    const now = Date.now();
    const store = makeStore([["young", makeEntry(now - 60_000)]]);

    const pruned = pruneStaleEntries(store, 1_000, { nowMs: now });

    expect(pruned).toBe(0);
    expect(store).toHaveProperty("young");
  });

  it("quarantines entries whose timestamp is missing or in the future", () => {
    const now = Date.now();
    const quarantined: string[] = [];
    const store = makeStore([
      ["missing-updated-at", { sessionId: crypto.randomUUID() } as SessionEntry],
      ["future", makeEntry(now + 60_000)],
    ]);

    const pruned = pruneStaleEntries(store, DAY_MS, {
      nowMs: now,
      onQuarantinedAge: ({ key }) => quarantined.push(key),
    });

    expect(pruned).toBe(0);
    expect(Object.keys(store)).toHaveLength(2);
    expect(quarantined.toSorted()).toEqual(["future", "missing-updated-at"]);
  });

  it("preserves durable external conversation entries", () => {
    const now = Date.now();
    const store = makeStore([
      ["old", makeEntry(now - 31 * DAY_MS)],
      ["agent:main:slack:channel:C123:thread:1710000000.000100", makeEntry(now - 31 * DAY_MS)],
      ["agent:main:telegram:group:-100123:topic:77", makeEntry(now - 31 * DAY_MS)],
      ["agent:main:slack:channel:C999", makeEntry(now - 31 * DAY_MS)],
      ["agent:main:telegram:group:-100123", { ...makeEntry(now - 31 * DAY_MS), chatType: "group" }],
      ["agent:main:discord:channel:ops", { ...makeEntry(now - 31 * DAY_MS), chatType: "channel" }],
    ]);

    const pruned = pruneStaleEntries(store, 30 * DAY_MS);

    expect(pruned).toBe(1);
    expect(store.old).toBeUndefined();
    expect(store).toHaveProperty("agent:main:slack:channel:C123:thread:1710000000.000100");
    expect(store).toHaveProperty("agent:main:telegram:group:-100123:topic:77");
    expect(store).toHaveProperty("agent:main:slack:channel:C999");
    expect(store).toHaveProperty("agent:main:telegram:group:-100123");
    expect(store).toHaveProperty("agent:main:discord:channel:ops");
  });
});

describe("resolveQuotaSuspensionEntryMaintenance", () => {
  it("returns an entry-scoped patch when a suspended session should resume", () => {
    const now = Date.now();
    const result = resolveQuotaSuspensionEntryMaintenance({
      entry: {
        ...makeEntry(now),
        quotaSuspension: {
          schemaVersion: 1,
          suspendedAt: now - 30_000,
          expectedResumeBy: now - 1,
          state: "suspended",
          reason: "quota_exhausted",
          failedProvider: "anthropic",
          failedModel: "claude-opus-4-6",
          laneId: "main",
        },
      },
      now,
      ttlMs: 30_000,
    });

    expect(result).toEqual({
      patch: {
        quotaSuspension: {
          schemaVersion: 1,
          suspendedAt: now - 30_000,
          expectedResumeBy: now - 1,
          state: "resuming",
          reason: "quota_exhausted",
          failedProvider: "anthropic",
          failedModel: "claude-opus-4-6",
          laneId: "main",
        },
      },
      resumed: { laneId: "main" },
      cleared: false,
    });
  });

  it("returns an entry-scoped cleanup patch after the resume window expires", () => {
    const now = Date.now();
    const result = resolveQuotaSuspensionEntryMaintenance({
      entry: {
        ...makeEntry(now),
        quotaSuspension: {
          schemaVersion: 1,
          suspendedAt: now - 61_000,
          expectedResumeBy: now - 31_000,
          state: "active",
          reason: "circuit_open",
          failedProvider: "anthropic",
          failedModel: "claude-opus-4-6",
          laneId: "main",
        },
      },
      now,
      ttlMs: 30_000,
    });

    expect(result).toEqual({
      patch: { quotaSuspension: undefined },
      cleared: true,
    });
  });
});

describe("capEntryCount", () => {
  it("over limit: keeps N most recent by updatedAt, deletes rest", () => {
    const now = Date.now();
    const oldEnough = now - FIVE_HOURS_MS;
    const store = makeStore([
      ["oldest", makeEntry(oldEnough - 4_000)],
      ["old", makeEntry(oldEnough - 3_000)],
      ["mid", makeEntry(oldEnough - 2_000)],
      ["recent", makeEntry(oldEnough - 1_000)],
      ["newest", makeEntry(oldEnough)],
    ]);

    const evicted = capEntryCount(store, 3);

    expect(evicted).toBe(2);
    expect(Object.keys(store)).toHaveLength(3);
    expect(store).toHaveProperty("newest");
    expect(store).toHaveProperty("recent");
    expect(store).toHaveProperty("mid");
    expect(store.oldest).toBeUndefined();
    expect(store.old).toBeUndefined();
  });

  it("preserves durable external conversation entries when capping", () => {
    const now = Date.now();
    const oldEnough = now - FIVE_HOURS_MS;
    const threadKey = "agent:main:discord:channel:123456:thread:987654";
    const store = makeStore([
      [threadKey, makeEntry(oldEnough - 4_000)],
      ["oldest", makeEntry(oldEnough - 3_000)],
      ["old", makeEntry(oldEnough - 2_000)],
      ["recent", makeEntry(oldEnough - 1_000)],
      ["newest", makeEntry(oldEnough)],
    ]);

    const evicted = capEntryCount(store, 3);

    expect(evicted).toBe(2);
    expect(Object.keys(store)).toHaveLength(3);
    expect(store).toHaveProperty(threadKey);
    expect(store).toHaveProperty("newest");
    expect(store).toHaveProperty("recent");
    expect(store.oldest).toBeUndefined();
    expect(store.old).toBeUndefined();
  });

  it("preserves runtime-provided pending subagent sessions when capping", () => {
    const now = Date.now();
    const oldEnough = now - FIVE_HOURS_MS;
    const childKey = "agent:main:subagent:child";
    const store = makeStore([
      [childKey, { ...makeEntry(now - 10 * DAY_MS), spawnedBy: "agent:main:slack:direct:U1" }],
      ["recent-1", makeEntry(oldEnough)],
      ["recent-2", makeEntry(oldEnough - 1)],
      ["old", makeEntry(oldEnough - 2)],
    ]);
    const unregister = registerSessionMaintenancePreserveKeysProvider(() => [childKey]);

    try {
      const evicted = capEntryCount(store, 2, {
        preserveKeys: collectSessionMaintenancePreserveKeys(),
      });

      expect(evicted).toBe(2);
      expect(Object.keys(store)).toHaveLength(2);
      expect(store).toHaveProperty(childKey);
      expect(store).toHaveProperty("recent-1");
      expect(store["recent-2"]).toBeUndefined();
      expect(store.old).toBeUndefined();
    } finally {
      unregister();
    }
  });

  it("normalizes runtime-provided preserve keys to match lowercased store keys", () => {
    const now = Date.now();
    const oldEnough = now - FIVE_HOURS_MS;
    const childKey = "agent:main:subagent:child";
    const store = makeStore([
      [childKey, { ...makeEntry(now - 10 * DAY_MS), spawnedBy: "agent:main:slack:direct:U1" }],
      ["recent-1", makeEntry(oldEnough)],
      ["old", makeEntry(oldEnough - 1)],
    ]);
    // Provider returns the key in mixed case + with surrounding whitespace;
    // normalization must match the lowercased store key during maintenance.
    const unregister = registerSessionMaintenancePreserveKeysProvider(() => [
      "  Agent:Main:Subagent:CHILD  ",
    ]);

    try {
      const evicted = capEntryCount(store, 2, {
        preserveKeys: collectSessionMaintenancePreserveKeys(),
      });

      expect(evicted).toBe(1);
      expect(Object.keys(store)).toHaveLength(2);
      expect(store).toHaveProperty(childKey);
      expect(store).toHaveProperty("recent-1");
      expect(store.old).toBeUndefined();
    } finally {
      unregister();
    }
  });

  it("can temporarily exceed the cap when every candidate is runtime-protected", () => {
    const now = Date.now();
    const store = makeStore([
      ["agent:main:subagent:child-a", makeEntry(now - 2)],
      ["agent:main:subagent:child-b", makeEntry(now - 1)],
    ]);
    const unregister = registerSessionMaintenancePreserveKeysProvider(() => Object.keys(store));

    try {
      const evicted = capEntryCount(store, 1, {
        preserveKeys: collectSessionMaintenancePreserveKeys(),
      });

      expect(evicted).toBe(0);
      expect(Object.keys(store)).toHaveLength(2);
    } finally {
      unregister();
    }
  });

  it("preserves entries under the universal cleanup age floor when capping", () => {
    const now = Date.now();
    const underAge: string[] = [];
    const store = makeStore([
      ["young-a", makeEntry(now - 30_000)],
      ["young-b", makeEntry(now - 60_000)],
    ]);

    const evicted = capEntryCount(store, 1, {
      nowMs: now,
      onPreservedUnderAge: ({ key }) => underAge.push(key),
    });

    expect(evicted).toBe(0);
    expect(Object.keys(store)).toHaveLength(2);
    expect(underAge.toSorted()).toEqual(["young-a", "young-b"]);
  });

  it("quarantines entries whose age cannot be proven when capping", () => {
    const now = Date.now();
    const quarantined: string[] = [];
    const store = makeStore([
      ["missing-updated-at", { sessionId: crypto.randomUUID() } as SessionEntry],
      ["future", makeEntry(now + 60_000)],
    ]);

    const evicted = capEntryCount(store, 1, {
      nowMs: now,
      onQuarantinedAge: ({ key }) => quarantined.push(key),
    });

    expect(evicted).toBe(0);
    expect(Object.keys(store)).toHaveLength(2);
    expect(quarantined.toSorted()).toEqual(["future", "missing-updated-at"]);
  });
});

describe("isProtectedSessionMaintenanceEntry", () => {
  it("treats generated ACP bridge sessions as disposable", () => {
    expect(
      isProtectedSessionMaintenanceEntry("agent:main:acp-bridge:session-1", {
        ...makeEntry(Date.now()),
        chatType: "group",
      }),
    ).toBe(false);
  });

  it("does not protect synthetic sessions just because they carry group metadata", () => {
    expect(
      isProtectedSessionMaintenanceEntry("agent:main:subagent:worker", {
        ...makeEntry(Date.now()),
        chatType: "group",
      }),
    ).toBe(false);
    expect(
      isProtectedSessionMaintenanceEntry("agent:main:cron:job:run:123", {
        ...makeEntry(Date.now()),
        origin: { chatType: "group" },
      }),
    ).toBe(false);
  });

  it("protects metadata-less Telegram topic keys without treating every :topic: id as a thread", () => {
    expect(
      isProtectedSessionMaintenanceEntry(
        "agent:main:telegram:group:-100123:topic:77",
        makeEntry(Date.now()),
      ),
    ).toBe(true);
    expect(
      isProtectedSessionMaintenanceEntry(
        "agent:main:opaque:topic:om_topic_root:sender:ou_topic_user",
        makeEntry(Date.now()),
      ),
    ).toBe(false);
  });

  it("protects metadata-less channel session keys and channel chat metadata", () => {
    expect(
      isProtectedSessionMaintenanceEntry("agent:main:slack:channel:C123", makeEntry(Date.now())),
    ).toBe(true);
    expect(
      isProtectedSessionMaintenanceEntry(
        "agent:main:custom:channel:room-one:with:colon",
        makeEntry(Date.now()),
      ),
    ).toBe(true);
    expect(
      isProtectedSessionMaintenanceEntry("agent:main:opaque", {
        ...makeEntry(Date.now()),
        chatType: "channel",
      }),
    ).toBe(true);
  });
});

describe("resolveMaintenanceConfigFromInput", () => {
  it("defaults to enforcing session maintenance", () => {
    const maintenance = resolveMaintenanceConfigFromInput();

    expect(maintenance.mode).toBe("enforce");
  });

  it("batches normal entry-count maintenance for production-sized caps", () => {
    expect(resolveSessionEntryMaintenanceHighWater(2)).toBe(3);
    expect(resolveSessionEntryMaintenanceHighWater(50)).toBe(75);
    expect(resolveSessionEntryMaintenanceHighWater(500)).toBe(550);
  });
});

describe("getActiveSessionMaintenanceWarning", () => {
  it("warns when the active session is outside the retained recent entries", () => {
    const now = Date.now();
    const store = makeStore([
      ["newest", makeEntry(now)],
      ["recent", makeEntry(now - 1)],
      ["active", makeEntry(now - 2)],
      ["old", makeEntry(now - 3)],
    ]);

    const warning = getActiveSessionMaintenanceWarning({
      store,
      activeSessionKey: "active",
      pruneAfterMs: DAY_MS,
      maxEntries: 2,
      nowMs: now,
    });

    expect(warning?.wouldCap).toBe(true);
    expect(warning?.wouldPrune).toBe(false);
  });

  it("preserves insertion order tie behavior from stable sorting", () => {
    const now = Date.now();
    const store = makeStore([
      ["same-before", makeEntry(now)],
      ["active", makeEntry(now)],
      ["same-after", makeEntry(now)],
    ]);

    const warning = getActiveSessionMaintenanceWarning({
      store,
      activeSessionKey: "active",
      pruneAfterMs: DAY_MS,
      maxEntries: 1,
      nowMs: now,
    });

    expect(warning?.wouldCap).toBe(true);
  });
});
