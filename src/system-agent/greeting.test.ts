import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import type { ConfigAuditRecord } from "../config/io.audit.js";
import {
  acknowledgeSystemAgentGreetingDelivery,
  buildSystemAgentGreetingQuestion,
  loadSystemAgentGreetingFacts,
  resolveSystemAgentGreeting,
  SYSTEM_AGENT_EXTERNAL_EDIT_ALERT,
  systemAgentGreetingFactsHash,
  type SystemAgentGreetingCacheRecord,
  type SystemAgentGreetingCacheStore,
  type SystemAgentGreetingFacts,
} from "./greeting.js";
import { createSystemAgentOverviewFixture } from "./overview.fixture.test-support.js";
import type { SystemAgentOverview } from "./overview.js";

afterEach(() => void vi.restoreAllMocks());

function createOverview(overrides: Partial<SystemAgentOverview> = {}): SystemAgentOverview {
  return createSystemAgentOverviewFixture({
    config: { path: "/tmp/openclaw.json", exists: true, valid: true, issues: [], hash: "hash" },
    agents: [{ id: "main", name: "Main", isDefault: true, model: "openai/gpt-5.5" }],
    defaultModel: "openai/gpt-5.5",
    gateway: { url: "ws://127.0.0.1:18789", source: "test", reachable: true },
    ...overrides,
  });
}

const healthyFacts = (
  overrides: Partial<SystemAgentGreetingFacts> = {},
): SystemAgentGreetingFacts => ({
  updateAvailable: null,
  channelHealth: { available: true, degraded: [] },
  recentExternalEdit: false,
  auditSequence: 0,
  ...overrides,
});

function overviewWithConfig(exists: boolean, valid: boolean, issues: string[] = []) {
  return createOverview({
    config: { path: "/tmp/openclaw.json", exists, valid, issues, hash: null },
  });
}

const offlineOverview = () =>
  createOverview({
    gateway: { url: "ws://127.0.0.1:18789", source: "test", reachable: false },
  });

const HEALTHY_GREETING_TEMPLATE = [
  "Hi, I'm OpenClaw — caretaker of this gateway, config, channels, and agents.",
  "Model: openai/gpt-5.5.",
  "Config: valid. Default agent: main (Main).",
  "Gateway: reachable at ws://127.0.0.1:18789.",
].join("\n");

const modelReply = (text = "All systems nominal.") => ({ text, modelRef: "openai/gpt-5.5" });
const cachedGreeting = (overrides: Partial<SystemAgentGreetingCacheRecord> = {}) => ({
  lastSeenAuditSequence: 0,
  factsHash: systemAgentGreetingFactsHash(createOverview(), healthyFacts()),
  ...modelReply(),
  at: 100,
  ...overrides,
});
const unavailableHealth = { available: false, degraded: [] };
const degradedHealth = { available: true, degraded: ["Telegram", "Discord"] };
const singleDegradedHealth = { available: true, degraded: ["Telegram"] };
const handoffReplies = (...actions: string[]) => [...actions, "talk to agent", "audit"];

function createCache(initial?: Partial<SystemAgentGreetingCacheRecord>) {
  let record: SystemAgentGreetingCacheRecord | undefined = initial
    ? { lastSeenAuditSequence: 0, ...initial }
    : undefined;
  const store: SystemAgentGreetingCacheStore = {
    assertCurrent: vi.fn(),
    latest: vi.fn(async () =>
      record ? [{ key: "latest", value: record, createdAt: record.at ?? 0, sequence: 1 }] : [],
    ),
    compareAndSet: vi.fn(async (_key, expectedValue, value) => {
      if (JSON.stringify(record ?? null) !== JSON.stringify(expectedValue)) {
        return false;
      }
      record = value ?? undefined;
      return true;
    }),
  };
  const planner = vi.fn(async () => modelReply());
  return {
    store,
    planner,
    read: () => record,
    acknowledge: (auditSequence: number) =>
      acknowledgeSystemAgentGreetingDelivery({ auditSequence, cacheStore: store }),
    facts: (audit: ReturnType<typeof createConfigAudit>) =>
      loadSystemAgentGreetingFacts({ cacheStore: store, configAuditStore: audit.store }),
    greet: (overrides: Partial<Parameters<typeof resolveSystemAgentGreeting>[0]> = {}) =>
      resolveSystemAgentGreeting({
        overview: createOverview(),
        facts: healthyFacts(),
        cacheStore: store,
        planner,
        ...overrides,
      }),
  };
}

type AuditFact = [sequence: number, event: ConfigAuditRecord["event"]];
function createConfigAudit(initial: AuditFact[] = []) {
  const records = [...initial];
  const configAuditFacts = vi.fn(async (lastSeenAuditSequence: number) => ({
    auditSequence: Math.max(0, ...records.map(([sequence]) => sequence)),
    recentExternalEdit: records.some(
      ([sequence, event]) => sequence > lastSeenAuditSequence && event === "config.external",
    ),
  }));
  return {
    store: { configAuditFacts, assertCurrent: vi.fn() },
    add: (sequence: number, event: ConfigAuditRecord["event"]) => records.push([sequence, event]),
  };
}

describe("system agent greeting cache", () => {
  it.each([false, true])(
    "never calls the planner with inference disabled (cached=%s)",
    async (cached) => {
      const cache = createCache(cached ? cachedGreeting({ lastSeenAuditSequence: 4 }) : undefined);
      await expect(cache.greet({ allowInference: false })).resolves.toBe(
        cached ? "All systems nominal." : HEALTHY_GREETING_TEMPLATE,
      );
      if (!cached) {
        expect(cache.read()).toBeUndefined();
      }
      expect(cache.planner).not.toHaveBeenCalled();
    },
  );

  it("replaces the cached greeting after a state change", async () => {
    const overview = createOverview();
    const facts = healthyFacts({
      updateAvailable: "2026.7.20",
      channelHealth: degradedHealth,
      auditSequence: 6,
    });
    const cache = createCache(cachedGreeting());
    const clock = vi.spyOn(Date, "now").mockReturnValue(200);
    const text = "Upgrade to 2026.7.20 is ready. Telegram and Discord need attention.";
    const planner = vi.fn(async () => {
      expect(clock).toHaveBeenCalled();
      clock.mockReturnValue(300);
      return modelReply(text);
    });
    const result = await cache.greet({ overview, facts, planner });

    expect(result).toBe(text);
    await cache.acknowledge(facts.auditSequence);
    expect(cache.read()).toMatchObject({
      lastSeenAuditSequence: 6,
      factsHash: systemAgentGreetingFactsHash(overview, facts),
      text,
      modelRef: "openai/gpt-5.5",
      at: 200,
    });
  });

  it("appends the host-owned edit alert at delivery without caching it", async () => {
    const facts = healthyFacts({ recentExternalEdit: true, auditSequence: 9 });
    const cache = createCache();

    const result = await cache.greet({ facts });

    expect(result).toBe(`All systems nominal.\n${SYSTEM_AGENT_EXTERNAL_EDIT_ALERT}`);
    // The cache stores only the model text; the alert is delivery-scoped.
    expect(cache.read()?.text).toBe("All systems nominal.");

    await expect(cache.greet({ facts: { ...facts, recentExternalEdit: false } })).resolves.toBe(
      "All systems nominal.",
    );
    expect(cache.planner).toHaveBeenCalledOnce();
  });

  it("reports an edit that arrives between the facts read and delivery", async () => {
    const cache = createCache({ lastSeenAuditSequence: 10 });
    const audit = createConfigAudit([[10, "config.write"]]);
    const facts = await cache.facts(audit);

    audit.add(11, "config.external");
    await cache.acknowledge(facts.auditSequence);

    expect(await cache.facts(audit)).toMatchObject({ auditSequence: 11, recentExternalEdit: true });
  });

  it("advances the audit cursor only through delivered facts and reports later edits", async () => {
    const cache = createCache();
    const audit = createConfigAudit([[3, "config.external"]]);
    const facts = await cache.facts(audit);
    expect(facts).toMatchObject({ auditSequence: 3, recentExternalEdit: true });

    await expect(
      cache.greet({
        facts,
        planner: async () => {
          throw new Error("offline");
        },
      }),
    ).resolves.toBe(
      `${HEALTHY_GREETING_TEMPLATE}\nChannel health is not available yet.\n${SYSTEM_AGENT_EXTERNAL_EDIT_ALERT}`,
    );
    await cache.acknowledge(facts.auditSequence);
    expect(cache.read()).toEqual({ lastSeenAuditSequence: 3 });
    expect(await cache.facts(audit)).toMatchObject({ auditSequence: 3, recentExternalEdit: false });

    audit.add(4, "config.external");
    audit.add(5, "config.write");
    const later = await cache.facts(audit);
    expect(later).toMatchObject({ auditSequence: 5, recentExternalEdit: true });
    await cache.acknowledge(later.auditSequence);
    expect(await cache.facts(audit)).toMatchObject({ auditSequence: 5, recentExternalEdit: false });
  });

  it.each([
    { outcome: "definite conflict", attempts: 4 },
    { outcome: "unknown write outcome", attempts: 1 },
  ])("bounds acknowledgement retries after $outcome", async ({ outcome, attempts }) => {
    const cache = createCache({ lastSeenAuditSequence: 1 });
    const compareAndSet = vi.spyOn(cache.store, "compareAndSet");
    if (outcome === "definite conflict") {
      compareAndSet.mockResolvedValue(false);
    } else {
      compareAndSet.mockRejectedValue(new Error("writer disconnected before acknowledgement"));
    }

    await cache.acknowledge(2);

    expect(compareAndSet).toHaveBeenCalledTimes(attempts);
    expect(cache.read()?.lastSeenAuditSequence).toBe(1);
  });

  it("retries a stale greeting write without losing a concurrent delivery watermark", async () => {
    const cache = createCache();
    const reachedWrite = createDeferred();
    const resumeWrite = createDeferred();
    const compareAndSet = cache.store.compareAndSet;
    vi.spyOn(cache.store, "compareAndSet").mockImplementationOnce(async (...args) => {
      reachedWrite.resolve();
      await resumeWrite.promise;
      return compareAndSet(...args);
    });
    vi.spyOn(Date, "now").mockReturnValue(100);
    const greeting = cache.greet();
    await awaitGateBeforeSettlement(reachedWrite.promise, greeting, "greeting never reached CAS");
    await cache.acknowledge(7);
    resumeWrite.resolve();
    await greeting;

    expect(cache.read()).toMatchObject({
      lastSeenAuditSequence: 7,
      text: "All systems nominal.",
      at: 100,
    });
  });

  it("coalesces concurrent planner calls for the same facts", async () => {
    const cache = createCache();
    const started = createDeferred();
    const plan = createDeferred<{ text: string; modelRef: string }>();
    const planner = vi.fn(() => {
      started.resolve();
      return plan.promise;
    });

    const first = cache.greet({ planner });
    const second = cache.greet({ planner });
    await awaitGateBeforeSettlement(started.promise, first, "planner did not start");
    plan.resolve(modelReply());

    await expect(Promise.all([first, second])).resolves.toEqual([
      "All systems nominal.",
      "All systems nominal.",
    ]);
    expect(planner).toHaveBeenCalledOnce();
  });

  it("keeps template failure backoff when the same owner captures a new store", async () => {
    const cache = createCache();
    const renewedCache = createCache();
    const cacheOwner = {};
    const planner = vi.fn(async () => {
      throw new Error("offline");
    });
    const facts: SystemAgentGreetingFacts = {
      updateAvailable: "2026.7.20",
      channelHealth: singleDegradedHealth,
      recentExternalEdit: true,
      auditSequence: 7,
    };

    const clock = vi.spyOn(Date, "now").mockReturnValue(100);
    const result = await cache.greet({ facts, planner, cacheOwner });
    clock.mockReturnValue(200);
    const repeated = await renewedCache.greet({ facts, planner, cacheOwner });

    expect(result).toBe(
      `${HEALTHY_GREETING_TEMPLATE}\nUpdate 2026.7.20 is available. Channels needing attention: Telegram.\n${SYSTEM_AGENT_EXTERNAL_EDIT_ALERT}`,
    );
    expect(repeated).toEqual(result);
    expect(planner).toHaveBeenCalledOnce();
    await renewedCache.acknowledge(facts.auditSequence);
    expect(renewedCache.read()).toEqual({ lastSeenAuditSequence: 7 });
  });

  it.each([
    ["structured output", {}, 'Sure:\n{"status":"healthy"}', ""],
    [
      "missing update version",
      { updateAvailable: "2026.7.20" },
      "An update is ready when you are.",
      "\nUpdate 2026.7.20 is available.",
    ],
    [
      "missing degraded channel",
      { channelHealth: degradedHealth },
      "Telegram needs attention.",
      "\nChannels needing attention: Telegram, Discord.",
    ],
    [
      "missing health unavailability",
      { channelHealth: unavailableHealth },
      "All systems nominal.",
      "\nChannel health is not available yet.",
    ],
  ] satisfies Array<[string, Partial<SystemAgentGreetingFacts>, string, string]>)(
    "does not cache model text with %s",
    async (_name, facts, text, suffix) => {
      const cache = createCache();
      const result = await cache.greet({
        facts: healthyFacts(facts),
        planner: async () => modelReply(text),
      });
      expect(result).toBe(HEALTHY_GREETING_TEMPLATE + suffix);
      expect(cache.read()).toBeUndefined();
    },
  );

  it.each([
    [overviewWithConfig(false, false), "Config: missing"],
    [overviewWithConfig(true, false, ["invalid"]), "Config: invalid"],
    [offlineOverview(), "Gateway: not reachable"],
    [createOverview({ defaultModel: undefined }), "Inference is unavailable"],
  ] as const)(
    "uses the deterministic template (%s: %s) without opening the cache",
    async (overview, expected) => {
      const cache = createCache();
      const result = await cache.greet({ overview });

      expect(result).toContain(expected);
      expect(cache.planner).not.toHaveBeenCalled();
      expect(cache.store.latest).not.toHaveBeenCalled();
      expect(cache.read()).toBeUndefined();
    },
  );

  it("hashes decision fields stably while ignoring diagnostic-only details", () => {
    const facts = healthyFacts({ channelHealth: degradedHealth });
    const left = createOverview();
    const right = createOverview({
      config: {
        ...left.config,
        path: "/another/config.json",
        hash: "another-hash",
        issues: ["diagnostic detail"],
      },
      agents: [...left.agents].toReversed(),
      gateway: { ...left.gateway, source: "another source", error: "diagnostic detail" },
    });
    expect(systemAgentGreetingFactsHash(left, facts)).toBe(
      systemAgentGreetingFactsHash(right, {
        ...facts,
        auditSequence: 999,
        channelHealth: { available: true, degraded: ["Discord", "Telegram"] },
      }),
    );
    expect(systemAgentGreetingFactsHash(left, facts)).not.toBe(
      systemAgentGreetingFactsHash(left, {
        ...facts,
        channelHealth: unavailableHealth,
      }),
    );
  });
});

describe("system agent greeting facts", () => {
  it.each([
    ["cache", "failed"],
    ["cache", "revoked"],
    ["audit", "failed"],
    ["audit", "revoked"],
  ] as const)("does not publish after a %s read is %s", async (source, failure) => {
    const cache = createCache(cachedGreeting({ text: "Cached greeting that must not publish." }));
    const audit = createConfigAudit([[6, "config.external"]]);
    const started = createDeferred();
    const finish = createDeferred();
    const pause = async () => {
      started.resolve();
      await finish.promise;
      if (failure === "failed") {
        throw new Error("read failed");
      }
    };
    if (source === "cache") {
      const read = cache.store.latest;
      vi.spyOn(cache.store, "latest").mockImplementationOnce(async (...args) => {
        await pause();
        return read(...args);
      });
    } else {
      const read = audit.store.configAuditFacts.getMockImplementation()!;
      audit.store.configAuditFacts.mockImplementation(async (...args) => {
        await pause();
        return read(...args);
      });
    }
    const loading = source === "cache" ? cache.greet() : cache.facts(audit);
    await awaitGateBeforeSettlement(started.promise, loading, "read did not start");
    if (failure === "revoked") {
      vi.spyOn(source === "cache" ? cache.store : audit.store, "assertCurrent").mockImplementation(
        () => {
          throw new Error("source revoked");
        },
      );
    }
    finish.resolve();
    if (failure === "revoked") {
      await expect(loading).rejects.toThrow("source revoked");
    } else {
      await expect(loading).resolves.toEqual(
        source === "cache"
          ? HEALTHY_GREETING_TEMPLATE
          : expect.objectContaining({ auditSequence: 0, recentExternalEdit: false }),
      );
    }
    expect(cache.planner).not.toHaveBeenCalled();
    expect(cache.store.compareAndSet).not.toHaveBeenCalled();
  });

  it("loads cached facts and sorts degraded channel labels without probing", async () => {
    const facts = await loadSystemAgentGreetingFacts({
      cacheStore: createCache({ lastSeenAuditSequence: 0 }).store,
      configAuditStore: {
        assertCurrent: vi.fn(),
        configAuditFacts: async () => ({ auditSequence: 2, recentExternalEdit: true }),
      },
      getUpdateAvailable: () => ({
        currentVersion: "2026.7.19",
        latestVersion: "2026.7.20",
        channel: "latest",
      }),
      getHealthCache: () =>
        ({
          channels: {
            telegram: {
              accountId: "primary",
              accounts: {
                primary: { accountId: "primary", configured: true, probe: { ok: false } },
                quiet: { accountId: "quiet", configured: false, healthState: "not-running" },
              },
            },
            discord: { accountId: "default", running: true, connected: false },
            slack: { accountId: "default", configured: true, running: false },
            whatsapp: { accountId: "default", configured: true, running: true, linked: false },
            signal: { accountId: "default", configured: true, healthState: "stale-socket" },
          },
          channelLabels: {
            telegram: "Telegram",
            discord: "Discord",
            slack: "Slack",
            whatsapp: "WhatsApp",
            signal: "Signal",
          },
        }) as never,
    });
    expect(facts).toEqual({
      updateAvailable: "2026.7.20",
      channelHealth: {
        available: true,
        degraded: ["Discord", "Signal", "Slack", "Telegram", "WhatsApp"],
      },
      recentExternalEdit: true,
      auditSequence: 2,
    });
  });
});

describe("system agent quick actions", () => {
  it.each<[string, SystemAgentOverview | undefined, Partial<SystemAgentGreetingFacts>, string[]]>([
    ["healthy", undefined, {}, handoffReplies()],
    ["unknown health", undefined, { channelHealth: unavailableHealth }, handoffReplies("health")],
    ["missing config", overviewWithConfig(false, true), {}, handoffReplies("setup")],
    ["invalid config", overviewWithConfig(true, false, ["invalid"]), {}, handoffReplies("doctor")],
    ["missing model", createOverview({ defaultModel: undefined }), {}, ["setup", "audit"]],
    [
      "update and manual edit",
      undefined,
      { updateAvailable: "2026.7.20", recentExternalEdit: true },
      handoffReplies("status"),
    ],
    ["degraded", undefined, { channelHealth: singleDegradedHealth }, handoffReplies("health")],
    [
      "several exceptional facts",
      offlineOverview(),
      {
        updateAvailable: "2026.7.20",
        channelHealth: singleDegradedHealth,
        recentExternalEdit: true,
      },
      handoffReplies("gateway status", "restart gateway"),
    ],
  ])("builds canonical replies for %s facts", (_name, overview, facts, replies) => {
    const question = buildSystemAgentGreetingQuestion(
      overview ?? createOverview(),
      healthyFacts(facts),
    );
    expect(question.header).toBe("Quick actions");
    expect(question.options.map((option) => option.reply)).toEqual(replies);
    if (facts.recentExternalEdit) {
      expect(question.options.find((option) => option.reply === "talk to agent")?.recommended).toBe(
        false,
      );
    }
  });
});
