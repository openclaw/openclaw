// Octopus Orchestrator — ComplianceReporter tests (M5-05)

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ComplianceReporter, type PolicyCheckFn } from "./compliance-report.ts";
import { EventLogService, type AppendInput } from "./event-log.ts";

function makeArmCreated(armId: string, payload: Record<string, unknown> = {}): AppendInput {
  return {
    schema_version: 1,
    entity_type: "arm",
    entity_id: armId,
    event_type: "arm.created",
    actor: "head",
    payload,
  };
}

function makeNonArmEvent(entityId: string): AppendInput {
  return {
    schema_version: 1,
    entity_type: "arm",
    entity_id: entityId,
    event_type: "arm.active",
    actor: "head",
    payload: {},
  };
}

describe("ComplianceReporter", () => {
  let tmpDir: string;
  let logPath: string;
  let eventLog: EventLogService;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "octo-compliance-"));
    logPath = path.join(tmpDir, "octo", "events.jsonl");
    eventLog = new EventLogService({ path: logPath });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports 2 violations when 10 arms and 2 violate policy", async () => {
    const violatingIds = new Set(["arm-03", "arm-07"]);
    for (let i = 1; i <= 10; i++) {
      const id = `arm-${String(i).padStart(2, "0")}`;
      await eventLog.append(makeArmCreated(id, { tier: violatingIds.has(id) ? "banned" : "ok" }));
    }

    const policyCheck: PolicyCheckFn = (spec) => {
      if (spec["tier"] === "banned") {
        return { allowed: false, reason: "tier not permitted" };
      }
      return { allowed: true };
    };

    const reporter = new ComplianceReporter(eventLog);
    const report = await reporter.generate(policyCheck);

    expect(report.total_arms).toBe(10);
    expect(report.compliant).toBe(8);
    expect(report.violations).toHaveLength(2);
    expect(report.violations.map((v) => v.arm_id).toSorted()).toEqual(["arm-03", "arm-07"]);
  });

  it("reports 0 violations when all arms are compliant", async () => {
    for (let i = 1; i <= 5; i++) {
      await eventLog.append(makeArmCreated(`arm-${i}`, { tier: "ok" }));
    }

    const policyCheck: PolicyCheckFn = () => ({ allowed: true });
    const reporter = new ComplianceReporter(eventLog);
    const report = await reporter.generate(policyCheck);

    expect(report.total_arms).toBe(5);
    expect(report.compliant).toBe(5);
    expect(report.violations).toHaveLength(0);
  });

  it("returns 0 total for an empty log", async () => {
    const policyCheck: PolicyCheckFn = () => ({ allowed: true });
    const reporter = new ComplianceReporter(eventLog);
    const report = await reporter.generate(policyCheck);

    expect(report.total_arms).toBe(0);
    expect(report.compliant).toBe(0);
    expect(report.violations).toHaveLength(0);
    expect(typeof report.generated_at).toBe("number");
  });

  it("violation details include arm_id, event_type, reason, and ts", async () => {
    await eventLog.append(makeArmCreated("arm-bad", { sandbox: false }));
    // Also append a non-arm.created event to verify it is ignored.
    await eventLog.append(makeNonArmEvent("arm-bad"));

    const policyCheck: PolicyCheckFn = (spec) => {
      if (spec["sandbox"] === false) {
        return { allowed: false, reason: "sandbox required" };
      }
      return { allowed: true };
    };

    const reporter = new ComplianceReporter(eventLog);
    const report = await reporter.generate(policyCheck);

    expect(report.total_arms).toBe(1);
    expect(report.violations).toHaveLength(1);
    const v = report.violations[0];
    expect(v.arm_id).toBe("arm-bad");
    expect(v.event_type).toBe("arm.created");
    expect(v.reason).toBe("sandbox required");
    expect(typeof v.ts).toBe("string");
    expect(v.ts.length).toBeGreaterThan(0);
  });
});
