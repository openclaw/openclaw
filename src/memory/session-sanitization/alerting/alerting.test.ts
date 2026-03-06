/**
 * Phase 4 alerting tests.
 *
 * Covers: config resolution, in-memory state (index, dedup, rate limit, daily
 * summary), rule evaluation (all 5 rules), webhook delivery (HMAC signing,
 * retries), and end-to-end notifyAlerting integration.
 */

import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { AuditEventRecord } from "../types.js";
import { resolveAlertingConfig } from "./config.js";
import {
  evaluateFrequencyEscalation,
  evaluateSemanticCatch,
  evaluateSyntacticFailBurst,
  evaluateTrustedToolSchemaFail,
  evaluateWriteFailSpike,
} from "./rules.js";
import { notifyAlerting, resetAlertingState } from "./service.js";
import {
  addToIndex,
  buildDedupKey,
  getDailySummary,
  incrementDailyCount,
  isDeduped,
  isRateLimited,
  queryIndex,
  recordDelivery,
  recordFired,
  sweepIndex,
} from "./state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AGENT_ID = "main";
const SESSION_ID = "sess-alert-1";
const NOW = Date.now();

function makeEvent(
  event: string,
  extra: Partial<AuditEventRecord> = {},
): AuditEventRecord {
  return {
    event: event as AuditEventRecord["event"],
    timestamp: new Date(NOW).toISOString(),
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
    ...extra,
  } as AuditEventRecord;
}

function makeCfg(overrides?: Partial<OpenClawConfig["alerting"]>): OpenClawConfig {
  return {
    alerting: {
      enabled: true,
      ...overrides,
    },
    memory: {
      sessions: {
        sanitization: {
          mcp: { enabled: true, trustedServers: ["trusted-server"], blockOnSandboxUnavailable: true },
        },
      },
    },
    agents: { defaults: { sandbox: { mode: "non-main" } } },
  };
}

afterEach(() => {
  resetAlertingState();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

describe("resolveAlertingConfig", () => {
  it("applies correct defaults", () => {
    const cfg = resolveAlertingConfig({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.channels.webhook.url).toBeNull();
    expect(cfg.channels.webhook.secret).toBeNull();
    expect(cfg.channels.webhook.retries).toBe(2);
    expect(cfg.channels.webhook.retryDelayMs).toBe(1000);
    expect(cfg.channels.webhook.timeoutMs).toBe(5000);
    expect(cfg.suppression.windowMs).toBe(5 * 60_000);
    expect(cfg.rateLimit.maxPerMinute).toBe(20);
    expect(cfg.rateLimit.maxPerHour).toBe(100);
    expect(cfg.retention.days).toBe(30);
    expect(cfg.payload.recentContextMax).toBe(20);
    expect(cfg.index.ttlMs).toBe(60 * 60_000);
    expect(cfg.rules.syntacticFailBurst.count).toBe(5);
    expect(cfg.rules.syntacticFailBurst.windowMs).toBe(10 * 60_000);
    expect(cfg.rules.trustedToolSchemaFail.enabled).toBe(true);
    expect(cfg.rules.frequencyEscalation.tier2).toBe(true);
    expect(cfg.rules.frequencyEscalation.tier3).toBe(true); // always true
    expect(cfg.rules.semanticCatchNoSyntacticFlag.enabled).toBe(true);
    expect(cfg.rules.semanticCatchNoSyntacticFlag.escalateAfter).toBe(3);
    expect(cfg.rules.writeFailSpike.count).toBe(3);
    expect(cfg.rules.writeFailSpike.windowMs).toBe(5 * 60_000);
  });

  it("respects custom values", () => {
    const cfg = resolveAlertingConfig({
      alerting: {
        enabled: false,
        suppression: { windowMinutes: 30 },
        rateLimit: { maxPerMinute: 5, maxPerHour: 50 },
        rules: {
          syntacticFailBurst: { count: 10, windowMinutes: 20 },
          writeFailSpike: { count: 5, windowMinutes: 2 },
        },
      },
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.suppression.windowMs).toBe(30 * 60_000);
    expect(cfg.rateLimit.maxPerMinute).toBe(5);
    expect(cfg.rules.syntacticFailBurst.count).toBe(10);
    expect(cfg.rules.syntacticFailBurst.windowMs).toBe(20 * 60_000);
    expect(cfg.rules.writeFailSpike.count).toBe(5);
  });

  it("tier3 cannot be disabled via config", () => {
    const cfg = resolveAlertingConfig({
      alerting: { rules: { frequencyEscalation: { tier3: { enabled: false } } } },
    });
    expect(cfg.rules.frequencyEscalation.tier3).toBe(true);
  });

  it("reads trustedServers from MCP config", () => {
    const cfg = resolveAlertingConfig({
      memory: {
        sessions: {
          sanitization: {
            mcp: { enabled: true, trustedServers: ["server-a", "server-b"] },
          },
        },
      },
    });
    expect(cfg.trustedServers).toEqual(["server-a", "server-b"]);
  });
});

// ---------------------------------------------------------------------------
// State module
// ---------------------------------------------------------------------------

describe("event index", () => {
  it("addToIndex and queryIndex find recent events", () => {
    const entry = makeEvent("syntactic_fail");
    addToIndex(entry, NOW);
    const results = queryIndex({ event: "syntactic_fail", agentId: AGENT_ID, windowMs: 60_000, now: NOW });
    expect(results).toHaveLength(1);
  });

  it("queryIndex filters by sessionId", () => {
    addToIndex(makeEvent("syntactic_fail", { sessionId: "sess-a" }), NOW);
    addToIndex(makeEvent("syntactic_fail", { sessionId: "sess-b" }), NOW);
    const results = queryIndex({ event: "syntactic_fail", agentId: AGENT_ID, sessionId: "sess-a", windowMs: 60_000, now: NOW });
    expect(results).toHaveLength(1);
    expect(results[0]?.sessionId).toBe("sess-a");
  });

  it("queryIndex without event filter returns all event types", () => {
    addToIndex(makeEvent("syntactic_fail"), NOW);
    addToIndex(makeEvent("sanitized_pass"), NOW);
    const results = queryIndex({ agentId: AGENT_ID, windowMs: 60_000, now: NOW });
    expect(results).toHaveLength(2);
  });

  it("queryIndex respects windowMs", () => {
    const old = NOW - 70_000;
    addToIndex(makeEvent("syntactic_fail"), old);
    addToIndex(makeEvent("syntactic_fail"), NOW);
    const results = queryIndex({ event: "syntactic_fail", agentId: AGENT_ID, windowMs: 60_000, now: NOW });
    expect(results).toHaveLength(1); // only the recent one
  });

  it("sweepIndex removes entries older than TTL", () => {
    addToIndex(makeEvent("syntactic_fail"), NOW - 70_000);
    addToIndex(makeEvent("syntactic_fail"), NOW);
    sweepIndex(60_000, NOW);
    const results = queryIndex({ event: "syntactic_fail", agentId: AGENT_ID, windowMs: 120_000, now: NOW });
    expect(results).toHaveLength(1);
  });
});

describe("deduplication state", () => {
  it("isDeduped returns false before first fire", () => {
    const key = buildDedupKey("rule1", AGENT_ID, SESSION_ID);
    expect(isDeduped(key, 300_000, NOW)).toBe(false);
  });

  it("isDeduped returns true within suppression window after recordFired", () => {
    const key = buildDedupKey("rule1", AGENT_ID, SESSION_ID);
    recordFired(key, NOW);
    expect(isDeduped(key, 300_000, NOW + 1000)).toBe(true);
  });

  it("isDeduped returns false after suppression window expires", () => {
    const key = buildDedupKey("rule1", AGENT_ID, SESSION_ID);
    recordFired(key, NOW - 400_000);
    expect(isDeduped(key, 300_000, NOW)).toBe(false);
  });

  it("different ruleIds have independent dedup keys", () => {
    const key1 = buildDedupKey("rule1", AGENT_ID, SESSION_ID);
    const key2 = buildDedupKey("rule2", AGENT_ID, SESSION_ID);
    recordFired(key1, NOW);
    expect(isDeduped(key2, 300_000, NOW)).toBe(false);
  });
});

describe("rate limiting state", () => {
  it("isRateLimited returns false before hitting limits", () => {
    expect(isRateLimited("rule1", 20, 100, NOW)).toBe(false);
  });

  it("isRateLimited returns true when per-minute limit hit", () => {
    for (let i = 0; i < 3; i++) recordDelivery("rule1", NOW);
    expect(isRateLimited("rule1", 3, 100, NOW)).toBe(true);
  });

  it("isRateLimited resets after minute window passes", () => {
    for (let i = 0; i < 3; i++) recordDelivery("rule1", NOW - 70_000); // 70s ago
    expect(isRateLimited("rule1", 3, 100, NOW)).toBe(false);
  });
});

describe("daily summary", () => {
  it("getDailySummary reflects incremented counts", () => {
    incrementDailyCount("syntacticFailBurst", NOW);
    incrementDailyCount("syntacticFailBurst", NOW);
    incrementDailyCount("writeFailSpike", NOW);
    const summary = getDailySummary();
    expect(summary.counts.syntacticFailBurst).toBe(2);
    expect(summary.counts.writeFailSpike).toBe(1);
  });

  it("getDailySummary returns empty counts when nothing has fired", () => {
    const summary = getDailySummary();
    expect(Object.keys(summary.counts)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rule evaluation
// ---------------------------------------------------------------------------

describe("evaluateSyntacticFailBurst", () => {
  const cfg = resolveAlertingConfig(makeCfg({ rules: { syntacticFailBurst: { count: 3, windowMinutes: 10 } } }));

  it("returns null for non-syntactic_fail events", () => {
    const entry = makeEvent("sanitized_pass");
    expect(evaluateSyntacticFailBurst({ entry, cfg, recentContext: [], now: NOW })).toBeNull();
  });

  it("returns null when count is below threshold", () => {
    // Add 2 events to index (below threshold of 3)
    for (let i = 0; i < 2; i++) addToIndex(makeEvent("syntactic_fail"), NOW);
    const entry = makeEvent("syntactic_fail");
    expect(evaluateSyntacticFailBurst({ entry, cfg, recentContext: [], now: NOW })).toBeNull();
  });

  it("returns alert when count reaches threshold", () => {
    // 2 in index + 1 current = 3 → but queryIndex only reads the index
    // Add 3 events to index first
    for (let i = 0; i < 3; i++) addToIndex(makeEvent("syntactic_fail"), NOW);
    const entry = makeEvent("syntactic_fail");
    const alert = evaluateSyntacticFailBurst({ entry, cfg, recentContext: [], now: NOW });
    expect(alert).not.toBeNull();
    expect(alert?.ruleId).toBe("syntacticFailBurst");
    expect(alert?.severity).toBe("medium");
  });

  it("uses high severity when count exceeds 2x threshold", () => {
    for (let i = 0; i < 7; i++) addToIndex(makeEvent("syntactic_fail"), NOW);
    const entry = makeEvent("syntactic_fail");
    const alert = evaluateSyntacticFailBurst({ entry, cfg, recentContext: [], now: NOW });
    expect(alert?.severity).toBe("high");
  });

  it("alert has correct agentId, sessionId, summary", () => {
    for (let i = 0; i < 3; i++) addToIndex(makeEvent("syntactic_fail"), NOW);
    const entry = makeEvent("syntactic_fail");
    const alert = evaluateSyntacticFailBurst({ entry, cfg, recentContext: [], now: NOW });
    expect(alert?.agentId).toBe(AGENT_ID);
    expect(alert?.sessionId).toBe(SESSION_ID);
    expect(alert?.summary).toContain("syntactic_fail");
  });
});

describe("evaluateTrustedToolSchemaFail", () => {
  const cfg = resolveAlertingConfig(makeCfg());

  it("returns null for non-schema_fail events", () => {
    const entry = makeEvent("syntactic_fail", { server: "trusted-server" });
    expect(evaluateTrustedToolSchemaFail({ entry, cfg, recentContext: [], now: NOW })).toBeNull();
  });

  it("returns null when server is not trusted", () => {
    const entry = makeEvent("schema_fail", { server: "unknown-server" });
    expect(evaluateTrustedToolSchemaFail({ entry, cfg, recentContext: [], now: NOW })).toBeNull();
  });

  it("returns null when schema_fail has no server field", () => {
    const entry = makeEvent("schema_fail");
    expect(evaluateTrustedToolSchemaFail({ entry, cfg, recentContext: [], now: NOW })).toBeNull();
  });

  it("returns alert when schema_fail occurs for a trusted server", () => {
    const entry = makeEvent("schema_fail", { server: "trusted-server" });
    const alert = evaluateTrustedToolSchemaFail({ entry, cfg, recentContext: [], now: NOW });
    expect(alert).not.toBeNull();
    expect(alert?.ruleId).toBe("trustedToolSchemaFail");
    expect(alert?.severity).toBe("high");
    expect(alert?.summary).toContain("trusted-server");
  });

  it("returns null when trustedToolSchemaFail rule is disabled", () => {
    const disabledCfg = resolveAlertingConfig(
      makeCfg({ rules: { trustedToolSchemaFail: { enabled: false } } }),
    );
    const entry = makeEvent("schema_fail", { server: "trusted-server" });
    expect(evaluateTrustedToolSchemaFail({ entry, cfg: disabledCfg, recentContext: [], now: NOW })).toBeNull();
  });
});

describe("evaluateFrequencyEscalation", () => {
  const cfg = resolveAlertingConfig(makeCfg());

  it("returns null for unrelated events", () => {
    const entry = makeEvent("syntactic_fail");
    expect(evaluateFrequencyEscalation({ entry, cfg, recentContext: [], now: NOW })).toBeNull();
  });

  it("returns medium severity alert for tier2 escalation", () => {
    const entry = makeEvent("frequency_escalation_tier2", { currentScore: 35 });
    const alert = evaluateFrequencyEscalation({ entry, cfg, recentContext: [], now: NOW });
    expect(alert?.ruleId).toBe("frequencyEscalation");
    expect(alert?.severity).toBe("medium");
    expect(alert?.details.sessionSuspicionScore).toBe(35);
  });

  it("returns critical severity alert for tier3 escalation", () => {
    const entry = makeEvent("frequency_escalation_tier3", { currentScore: 55 });
    const alert = evaluateFrequencyEscalation({ entry, cfg, recentContext: [], now: NOW });
    expect(alert?.severity).toBe("critical");
  });

  it("suppresses tier2 when frequencyEscalation.tier2 disabled", () => {
    const disabledCfg = resolveAlertingConfig(
      makeCfg({ rules: { frequencyEscalation: { tier2: { enabled: false } } } }),
    );
    const entry = makeEvent("frequency_escalation_tier2");
    expect(evaluateFrequencyEscalation({ entry, cfg: disabledCfg, recentContext: [], now: NOW })).toBeNull();
  });

  it("never suppresses tier3 even when tier3 config is false (cannot be disabled)", () => {
    // The resolved config always has tier3=true regardless of input
    const cfg2 = resolveAlertingConfig(
      makeCfg({ rules: { frequencyEscalation: { tier3: { enabled: false } } } }),
    );
    expect(cfg2.rules.frequencyEscalation.tier3).toBe(true);
    const entry = makeEvent("frequency_escalation_tier3");
    expect(evaluateFrequencyEscalation({ entry, cfg: cfg2, recentContext: [], now: NOW })).not.toBeNull();
  });
});

describe("evaluateSemanticCatch", () => {
  const cfg = resolveAlertingConfig(makeCfg());

  it("returns null for non-sanitized_block events", () => {
    const entry = makeEvent("structural_block", { tier: 1 });
    expect(evaluateSemanticCatch({ entry, cfg, recentContext: [], now: NOW })).toBeNull();
  });

  it("returns null for tier 1 blocks (only tier 2 is semantic catch)", () => {
    const entry = makeEvent("sanitized_block", { tier: 1 });
    expect(evaluateSemanticCatch({ entry, cfg, recentContext: [], now: NOW })).toBeNull();
  });

  it("returns alert when tier 2 block has no syntactic_fail for same toolCallId", () => {
    const entry = makeEvent("sanitized_block", { tier: 2, toolCallId: "tc-1" });
    const alert = evaluateSemanticCatch({ entry, cfg, recentContext: [], now: NOW });
    expect(alert?.ruleId).toBe("semanticCatchNoSyntacticFlag");
    expect(alert?.severity).toBe("medium");
  });

  it("returns null when same-toolCallId syntactic_fail is in recentContext", () => {
    const entry = makeEvent("sanitized_block", { tier: 2, toolCallId: "tc-1" });
    const recentContext = [makeEvent("syntactic_fail", { toolCallId: "tc-1" })];
    expect(evaluateSemanticCatch({ entry, cfg, recentContext, now: NOW })).toBeNull();
  });

  it("returns alert when syntactic_fail is for a different toolCallId", () => {
    const entry = makeEvent("sanitized_block", { tier: 2, toolCallId: "tc-1" });
    const recentContext = [makeEvent("syntactic_fail", { toolCallId: "tc-2" })];
    const alert = evaluateSemanticCatch({ entry, cfg, recentContext, now: NOW });
    expect(alert).not.toBeNull();
  });

  it("escalates to high severity after escalateAfter occurrences in 24h", () => {
    const smallCfg = resolveAlertingConfig(
      makeCfg({ rules: { semanticCatchNoSyntacticFlag: { escalateAfter: 2 } } }),
    );
    // Add 2 prior tier-2 sanitized_block events to the index
    for (let i = 0; i < 2; i++) {
      addToIndex(makeEvent("sanitized_block", { tier: 2 }), NOW - 1000 * (i + 1));
    }
    const entry = makeEvent("sanitized_block", { tier: 2, toolCallId: "tc-new" });
    const alert = evaluateSemanticCatch({ entry, cfg: smallCfg, recentContext: [], now: NOW });
    expect(alert?.severity).toBe("high");
  });

  it("returns null when rule is disabled", () => {
    const disabledCfg = resolveAlertingConfig(
      makeCfg({ rules: { semanticCatchNoSyntacticFlag: { enabled: false } } }),
    );
    const entry = makeEvent("sanitized_block", { tier: 2 });
    expect(evaluateSemanticCatch({ entry, cfg: disabledCfg, recentContext: [], now: NOW })).toBeNull();
  });
});

describe("evaluateWriteFailSpike", () => {
  const cfg = resolveAlertingConfig(makeCfg({ rules: { writeFailSpike: { count: 3, windowMinutes: 5 } } }));

  it("returns null for non-write_failed events", () => {
    const entry = makeEvent("sanitized_pass");
    expect(evaluateWriteFailSpike({ entry, cfg, recentContext: [], now: NOW })).toBeNull();
  });

  it("returns null when below threshold", () => {
    for (let i = 0; i < 2; i++) addToIndex(makeEvent("write_failed"), NOW);
    const entry = makeEvent("write_failed");
    expect(evaluateWriteFailSpike({ entry, cfg, recentContext: [], now: NOW })).toBeNull();
  });

  it("returns alert when threshold reached", () => {
    for (let i = 0; i < 3; i++) addToIndex(makeEvent("write_failed"), NOW);
    const entry = makeEvent("write_failed");
    const alert = evaluateWriteFailSpike({ entry, cfg, recentContext: [], now: NOW });
    expect(alert?.ruleId).toBe("writeFailSpike");
    expect(alert?.severity).toBe("medium");
  });
});

// ---------------------------------------------------------------------------
// Webhook delivery
// ---------------------------------------------------------------------------

describe("webhook delivery", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("does not call fetch when no webhook URL configured", async () => {
    const { deliverWebhook } = await import("./webhook.js");
    const cfg = resolveAlertingConfig({});
    await deliverWebhook(
      {
        alertId: "test-id",
        ruleId: "syntacticFailBurst",
        severity: "medium",
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
        timestamp: new Date().toISOString(),
        summary: "test",
        details: { triggeringEvents: [], recentContext: [] },
        metadata: { ruleConfig: {} },
      },
      cfg,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("calls fetch with correct Content-Type header", async () => {
    const { deliverWebhook } = await import("./webhook.js");
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);
    const cfg = resolveAlertingConfig({
      alerting: { channels: { webhook: { url: "https://example.com/alert", secret: null } } },
    });
    await deliverWebhook(
      {
        alertId: "a1",
        ruleId: "writeFailSpike",
        severity: "medium",
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
        timestamp: new Date().toISOString(),
        summary: "test",
        details: { triggeringEvents: [], recentContext: [] },
        metadata: { ruleConfig: {} },
      },
      cfg,
    );
    expect(fetch).toHaveBeenCalledOnce();
    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({ "Content-Type": "application/json" });
  });

  it("includes HMAC-SHA256 signature when secret is configured", async () => {
    const { deliverWebhook } = await import("./webhook.js");
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);
    const secret = "my-webhook-secret";
    const cfg = resolveAlertingConfig({
      alerting: { channels: { webhook: { url: "https://example.com/alert", secret } } },
    });
    const payload = {
      alertId: "a2",
      ruleId: "syntacticFailBurst",
      severity: "high" as const,
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      timestamp: new Date().toISOString(),
      summary: "test",
      details: { triggeringEvents: [], recentContext: [] },
      metadata: { ruleConfig: {} },
    };
    await deliverWebhook(payload, cfg);
    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    const sig = headers["X-OpenClaw-Signature"];
    expect(sig).toMatch(/^sha256=/);
    // Verify signature manually
    const body = JSON.stringify(payload);
    const expected = `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(sig).toBe(expected);
  });

  it("retries on failure and then gives up", async () => {
    const { deliverWebhook } = await import("./webhook.js");
    vi.mocked(fetch).mockResolvedValue({ ok: false } as Response);
    const cfg = resolveAlertingConfig({
      alerting: {
        channels: { webhook: { url: "https://example.com/alert", retries: 2, retryDelayMs: 0 } },
      },
    });
    await deliverWebhook(
      {
        alertId: "a3",
        ruleId: "writeFailSpike",
        severity: "medium",
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
        timestamp: new Date().toISOString(),
        summary: "test",
        details: { triggeringEvents: [], recentContext: [] },
        metadata: { ruleConfig: {} },
      },
      cfg,
    );
    // Initial attempt + 2 retries = 3 calls
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// notifyAlerting integration
// ---------------------------------------------------------------------------

describe("notifyAlerting integration", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });

  it("no-ops when alerting.enabled is false", async () => {
    const cfg = makeCfg({ enabled: false });
    notifyAlerting({
      entry: { event: "syntactic_fail", timestamp: new Date().toISOString() },
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      cfg,
      now: NOW,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("adds events to index on each call", () => {
    const cfg = makeCfg();
    notifyAlerting({
      entry: { event: "syntactic_fail", timestamp: new Date().toISOString() },
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      cfg,
      now: NOW,
    });
    const results = queryIndex({ agentId: AGENT_ID, windowMs: 60_000, now: NOW });
    expect(results).toHaveLength(1);
  });

  it("fires syntacticFailBurst alert when burst threshold reached", async () => {
    // Default count=5; add 5 events to index then notify on the 6th
    const cfg = makeCfg({
      channels: { webhook: { url: "https://example.com/alert" } },
      rules: { syntacticFailBurst: { count: 3, windowMinutes: 10 } },
    });
    for (let i = 0; i < 3; i++) {
      addToIndex(makeEvent("syntactic_fail"), NOW);
    }
    notifyAlerting({
      entry: { event: "syntactic_fail", timestamp: new Date().toISOString() },
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      cfg,
      now: NOW,
    });
    // Give microtask queue a chance to process the fire-and-forget delivery
    await new Promise((r) => setTimeout(r, 0));
    expect(fetch).toHaveBeenCalled();
    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.ruleId).toBe("syntacticFailBurst");
  });

  it("deduplicates: second identical alert within suppression window is not delivered", async () => {
    const cfg = makeCfg({
      channels: { webhook: { url: "https://example.com/alert" } },
      suppression: { windowMinutes: 5 },
      rules: { syntacticFailBurst: { count: 3, windowMinutes: 10 } },
    });
    for (let i = 0; i < 3; i++) addToIndex(makeEvent("syntactic_fail"), NOW);

    // First notification — should deliver
    notifyAlerting({
      entry: { event: "syntactic_fail", timestamp: new Date().toISOString() },
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      cfg,
      now: NOW,
    });
    await new Promise((r) => setTimeout(r, 0));
    const firstCallCount = vi.mocked(fetch).mock.calls.length;

    // Second notification within suppression window — should NOT deliver
    notifyAlerting({
      entry: { event: "syntactic_fail", timestamp: new Date().toISOString() },
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      cfg,
      now: NOW + 1000,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(vi.mocked(fetch).mock.calls.length).toBe(firstCallCount);
  });

  it("rate limiting: suppresses delivery when per-minute limit exceeded", async () => {
    const cfg = makeCfg({
      channels: { webhook: { url: "https://example.com/alert" } },
      rateLimit: { maxPerMinute: 2, maxPerHour: 100 },
      suppression: { windowMinutes: 0 }, // no dedup so rate limit can be hit
      rules: { syntacticFailBurst: { count: 2, windowMinutes: 10 } },
    });
    // Record 2 prior deliveries for this rule (hitting per-minute limit)
    for (let i = 0; i < 2; i++) recordDelivery("syntacticFailBurst", NOW);

    for (let i = 0; i < 2; i++) addToIndex(makeEvent("syntactic_fail"), NOW);
    notifyAlerting({
      entry: { event: "syntactic_fail", timestamp: new Date().toISOString() },
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      cfg,
      now: NOW,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("incrementDailyCount is called when alert fires", async () => {
    const cfg = makeCfg({
      channels: { webhook: { url: "https://example.com/alert" } },
      rules: { syntacticFailBurst: { count: 2, windowMinutes: 10 } },
    });
    for (let i = 0; i < 2; i++) addToIndex(makeEvent("syntactic_fail"), NOW);
    notifyAlerting({
      entry: { event: "syntactic_fail", timestamp: new Date().toISOString() },
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      cfg,
      now: NOW,
    });
    const summary = getDailySummary();
    expect(summary.counts.syntacticFailBurst).toBe(1);
  });
});
