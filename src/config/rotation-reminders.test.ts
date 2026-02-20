import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  type RotationMetadata,
  type RotationStatus,
  parseRotationLabels,
  buildRotationLabels,
  checkRotationStatus,
  checkAllSecrets,
  type SecretWithLabels,
  emitRotationEvents,
  snoozeReminder,
  acknowledgeRotation,
  setRotationInterval,
} from "./rotation-reminders.js";

// ===========================================================================
// Label Parsing
// ===========================================================================

describe("parseRotationLabels", () => {
  it("returns defaults for empty labels", () => {
    const meta = parseRotationLabels({});
    expect(meta.rotationType).toBe("manual");
    expect(meta.rotationIntervalDays).toBe(90);
    expect(meta.lastRotated).toBeUndefined();
    expect(meta.expiresAt).toBeUndefined();
    expect(meta.snoozedUntil).toBeUndefined();
  });

  it("parses all fields from labels", () => {
    const meta = parseRotationLabels({
      "rotation-type": "auto",
      "rotation-interval-days": "30",
      "last-rotated": "2026-01-01t00-00-00z",
      "expires-at": "2026-06-01t00-00-00z",
      "snoozed-until": "2026-02-20t00-00-00z",
    });
    expect(meta.rotationType).toBe("auto");
    expect(meta.rotationIntervalDays).toBe(30);
    expect(meta.lastRotated).toBeDefined();
    expect(meta.expiresAt).toBeDefined();
    expect(meta.snoozedUntil).toBeDefined();
  });

  it("handles invalid interval gracefully (defaults to 90)", () => {
    const meta = parseRotationLabels({ "rotation-interval-days": "abc" });
    expect(meta.rotationIntervalDays).toBe(90);
  });

  it("handles invalid rotation type gracefully (defaults to manual)", () => {
    const meta = parseRotationLabels({ "rotation-type": "invalid" });
    expect(meta.rotationType).toBe("manual");
  });
});

// ===========================================================================
// Label Building
// ===========================================================================

describe("buildRotationLabels", () => {
  it("builds labels from metadata", () => {
    const labels = buildRotationLabels({
      rotationType: "manual",
      rotationIntervalDays: 90,
      lastRotated: new Date("2026-01-01T00:00:00Z"),
    });
    expect(labels["rotation-type"]).toBe("manual");
    expect(labels["rotation-interval-days"]).toBe("90");
    expect(labels["last-rotated"]).toBe("2026-01-01t00-00-00-000z");
  });

  it("omits undefined optional fields", () => {
    const labels = buildRotationLabels({
      rotationType: "manual",
      rotationIntervalDays: 90,
    });
    expect(labels["last-rotated"]).toBeUndefined();
    expect(labels["expires-at"]).toBeUndefined();
    expect(labels["snoozed-until"]).toBeUndefined();
  });

  it("includes expiresAt and snoozedUntil when set", () => {
    const labels = buildRotationLabels({
      rotationType: "manual",
      rotationIntervalDays: 30,
      expiresAt: new Date("2026-06-01T00:00:00Z"),
      snoozedUntil: new Date("2026-02-20T00:00:00Z"),
    });
    expect(labels["expires-at"]).toBeDefined();
    expect(labels["snoozed-until"]).toBeDefined();
  });
});

// ===========================================================================
// Rotation Status Check
// ===========================================================================

describe("checkRotationStatus", () => {
  const now = new Date("2026-02-15T12:00:00Z");

  it("returns ok when recently rotated", () => {
    const status = checkRotationStatus(
      {
        rotationType: "manual",
        rotationIntervalDays: 90,
        lastRotated: new Date("2026-02-01T00:00:00Z"),
      },
      now,
    );
    expect(status.state).toBe("ok");
  });

  it("returns review-due when interval exceeded", () => {
    const status = checkRotationStatus(
      {
        rotationType: "manual",
        rotationIntervalDays: 30,
        lastRotated: new Date("2025-12-01T00:00:00Z"),
      },
      now,
    );
    expect(status.state).toBe("review-due");
    expect(status.daysOverdue).toBeGreaterThan(0);
  });

  it("returns review-due when lastRotated is undefined", () => {
    const status = checkRotationStatus(
      {
        rotationType: "manual",
        rotationIntervalDays: 90,
      },
      now,
    );
    expect(status.state).toBe("review-due");
  });

  it("returns expiring-soon when expiresAt is near", () => {
    const status = checkRotationStatus(
      {
        rotationType: "manual",
        rotationIntervalDays: 90,
        lastRotated: new Date("2026-02-01T00:00:00Z"),
        expiresAt: new Date("2026-02-20T00:00:00Z"),
      },
      now,
      14, // threshold days
    );
    expect(status.state).toBe("expiring-soon");
    expect(status.daysUntilExpiry).toBeLessThanOrEqual(14);
  });

  it("returns expired when expiresAt is past", () => {
    const status = checkRotationStatus(
      {
        rotationType: "manual",
        rotationIntervalDays: 90,
        lastRotated: new Date("2026-01-01T00:00:00Z"),
        expiresAt: new Date("2026-02-10T00:00:00Z"),
      },
      now,
    );
    expect(status.state).toBe("expired");
  });

  it("returns ok when snoozed and within snooze window", () => {
    const status = checkRotationStatus(
      {
        rotationType: "manual",
        rotationIntervalDays: 30,
        lastRotated: new Date("2025-12-01T00:00:00Z"),
        snoozedUntil: new Date("2026-03-01T00:00:00Z"),
      },
      now,
    );
    expect(status.state).toBe("snoozed");
  });

  it("skips auto rotation type", () => {
    const status = checkRotationStatus(
      {
        rotationType: "auto",
        rotationIntervalDays: 90,
      },
      now,
    );
    expect(status.state).toBe("ok");
  });
});

// ===========================================================================
// Check All Secrets
// ===========================================================================

describe("checkAllSecrets", () => {
  it("returns status for each secret", () => {
    const secrets: SecretWithLabels[] = [
      { name: "secret-a", labels: { "rotation-type": "manual", "rotation-interval-days": "30", "last-rotated": "2025-12-01t00-00-00z" } },
      { name: "secret-b", labels: { "rotation-type": "manual", "last-rotated": "2026-02-10t00-00-00z" } },
    ];
    const results = checkAllSecrets(secrets, new Date("2026-02-15T12:00:00Z"));
    expect(results).toHaveLength(2);
    expect(results[0].name).toBe("secret-a");
    expect(results[0].status.state).toBe("review-due");
    expect(results[1].name).toBe("secret-b");
    expect(results[1].status.state).toBe("ok");
  });

  it("returns empty array for no secrets", () => {
    expect(checkAllSecrets([], new Date())).toEqual([]);
  });
});

// ===========================================================================
// Event Emission
// ===========================================================================

describe("emitRotationEvents", () => {
  it("emits secret:review-due for overdue secrets", () => {
    const events: Array<{ event: string; secret: string }> = [];
    const listener = (event: string, secret: string) => events.push({ event, secret });

    const results = [
      { name: "overdue-key", metadata: {} as RotationMetadata, status: { state: "review-due" as const, daysOverdue: 10 } },
    ];
    emitRotationEvents(results, listener);
    expect(events).toContainEqual({ event: "secret:review-due", secret: "overdue-key" });
  });

  it("emits secret:expiring-soon for expiring secrets", () => {
    const events: Array<{ event: string; secret: string }> = [];
    const listener = (event: string, secret: string) => events.push({ event, secret });

    const results = [
      { name: "expiring-key", metadata: {} as RotationMetadata, status: { state: "expiring-soon" as const, daysUntilExpiry: 5 } },
    ];
    emitRotationEvents(results, listener);
    expect(events).toContainEqual({ event: "secret:expiring-soon", secret: "expiring-key" });
  });

  it("does not emit for ok secrets", () => {
    const events: Array<{ event: string; secret: string }> = [];
    const listener = (event: string, secret: string) => events.push({ event, secret });

    const results = [
      { name: "ok-key", metadata: {} as RotationMetadata, status: { state: "ok" as const } },
    ];
    emitRotationEvents(results, listener);
    expect(events).toHaveLength(0);
  });
});

// ===========================================================================
// Snooze, Ack, Set Interval
// ===========================================================================

describe("snoozeReminder", () => {
  it("sets snoozedUntil to N days from now", () => {
    const meta: RotationMetadata = { rotationType: "manual", rotationIntervalDays: 90 };
    const result = snoozeReminder(meta, 7, new Date("2026-02-15T12:00:00Z"));
    expect(result.snoozedUntil).toBeDefined();
    const expected = new Date("2026-02-22T12:00:00Z");
    expect(result.snoozedUntil!.getTime()).toBe(expected.getTime());
  });
});

describe("acknowledgeRotation", () => {
  it("sets lastRotated to now", () => {
    const meta: RotationMetadata = { rotationType: "manual", rotationIntervalDays: 90 };
    const now = new Date("2026-02-15T12:00:00Z");
    const result = acknowledgeRotation(meta, now);
    expect(result.lastRotated!.getTime()).toBe(now.getTime());
    expect(result.snoozedUntil).toBeUndefined();
  });
});

describe("setRotationInterval", () => {
  it("updates interval days", () => {
    const meta: RotationMetadata = { rotationType: "manual", rotationIntervalDays: 90 };
    const result = setRotationInterval(meta, 30);
    expect(result.rotationIntervalDays).toBe(30);
  });
});
