// Octopus Orchestrator — ApprovalService tests (M5-03)
//
// Covers: request creates pending, approve resolves, reject resolves,
// listPending, event emission, double-resolve throws.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalService, resetApprovalIdCounter } from "./approvals.ts";
import { EventLogService } from "./event-log.ts";

// ──────────────────────────────────────────────────────────────────────────
// Per-test temp event log harness
// ──────────────────────────────────────────────────────────────────────────

let tempDir: string;
let eventLog: EventLogService;
let service: ApprovalService;
let eventsPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "octo-approvals-test-"));
  eventsPath = path.join(tempDir, "events.jsonl");
  eventLog = new EventLogService({ path: eventsPath });
  service = new ApprovalService(eventLog);
  resetApprovalIdCounter();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function readEvents(): Array<Record<string, unknown>> {
  try {
    const content = readFileSync(eventsPath, "utf8").trim();
    if (!content) {
      return [];
    }
    return content.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe("ApprovalService", () => {
  it("request() creates a pending approval", async () => {
    const req = await service.request(
      "arm.terminate",
      { armId: "arm-1", missionId: "m-1" },
      "operator-a",
    );

    expect(req.status).toBe("pending");
    expect(req.action).toBe("arm.terminate");
    expect(req.armId).toBe("arm-1");
    expect(req.missionId).toBe("m-1");
    expect(req.requesterId).toBe("operator-a");
    expect(req.id).toMatch(/^apr_/);
    expect(req.createdAt).toBeGreaterThan(0);
    expect(req.resolvedBy).toBeUndefined();
    expect(req.resolvedAt).toBeUndefined();
  });

  it("approve() resolves a pending request", async () => {
    const req = await service.request("mission.abort", { missionId: "m-2" }, "op-1");
    const resolved = await service.approve(req.id, "op-admin");

    expect(resolved.status).toBe("approved");
    expect(resolved.resolvedBy).toBe("op-admin");
    expect(resolved.resolvedAt).toBeGreaterThan(0);
  });

  it("reject() resolves a pending request", async () => {
    const req = await service.request("arm.terminate", { armId: "arm-3" }, "op-1");
    const resolved = await service.reject(req.id, "op-admin", "too risky");

    expect(resolved.status).toBe("rejected");
    expect(resolved.resolvedBy).toBe("op-admin");
    expect(resolved.resolvedAt).toBeGreaterThan(0);
  });

  it("listPending() returns only pending requests", async () => {
    const r1 = await service.request("action-a", {}, "op-1");
    const r2 = await service.request("action-b", {}, "op-2");
    const r3 = await service.request("action-c", {}, "op-3");

    await service.approve(r2.id, "admin");

    const pending = service.listPending();
    const pendingIds = pending.map((r) => r.id);

    expect(pendingIds).toContain(r1.id);
    expect(pendingIds).not.toContain(r2.id);
    expect(pendingIds).toContain(r3.id);
    expect(pending).toHaveLength(2);
  });

  it("emits operator.approved / operator.rejected events to event log", async () => {
    const r1 = await service.request("arm.terminate", { armId: "arm-1" }, "op-1");
    const r2 = await service.request("mission.abort", { missionId: "m-1" }, "op-2");

    await service.approve(r1.id, "admin-a");
    await service.reject(r2.id, "admin-b", "denied");

    const events = readEvents();
    expect(events).toHaveLength(2);

    const approveEvt = events[0];
    expect(approveEvt["event_type"]).toBe("operator.approved");
    expect(approveEvt["entity_type"]).toBe("operator");
    expect(approveEvt["entity_id"]).toBe("admin-a");
    expect((approveEvt["payload"] as Record<string, unknown>)["requestId"]).toBe(r1.id);
    expect((approveEvt["payload"] as Record<string, unknown>)["armId"]).toBe("arm-1");

    const rejectEvt = events[1];
    expect(rejectEvt["event_type"]).toBe("operator.rejected");
    expect(rejectEvt["entity_type"]).toBe("operator");
    expect(rejectEvt["entity_id"]).toBe("admin-b");
    expect((rejectEvt["payload"] as Record<string, unknown>)["reason"]).toBe("denied");
    expect((rejectEvt["payload"] as Record<string, unknown>)["missionId"]).toBe("m-1");
  });

  it("throws on double-resolve (approve then approve)", async () => {
    const req = await service.request("action-x", {}, "op-1");
    await service.approve(req.id, "admin");

    await expect(service.approve(req.id, "admin")).rejects.toThrow(/already approved/);
  });

  it("throws on double-resolve (reject then approve)", async () => {
    const req = await service.request("action-y", {}, "op-1");
    await service.reject(req.id, "admin", "no");

    await expect(service.approve(req.id, "admin")).rejects.toThrow(/already rejected/);
  });

  it("throws on unknown request ID", async () => {
    await expect(service.approve("apr_999999", "admin")).rejects.toThrow(/unknown request/);
    await expect(service.reject("apr_999999", "admin", "no")).rejects.toThrow(/unknown request/);
  });

  it("getRequest() returns null for unknown ID", () => {
    expect(service.getRequest("apr_000000")).toBeNull();
  });
});
