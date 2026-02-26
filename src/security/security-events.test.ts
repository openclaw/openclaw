/**
 * Security Events System Tests
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  SecurityEventsManager,
  resetSecurityEventsManager,
  type SecurityEvent,
  type SecurityEventEmitParams,
} from "./security-events.js";

describe("SecurityEventsManager", () => {
  let tempDir: string;
  let manager: SecurityEventsManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "security-events-test-"));
    manager = new SecurityEventsManager({
      store: path.join(tempDir, "events.jsonl"),
      maxBytes: 10_000,
      keepLines: 100,
      inMemoryLimit: 50,
    });
  });

  afterEach(() => {
    resetSecurityEventsManager();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("emit", () => {
    it("should emit an event and return it", () => {
      const params: SecurityEventEmitParams = {
        type: "skill_scan_failed",
        severity: "warn",
        source: "test",
        message: "Test event",
      };

      const event = manager.emit(params);

      expect(event.id).toBeDefined();
      expect(event.type).toBe("skill_scan_failed");
      expect(event.severity).toBe("warn");
      expect(event.source).toBe("test");
      expect(event.message).toBe("Test event");
      expect(event.ts).toBeGreaterThan(0);
      expect(event.fingerprint).toBeDefined();
      expect(event.occurrences).toBe(1);
    });

    it("should persist event to file", () => {
      const params: SecurityEventEmitParams = {
        type: "container_escape_attempt",
        severity: "critical",
        source: "container-monitor",
        message: "Escape attempt detected",
      };

      manager.emit(params);
      // persistEvent is deferred via setImmediate (P-H3); flush before reading.
      manager.flushWrites();

      const storePath = path.join(tempDir, "events.jsonl");
      expect(fs.existsSync(storePath)).toBe(true);

      const content = fs.readFileSync(storePath, "utf8");
      const lines = content.split("\n").filter((l) => l.trim());
      expect(lines).toHaveLength(1);

      const persisted = JSON.parse(lines[0]) as SecurityEvent;
      expect(persisted.type).toBe("container_escape_attempt");
    });

    it("should add event to ring buffer", () => {
      manager.emit({
        type: "injection_detected",
        severity: "warn",
        source: "external-content",
        message: "Injection attempt",
      });

      const recent = manager.getRecent();
      expect(recent).toHaveLength(1);
      expect(recent[0].type).toBe("injection_detected");
    });

    it("should include optional fields", () => {
      const event = manager.emit({
        type: "tool_abuse_detected",
        severity: "warn",
        source: "tool-monitor",
        message: "Suspicious tool usage",
        details: { tool: "bash", count: 100 },
        remediation: "Review tool usage patterns",
        sessionKey: "test-session",
        agentId: "agent-1",
        correlationId: "corr-123",
      });

      expect(event.details).toEqual({ tool: "bash", count: 100 });
      expect(event.remediation).toBe("Review tool usage patterns");
      expect(event.sessionKey).toBe("test-session");
      expect(event.agentId).toBe("agent-1");
      expect(event.correlationId).toBe("corr-123");
    });
  });

  describe("dedup", () => {
    it("should deduplicate identical events within window", () => {
      const params: SecurityEventEmitParams = {
        type: "auth_rate_limited",
        severity: "warn",
        source: "gateway",
        message: "Rate limit exceeded",
      };

      const event1 = manager.emit(params);
      const event2 = manager.emit(params);
      const event3 = manager.emit(params);

      // All should return the same event (by ID)
      expect(event1.id).toBe(event2.id);
      expect(event2.id).toBe(event3.id);

      // Occurrences should increment
      expect(event3.occurrences).toBe(3);

      // Only one event in ring buffer
      expect(manager.getRecent()).toHaveLength(1);
    });

    it("should not deduplicate events with different messages", () => {
      const event1 = manager.emit({
        type: "auth_rate_limited",
        severity: "warn",
        source: "gateway",
        message: "Rate limit for user A",
      });

      const event2 = manager.emit({
        type: "auth_rate_limited",
        severity: "warn",
        source: "gateway",
        message: "Rate limit for user B",
      });

      expect(event1.id).not.toBe(event2.id);
      expect(manager.getRecent()).toHaveLength(2);
    });

    it("should allow custom fingerprint for dedup", () => {
      const event1 = manager.emit({
        type: "session_anomaly",
        severity: "info",
        source: "session-monitor",
        message: "Anomaly detected at time 1",
        fingerprint: "custom-fp-123",
      });

      const event2 = manager.emit({
        type: "session_anomaly",
        severity: "info",
        source: "session-monitor",
        message: "Anomaly detected at time 2",
        fingerprint: "custom-fp-123",
      });

      expect(event1.id).toBe(event2.id);
      expect(event2.occurrences).toBe(2);
    });

    it("should clear dedup map", () => {
      const params: SecurityEventEmitParams = {
        type: "monitor_failure",
        severity: "warn",
        source: "monitor",
        message: "Monitor failed",
      };

      manager.emit(params);
      manager.clearDedup();
      const event2 = manager.emit(params);

      // Should be a new event
      expect(event2.occurrences).toBe(1);
    });
  });

  describe("query", () => {
    beforeEach(() => {
      // Emit various events
      manager.emit({
        type: "skill_scan_failed",
        severity: "warn",
        source: "skill-scanner",
        message: "Scan failed 1",
      });
      manager.emit({
        type: "container_escape_attempt",
        severity: "critical",
        source: "container-monitor",
        message: "Escape attempt",
      });
      manager.emit({
        type: "injection_detected",
        severity: "warn",
        source: "external-content",
        message: "Injection 1",
        sessionKey: "session-a",
        agentId: "agent-1",
      });
      manager.emit({
        type: "injection_detected",
        severity: "warn",
        source: "external-content",
        message: "Injection 2",
        sessionKey: "session-b",
        agentId: "agent-2",
      });
    });

    it("should query all events without filters", () => {
      const events = manager.query();
      expect(events).toHaveLength(4);
    });

    it("should filter by type", () => {
      const events = manager.query({ type: "injection_detected" });
      expect(events).toHaveLength(2);
      expect(events.every((e) => e.type === "injection_detected")).toBe(true);
    });

    it("should filter by multiple types", () => {
      const events = manager.query({
        type: ["skill_scan_failed", "container_escape_attempt"],
      });
      expect(events).toHaveLength(2);
    });

    it("should filter by severity", () => {
      const events = manager.query({ severity: "critical" });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("container_escape_attempt");
    });

    it("should filter by source", () => {
      const events = manager.query({ source: "external-content" });
      expect(events).toHaveLength(2);
    });

    it("should filter by sessionKey", () => {
      const events = manager.query({ sessionKey: "session-a" });
      expect(events).toHaveLength(1);
      expect(events[0].message).toBe("Injection 1");
    });

    it("should filter by agentId", () => {
      const events = manager.query({ agentId: "agent-2" });
      expect(events).toHaveLength(1);
      expect(events[0].message).toBe("Injection 2");
    });

    it("should apply limit", () => {
      const events = manager.query({ limit: 2 });
      expect(events).toHaveLength(2);
    });

    it("should apply offset", () => {
      const events = manager.query({ offset: 2 });
      expect(events).toHaveLength(2);
    });

    it("should filter by time range", () => {
      const now = Date.now();
      const events = manager.query({ since: now - 1000, until: now + 1000 });
      expect(events).toHaveLength(4);

      const futureEvents = manager.query({ since: now + 10000 });
      expect(futureEvents).toHaveLength(0);
    });

    it("since:0 returns all events (zero is a valid epoch timestamp, not falsy skip) (BP-6)", () => {
      // Before the fix, `if (filters.since)` was falsy for 0 and the filter was skipped.
      // With `!== undefined`, since:0 is treated as epoch-0 and all events pass.
      const events = manager.query({ since: 0 });
      expect(events).toHaveLength(4);
    });

    it("until:0 returns no events when all events have ts > 0 (BP-6)", () => {
      // until:0 should filter to events at or before epoch-0, returning nothing for modern events.
      const events = manager.query({ until: 0 });
      expect(events).toHaveLength(0);
    });
  });

  describe("subscribe", () => {
    it("should notify subscribers of new events", () => {
      const events: SecurityEvent[] = [];
      const unsubscribe = manager.subscribe((event) => {
        events.push(event);
      });

      manager.emit({
        type: "env_credential_exposed",
        severity: "warn",
        source: "env-scanner",
        message: "Credential found",
      });

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("env_credential_exposed");

      unsubscribe();

      manager.emit({
        type: "env_credential_exposed",
        severity: "warn",
        source: "env-scanner",
        message: "Another credential",
      });

      // Should not receive after unsubscribe
      expect(events).toHaveLength(1);
    });

    it("should support multiple subscribers", () => {
      const events1: SecurityEvent[] = [];
      const events2: SecurityEvent[] = [];

      manager.subscribe((e) => {
        events1.push(e);
      });
      manager.subscribe((e) => {
        events2.push(e);
      });

      manager.emit({
        type: "credential_rotation_due",
        severity: "info",
        source: "credential-vault",
        message: "Rotation needed",
      });

      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(1);
    });
  });

  describe("subscribeAlerts", () => {
    it("should only notify for alert-level events", () => {
      const alerts: SecurityEvent[] = [];
      manager.subscribeAlerts((e) => {
        alerts.push(e);
      });

      // Emit info event (below alert threshold)
      manager.emit({
        type: "credential_rotation_due",
        severity: "info",
        source: "vault",
        message: "Rotation reminder",
      });

      // Emit warn event (below critical threshold by default)
      manager.emit({
        type: "skill_scan_failed",
        severity: "warn",
        source: "scanner",
        message: "Scan failed",
      });

      // Emit critical event (should alert)
      manager.emit({
        type: "container_escape_attempt",
        severity: "critical",
        source: "container",
        message: "Escape!",
      });

      // Only critical by default
      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe("critical");
    });
  });

  describe("getStats", () => {
    it("should return event statistics", () => {
      manager.emit({
        type: "skill_scan_failed",
        severity: "warn",
        source: "scanner",
        message: "Failed 1",
      });
      manager.emit({
        type: "container_escape_attempt",
        severity: "critical",
        source: "container",
        message: "Escape",
      });
      manager.emit({
        type: "credential_rotation_due",
        severity: "info",
        source: "vault",
        message: "Rotate",
      });

      const stats = manager.getStats();

      expect(stats.total).toBe(3);
      expect(stats.bySeverity.info).toBe(1);
      expect(stats.bySeverity.warn).toBe(1);
      expect(stats.bySeverity.critical).toBe(1);
      expect(stats.byType.skill_scan_failed).toBe(1);
      expect(stats.byType.container_escape_attempt).toBe(1);
      expect(stats.byType.credential_rotation_due).toBe(1);
    });
  });

  describe("ring buffer limits", () => {
    it("should respect in-memory limit", () => {
      const smallManager = new SecurityEventsManager({
        store: path.join(tempDir, "small.jsonl"),
        inMemoryLimit: 5,
      });

      for (let i = 0; i < 10; i++) {
        smallManager.emit({
          type: "injection_detected",
          severity: "warn",
          source: "test",
          message: `Event ${i}`,
        });
        smallManager.clearDedup(); // Prevent dedup
      }

      const recent = smallManager.getRecent();
      expect(recent).toHaveLength(5);
      expect(recent[0].message).toBe("Event 5");
      expect(recent[4].message).toBe("Event 9");
    });
  });

  describe("file rotation", () => {
    it("should rotate file when size limit exceeded", () => {
      const smallManager = new SecurityEventsManager({
        store: path.join(tempDir, "rotate.jsonl"),
        maxBytes: 500, // Very small for testing
        keepLines: 10,
        inMemoryLimit: 100,
      });

      // Emit many events to exceed size
      for (let i = 0; i < 20; i++) {
        smallManager.emit({
          type: "injection_detected",
          severity: "warn",
          source: "test",
          message: `Event with some extra text to increase size ${i}`,
        });
        smallManager.clearDedup();
      }

      // persistEvent is deferred via setImmediate (P-H3); flush before checking.
      smallManager.flushWrites();

      // Check rotated file exists
      const rotatedPath = path.join(tempDir, "rotate.1.jsonl");
      expect(fs.existsSync(rotatedPath)).toBe(true);
    });
  });

  describe("details sanitization", () => {
    it("should truncate oversized details", () => {
      const largeDetails: Record<string, string> = {};
      for (let i = 0; i < 1000; i++) {
        largeDetails[`key${i}`] = "a".repeat(100);
      }

      const event = manager.emit({
        type: "tool_abuse_detected",
        severity: "warn",
        source: "test",
        message: "Large details",
        details: largeDetails,
      });

      // Details should be truncated
      const detailsJson = JSON.stringify(event.details);
      expect(detailsJson.length).toBeLessThan(15000);
      expect(event.details._truncated).toBe(true);
    });
  });

  describe("credential redaction (G8)", () => {
    const TOKEN = "sk-testkey123456789abcdef"; // matches sk-[A-Za-z0-9_-]{8,}

    it("redacts token from event message before persisting", () => {
      const event = manager.emit({
        type: "injection_detected",
        severity: "warn",
        source: "test",
        message: `Suspicious call with key=${TOKEN}`,
      });

      expect(event.message).not.toContain(TOKEN);
    });

    it("redacts token from details string values", () => {
      const event = manager.emit({
        type: "tool_abuse_detected",
        severity: "warn",
        source: "test",
        message: "Tool abuse",
        details: { apiKey: TOKEN, count: 5 },
      });

      expect(event.details.apiKey).not.toBe(TOKEN);
      // Non-string details are unchanged
      expect(event.details.count).toBe(5);
    });

    it("redacts token from remediation field", () => {
      const event = manager.emit({
        type: "auth_rate_limited",
        severity: "warn",
        source: "test",
        message: "Rate limited",
        remediation: `Revoke token ${TOKEN} immediately`,
      });

      expect(event.remediation).not.toContain(TOKEN);
    });

    it("redacted event is persisted without the token", () => {
      manager.emit({
        type: "injection_detected",
        severity: "warn",
        source: "test",
        message: `Key leak: ${TOKEN}`,
      });

      // persistEvent is deferred via setImmediate (P-H3); flush before reading.
      manager.flushWrites();

      const storePath = path.join(tempDir, "events.jsonl");
      const content = fs.readFileSync(storePath, "utf8");
      expect(content).not.toContain(TOKEN);
    });

    it("leaves benign messages unmodified", () => {
      const message = "Normal event with no credentials";
      const event = manager.emit({
        type: "skill_scan_failed",
        severity: "info",
        source: "test",
        message,
      });

      expect(event.message).toBe(message);
    });
  });

  describe("init", () => {
    it("should load events from file on init", async () => {
      const storePath = path.join(tempDir, "init-test.jsonl");

      // Pre-populate file
      const existingEvent: SecurityEvent = {
        id: "existing-123",
        ts: Date.now() - 1000,
        type: "skill_scan_failed",
        severity: "warn",
        source: "pre-existing",
        message: "Old event",
        details: {},
        fingerprint: "fp123",
        occurrences: 1,
        firstOccurrence: Date.now() - 1000,
      };
      fs.writeFileSync(storePath, JSON.stringify(existingEvent) + "\n");

      const initManager = new SecurityEventsManager({
        store: storePath,
        inMemoryLimit: 50,
      });

      await initManager.init();

      const recent = initManager.getRecent();
      expect(recent).toHaveLength(1);
      expect(recent[0].id).toBe("existing-123");
    });
  });

  describe("deferred persistEvent via setImmediate (P-H3)", () => {
    it("event is in ring buffer immediately after emit, before flush", () => {
      manager.emit({
        type: "injection_detected",
        severity: "warn",
        source: "test",
        message: "deferred-write-test",
      });

      // Ring buffer is synchronous — event is available immediately.
      const recent = manager.getRecent();
      expect(recent).toHaveLength(1);
      expect(recent[0].message).toBe("deferred-write-test");

      // File must NOT exist yet (write is pending in setImmediate queue).
      const storePath = path.join(tempDir, "events.jsonl");
      expect(fs.existsSync(storePath)).toBe(false);
    });

    it("file is written after flushWrites()", () => {
      manager.emit({
        type: "tool_abuse_detected",
        severity: "warn",
        source: "test",
        message: "flush-test",
      });

      // File should not exist before flush.
      const storePath = path.join(tempDir, "events.jsonl");
      expect(fs.existsSync(storePath)).toBe(false);

      manager.flushWrites();

      expect(fs.existsSync(storePath)).toBe(true);
      const lines = fs
        .readFileSync(storePath, "utf8")
        .split("\n")
        .filter((l) => l.trim());
      expect(lines).toHaveLength(1);
      const persisted = JSON.parse(lines[0]) as SecurityEvent;
      expect(persisted.message).toBe("flush-test");
    });

    it("multiple events emitted in same tick are batched into a single flush", () => {
      manager.emit({
        type: "injection_detected",
        severity: "warn",
        source: "test",
        message: "batch-1",
      });
      manager.clearDedup();
      manager.emit({
        type: "injection_detected",
        severity: "warn",
        source: "test",
        message: "batch-2",
      });
      manager.clearDedup();
      manager.emit({
        type: "injection_detected",
        severity: "warn",
        source: "test",
        message: "batch-3",
      });

      // Flush once — all three events should land in the file.
      manager.flushWrites();

      const storePath = path.join(tempDir, "events.jsonl");
      const lines = fs
        .readFileSync(storePath, "utf8")
        .split("\n")
        .filter((l) => l.trim());
      expect(lines).toHaveLength(3);
    });

    it("flushWrites() is idempotent — calling it twice does not duplicate entries", () => {
      manager.emit({
        type: "auth_rate_limited",
        severity: "warn",
        source: "test",
        message: "idempotent-flush",
      });

      manager.flushWrites();
      manager.flushWrites(); // Second call should be a no-op.

      const storePath = path.join(tempDir, "events.jsonl");
      const lines = fs
        .readFileSync(storePath, "utf8")
        .split("\n")
        .filter((l) => l.trim());
      expect(lines).toHaveLength(1);
    });
  });

  describe("dedupeMap auto-prune and FIFO eviction (TC-4)", () => {
    it("pruneDedup removes expired entries and returns their count", async () => {
      // Use a 1ms dedup window so entries expire almost immediately
      const shortManager = new SecurityEventsManager(
        { store: path.join(tempDir, "prune-test.jsonl") },
        { dedupeWindow: 1 },
      );

      const base: SecurityEventEmitParams = {
        type: "injection_detected",
        severity: "warn",
        source: "prune-test",
        message: "",
      };

      // Emit 5 unique events — each gets its own dedup entry
      for (let i = 0; i < 5; i++) {
        shortManager.emit({ ...base, message: `unique-prune-${i}` });
      }

      // Wait for the 1ms dedup window to expire
      await new Promise((resolve) => setTimeout(resolve, 10));

      // pruneDedup should remove all 5 expired entries and return 5
      const pruned = shortManager.pruneDedup();
      expect(pruned).toBe(5);
    });

    it("pruneDedup keeps live entries and returns 0", () => {
      const liveManager = new SecurityEventsManager(
        { store: path.join(tempDir, "live-prune.jsonl") },
        { dedupeWindow: 60_000 }, // 1-minute window — nothing will expire
      );

      liveManager.emit({
        type: "tool_abuse_detected",
        severity: "warn",
        source: "prune-test",
        message: "live-entry",
      });

      // All entries are still within their window — nothing pruned
      const pruned = liveManager.pruneDedup();
      expect(pruned).toBe(0);
    });

    it("after pruning expired entries, same fingerprint creates a new event", async () => {
      // 1ms window — entries expire almost immediately
      const shortManager = new SecurityEventsManager(
        { store: path.join(tempDir, "fifo-prune.jsonl") },
        { dedupeWindow: 1 },
      );

      const params: SecurityEventEmitParams = {
        type: "auth_rate_limited",
        severity: "warn",
        source: "prune-test",
        message: "repro-event",
      };

      const first = shortManager.emit(params);

      // Let the 1ms dedup window expire and prune
      await new Promise((resolve) => setTimeout(resolve, 10));
      const pruned = shortManager.pruneDedup();
      expect(pruned).toBeGreaterThan(0);

      // After the entry was pruned, the same params should yield a brand-new event
      const fresh = shortManager.emit(params);
      expect(fresh.id).not.toBe(first.id);
    });
  });
});
