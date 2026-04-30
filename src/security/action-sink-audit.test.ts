import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendActionSinkAuditRecord,
  auditPolicyDecision,
  createActionSinkAuditRecord,
  readActionSinkAuditRecords,
} from "./action-sink-audit.js";
import { policyResult } from "./action-sink-policy.js";

const request = {
  policyVersion: "v1",
  actionType: "message_send" as const,
  targetResource: "telegram",
  payloadSummary: { token: "secret" },
  correlationId: "c1",
};
const result = policyResult({
  policyId: "p",
  decision: "block",
  reasonCode: "external_write",
  reason: "no",
  mode: "enforce",
  correlationId: "c1",
});

describe("action sink audit", () => {
  it("validates required fields and bounded summaries", () => {
    const record = createActionSinkAuditRecord({
      request,
      result,
      now: new Date("2026-04-26T00:00:00Z"),
    });
    expect(record).toMatchObject({
      policyVersion: "v1",
      policyId: "p",
      decision: "block",
      actionType: "message_send",
      correlationId: "c1",
    });
    expect(JSON.stringify(record)).not.toContain("secret");
  });

  it("atomically appends concurrent ndjson records", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "action-sink-audit-"));
    const file = path.join(dir, "audit.ndjson");
    const record = createActionSinkAuditRecord({ request, result });
    await Promise.all(Array.from({ length: 10 }, () => appendActionSinkAuditRecord(file, record)));
    expect(await readActionSinkAuditRecords(file)).toHaveLength(10);
  });

  it("fails closed for high risk audit append failures", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "action-sink-audit-"));
    await expect(
      auditPolicyDecision({ auditPath: dir, request, result, highRisk: true }),
    ).rejects.toThrow(/failed closed/);
  });
});
