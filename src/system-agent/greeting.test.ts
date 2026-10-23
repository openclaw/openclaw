import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import type { ConfigAuditRecord } from "../config/io.audit.js";
import type { SequencedSqliteAuditRecordEntry } from "../infra/sqlite-audit-record.kernel.js";
import { SYSTEM_AGENT_GREETING_SYSTEM_PROMPT } from "./assistant-prompts.js";
import {
  acknowledgeSystemAgentGreetingDelivery,
  buildSystemAgentGreetingQuestion,
  loadSystemAgentGreetingFacts,
  resolveSystemAgentGreeting,
  SYSTEM_AGENT_EXTERNAL_EDIT_ALERT,
  systemAgentGreetingChannelHealth,
  systemAgentGreetingFactsHash,
  type SystemAgentGreetingCacheRecord,
  type SystemAgentGreetingCacheStore,
  type SystemAgentGreetingFacts,
} from "./greeting.js";
import { createSystemAgentOverviewFixture } from "./overview.fixture.test-support.js";
import type { SystemAgentOverview } from "./overview.js";

function createOverview(overrides: Partial<SystemAgentOverview> = {}): SystemAgentOverview {
  return createSystemAgentOverviewFixture({
    config: { path: "/tmp/openclaw.json", exists: true, valid: true, issues: [], hash: "hash" },
    agents: [{ id: "main", name: "Main", isDefault: true, model: "openai/gpt-5.5" }],
    defaultModel: "openai/gpt-5.5",
    gateway: { url: "ws://127.0.0.1:18789", source: "test", reachable: true },
    ...overrides,
  });
}

const healthyFacts = (): SystemAgentGreetingFacts => ({
  updateAvailable: null,
  channelHealth: { available: true, degraded: [] },
  recentExternalEdit: false,
  auditSequence: 0,
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

function greet(
  cache: { store: SystemAgentGreetingCacheStore },
  overrides: Partial<Parameters<typeof resolveSystemAgentGreeting>[0]> = {},
) {
  return resolveSystemAgentGreeting({
    overview: createOverview(),
    facts: healthyFacts(),
    planner: async () => modelReply(),
    cacheStore: cache.store,
    ...overrides,
  });
}

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

function createCache(
  initial?: Omit<SystemAgentGreetingCacheRecord, "lastSeenAuditSequence"> & {
    lastSeenAuditSequence?: number;
  },
) {
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
    greet: (overrides: Parameters<typeof greet>[1] = {}) =>
      greet({ store }, { planner, ...overrides }),
  };
}

function configAuditEntry(
  sequence: number,
  event: ConfigAuditRecord["event"],
): SequencedSqliteAuditRecordEntry<ConfigAuditRecord> {
  return {
    key: `${event}-${sequence}`,
    value: { event, ts: new Date(sequence).toISOString() } as ConfigAuditRecord,
    createdAt: sequence,
    sequence,
  };
}

function createConfigAudit(
  initial: Array<SequencedSqliteAuditRecordEntry<ConfigAuditRecord>> = [],
) {
  const records = [...initial];
  const configAuditFacts = vi.fn(async (lastSeenAuditSequence: number) => ({
    auditSequence: Math.max(0, ...records.map((entry) => entry.sequence)),
    recentExternalEdit: records.some(
      (entry) => entry.sequence > lastSeenAuditSequence && entry.value.event === "config.external",
    ),
  }));
  return {
    store: { configAuditFacts, assertCurrent: vi.fn() },
    add: (entry: SequencedSqliteAuditRecordEntry<ConfigAuditRecord>) => records.push(entry),
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
      if (cached) {
        await cache.acknowledge(5);
        expect(cache.read()?.lastSeenAuditSequence).toBe(5);
      } else {
        expect(cache.read()).toBeUndefined();
      }
      expect(cache.planner).not.toHaveBeenCalled();
    },
  );

  it("calls the planner once after a state change and replaces the cache", async () => {
    const overview = createOverview();
    const priorFacts = healthyFacts();
    const facts = { ...priorFacts, updateAvailable: "2026.7.20", auditSequence: 6 };
    const cache = createCache(cachedGreeting());
    const planner = vi.fn(async () =>
      modelReply("I'm steady.\nAn upgrade to 2026.7.20 is ready when you are."),
    );

    const result = await cache.greet({
      overview,
      facts,
      planner,
      now: () => 200,
    });

    expect(result).toBe("I'm steady.\nAn upgrade to 2026.7.20 is ready when you are.");
    expect(planner).toHaveBeenCalledOnce();
    expect(planner).toHaveBeenCalledWith(
      expect.objectContaining({ overview, facts, timeoutMs: 20_000 }),
    );
    await cache.acknowledge(facts.auditSequence);
    expect(cache.read()).toMatchObject({
      lastSeenAuditSequence: 6,
      factsHash: systemAgentGreetingFactsHash(overview, facts),
      modelRef: "openai/gpt-5.5",
      at: 200,
    });
  });

  it("appends the host-owned edit alert at delivery without caching it", async () => {
    const facts = { ...healthyFacts(), recentExternalEdit: true, auditSequence: 9 };
    const cache = createCache();

    const result = await cache.greet({
      facts,
      now: () => 200,
    });

    expect(result).toBe(`All systems nominal.\n${SYSTEM_AGENT_EXTERNAL_EDIT_ALERT}`);
    // The cache stores only the model text; the alert is delivery-scoped.
    expect(cache.read()?.text).toBe("All systems nominal.");

    const calm = await cache.greet({
      facts: { ...facts, recentExternalEdit: false },
      now: () => 300,
    });
    expect(calm).toBe("All systems nominal.");
    expect(cache.planner).toHaveBeenCalledOnce();
  });

  it("reports an edit that arrives between the facts read and delivery", async () => {
    const cache = createCache({ lastSeenAuditSequence: 10 });
    const audit = createConfigAudit([configAuditEntry(10, "config.write")]);
    const facts = await cache.facts(audit);

    audit.add(configAuditEntry(11, "config.external"));
    await cache.acknowledge(facts.auditSequence);

    expect(await cache.facts(audit)).toMatchObject({ auditSequence: 11, recentExternalEdit: true });
  });

  it("keeps a template delivery as cursor-only state, then reports a later edit", async () => {
    const cache = createCache();
    const audit = createConfigAudit([configAuditEntry(3, "config.write")]);
    const facts = await cache.facts(audit);

    await expect(
      cache.greet({
        facts,
        planner: async () => {
          throw new Error("offline");
        },
      }),
    ).resolves.toBe(`${HEALTHY_GREETING_TEMPLATE}\nChannel health is not available yet.`);
    await cache.acknowledge(facts.auditSequence);
    expect(cache.read()).toEqual({ lastSeenAuditSequence: 3 });

    audit.add(configAuditEntry(4, "config.external"));
    expect(await cache.facts(audit)).toMatchObject({ auditSequence: 4, recentExternalEdit: true });
  });

  it("acknowledges a delivered edit so the next facts load is clear", async () => {
    const cache = createCache({ lastSeenAuditSequence: 1 });
    const audit = createConfigAudit([
      configAuditEntry(2, "config.external"),
      configAuditEntry(3, "config.write"),
    ]);
    const facts = await cache.facts(audit);
    expect(facts.recentExternalEdit).toBe(true);

    await cache.acknowledge(facts.auditSequence);

    expect(await cache.facts(audit)).toMatchObject({ auditSequence: 3, recentExternalEdit: false });
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
    const greeting = cache.greet({ now: () => 100 });
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

  it("timestamps the greeting snapshot before inference begins", async () => {
    const events: string[] = [];
    const cache = createCache();
    await cache.greet({
      planner: async () => {
        events.push("planner");
        return modelReply();
      },
      now: () => {
        events.push("snapshot");
        return 100;
      },
    });

    expect(events).toEqual(["snapshot", "planner"]);
    expect(cache.read()?.at).toBe(100);
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

    const result = await cache.greet({
      facts,
      planner,
      cacheOwner,
      now: () => 100,
    });
    const repeated = await renewedCache.greet({ facts, planner, cacheOwner, now: () => 200 });

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
        facts: { ...healthyFacts(), ...facts },
        planner: async () => modelReply(text),
        now: () => 100,
      });
      expect(result).toBe(HEALTHY_GREETING_TEMPLATE + suffix);
      expect(cache.read()).toBeUndefined();
    },
  );

  it("accepts model text that names every degraded channel", async () => {
    const cache = createCache();
    const text = "Telegram and Discord need attention.";
    const result = await cache.greet({
      facts: { ...healthyFacts(), channelHealth: degradedHealth },
      planner: async () => modelReply(text),
      now: () => 100,
    });
    expect(result).toBe(text);
    expect(cache.read()?.text).toBe(text);
  });

  it.each([
    [overviewWithConfig(false, false), "Config: missing"],
    [overviewWithConfig(true, false, ["invalid"]), "Config: invalid"],
    [offlineOverview(), "Gateway: not reachable"],
    [createOverview({ defaultModel: undefined }), "Inference is unavailable"],
  ] as const)(
    "uses the deterministic template (%s: %s) without opening the cache",
    async (overview, expected) => {
      const cache = createCache();
      const result = await cache.greet({ overview, now: () => 100 });

      expect(result).toContain(expected);
      expect(cache.planner).not.toHaveBeenCalled();
      expect(cache.store.latest).not.toHaveBeenCalled();
      expect(cache.read()).toBeUndefined();
    },
  );

  it.each(["failed", "revoked"])(
    "does not publish cached text after a %s asynchronous greeting read",
    async (failure) => {
      const cache = createCache(cachedGreeting({ text: "Cached greeting that must not publish." }));
      const readStarted = createDeferred();
      const finishRead = createDeferred();
      const latest = cache.store.latest;
      vi.spyOn(cache.store, "latest").mockImplementationOnce(async (...args) => {
        readStarted.resolve();
        await finishRead.promise;
        if (failure === "failed") {
          throw new Error("read failed");
        }
        return latest(...args);
      });
      const greeting = cache.greet();
      await awaitGateBeforeSettlement(readStarted.promise, greeting, "cache read did not start");
      if (failure === "revoked") {
        vi.spyOn(cache.store, "assertCurrent").mockImplementation(() => {
          throw new Error("store authority revoked");
        });
      }
      finishRead.resolve();

      if (failure === "revoked") {
        await expect(greeting).rejects.toThrow("store authority revoked");
      } else {
        await expect(greeting).resolves.toBe(HEALTHY_GREETING_TEMPLATE);
      }
      expect(cache.planner).not.toHaveBeenCalled();
      expect(cache.store.compareAndSet).not.toHaveBeenCalled();
    },
  );

  it("hashes decision fields stably while ignoring diagnostic-only details", () => {
    const facts = {
      ...healthyFacts(),
      channelHealth: degradedHealth,
    };
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

describe("system agent greeting identity", () => {
  it("identifies OpenClaw as the machine caretaker and describes every mild fact", () => {
    expect(SYSTEM_AGENT_GREETING_SYSTEM_PROMPT).toContain(
      "You are OpenClaw, the system itself — caretaker of this machine's gateway, config, channels, and agents.",
    );
    expect(SYSTEM_AGENT_GREETING_SYSTEM_PROMPT).toContain("nominal systems get one calm line");
    expect(SYSTEM_AGENT_GREETING_SYSTEM_PROMPT).toContain("If an update is available");
    expect(SYSTEM_AGENT_GREETING_SYSTEM_PROMPT).toContain("If channelHealthAvailable is false");
    expect(SYSTEM_AGENT_GREETING_SYSTEM_PROMPT).toContain("If channels are degraded");
    // The external-edit alert is host-appended at delivery; the model prompt
    // must not mention it (double phrasing).
    expect(SYSTEM_AGENT_GREETING_SYSTEM_PROMPT).not.toContain("recentExternalEdit");
  });
});

describe("system agent greeting facts", () => {
  it.each(["failed", "revoked"])(
    "does not publish audit facts after a %s asynchronous scan",
    async (failure) => {
      const audit = createConfigAudit([
        configAuditEntry(6, "config.external"),
        ...Array.from({ length: 5 }, (_, index) => configAuditEntry(index + 1, "config.write")),
      ]);
      const scanStarted = createDeferred();
      const finishScan = createDeferred();
      const readFacts = audit.store.configAuditFacts.getMockImplementation()!;
      audit.store.configAuditFacts.mockImplementation(async (lastSeenAuditSequence) => {
        scanStarted.resolve();
        await finishScan.promise;
        if (failure === "failed") {
          throw new Error("audit scan failed");
        }
        return readFacts(lastSeenAuditSequence);
      });
      const loading = loadSystemAgentGreetingFacts({
        cacheStore: createCache().store,
        configAuditStore: audit.store,
      });
      await awaitGateBeforeSettlement(scanStarted.promise, loading, "audit scan did not start");
      if (failure === "revoked") {
        audit.store.assertCurrent.mockImplementation(() => {
          throw new Error("audit source revoked");
        });
      }
      finishScan.resolve();

      if (failure === "revoked") {
        await expect(loading).rejects.toThrow("audit source revoked");
      } else {
        await expect(loading).resolves.toMatchObject({
          auditSequence: 0,
          recentExternalEdit: false,
        });
      }
    },
  );

  it("treats a missing greeting slot as audit watermark zero", async () => {
    const cache = createCache();
    const audit = createConfigAudit([configAuditEntry(1, "config.external")]);

    expect(await cache.facts(audit)).toMatchObject({ auditSequence: 1, recentExternalEdit: true });
  });

  it("uses cached update and health state without probing", async () => {
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
              accountId: "default",
              configured: true,
              healthState: "stale-socket",
            },
          },
          channelLabels: { telegram: "Telegram" },
        }) as never,
    });
    expect(facts).toEqual({
      updateAvailable: "2026.7.20",
      channelHealth: singleDegradedHealth,
      recentExternalEdit: true,
      auditSequence: 2,
    });
  });

  it("deduplicates and sorts degraded channel labels", () => {
    const health = systemAgentGreetingChannelHealth({
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
      },
      channelLabels: {
        telegram: "Telegram",
        discord: "Discord",
        slack: "Slack",
        whatsapp: "WhatsApp",
      },
    } as never);
    expect(health).toEqual({
      available: true,
      degraded: ["Discord", "Slack", "Telegram", "WhatsApp"],
    });
  });
});

describe("system agent quick actions", () => {
  it.each([
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
  ] satisfies Array<
    [string, SystemAgentOverview | undefined, Partial<SystemAgentGreetingFacts>, string[]]
  >)("builds canonical replies for %s facts", (_name, overview, facts, replies) => {
    const question = buildSystemAgentGreetingQuestion(overview ?? createOverview(), {
      ...healthyFacts(),
      ...facts,
    });
    expect(question.header).toBe("Quick actions");
    expect(question.options.map((option) => option.reply)).toEqual(replies);
  });

  it("does not recommend agent handoff for a recent external edit", () => {
    const question = buildSystemAgentGreetingQuestion(createOverview(), {
      ...healthyFacts(),
      recentExternalEdit: true,
    });
    expect(question.options.find((option) => option.reply === "talk to agent")?.recommended).toBe(
      false,
    );
  });
});
