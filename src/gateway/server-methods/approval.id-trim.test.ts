// Padded approval ids: exact-first lookup, trimmed fallback only on a clean miss.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import { insertOperatorApproval } from "../operator-approval-store.js";
import {
  cleanupApprovalHandlerFixtures,
  createClient,
  createDatabaseOptions,
  createManagers,
  invoke,
  registerExec,
} from "./approval.handlers.test-support.js";
import { createApprovalHandlers } from "./approval.js";
import { corruptDurableApprovalPresentation } from "./approval.test-support.js";

function createHandlers(
  managers: ReturnType<typeof createManagers>,
  databaseOptions: OpenClawStateDatabaseOptions,
) {
  return createApprovalHandlers({
    execApprovalManager: managers.exec,
    pluginApprovalManager: managers.plugin,
    databaseOptions,
  });
}

describe("approval id whitespace recovery", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupApprovalHandlerFixtures();
  });

  it("prefers an exact whitespace-bearing approval id over the trimmed spelling", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const nowMs = Date.now();
    await insertOperatorApproval({
      approval: {
        id: " approval-edge ",
        kind: "exec",
        presentation: {
          kind: "exec",
          commandText: "exact padded key",
          allowedDecisions: ["allow-once", "deny"],
        },
        runtimeEpoch: "approval-handler-test",
        createdAtMs: nowMs,
        expiresAtMs: nowMs + 60_000,
        reviewerDeviceIds: ["reviewer"],
      },
      databaseOptions,
    });
    await insertOperatorApproval({
      approval: {
        id: "approval-edge",
        kind: "exec",
        presentation: {
          kind: "exec",
          commandText: "trimmed fallback key",
          allowedDecisions: ["allow-once", "deny"],
        },
        runtimeEpoch: "approval-handler-test",
        createdAtMs: nowMs + 1,
        expiresAtMs: nowMs + 60_000,
        reviewerDeviceIds: ["reviewer"],
      },
      databaseOptions,
    });
    const handlers = createHandlers(managers, databaseOptions);

    const got = await invoke({
      handlers,
      method: "approval.get",
      body: { id: " approval-edge " },
      client: createClient({ deviceId: "reviewer" }),
    });
    expect(got.ok).toBe(true);
    expect(got.result).toMatchObject({
      approval: { id: " approval-edge ", status: "pending" },
    });
    expect(
      (got.result as { approval?: { presentation?: { commandText?: string } } }).approval,
    ).toMatchObject({ presentation: { commandText: "exact padded key" } });
  });

  it("does not fall back to the trimmed approval when the exact padded id is unauthorized", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const nowMs = Date.now();
    await insertOperatorApproval({
      approval: {
        id: " approval-edge ",
        kind: "exec",
        presentation: {
          kind: "exec",
          commandText: "exact padded key",
          allowedDecisions: ["allow-once", "deny"],
        },
        runtimeEpoch: "approval-handler-test",
        createdAtMs: nowMs,
        expiresAtMs: nowMs + 60_000,
        reviewerDeviceIds: ["other-reviewer"],
      },
      databaseOptions,
    });
    await insertOperatorApproval({
      approval: {
        id: "approval-edge",
        kind: "exec",
        presentation: {
          kind: "exec",
          commandText: "trimmed fallback key",
          allowedDecisions: ["allow-once", "deny"],
        },
        runtimeEpoch: "approval-handler-test",
        createdAtMs: nowMs + 1,
        expiresAtMs: nowMs + 60_000,
        reviewerDeviceIds: ["reviewer"],
      },
      databaseOptions,
    });
    const handlers = createHandlers(managers, databaseOptions);

    const got = await invoke({
      handlers,
      method: "approval.get",
      body: { id: " approval-edge " },
      client: createClient({ deviceId: "reviewer" }),
    });
    expect(got.ok).toBe(false);
    expect(got.error).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("does not fall back to the trimmed approval when the exact padded id is corrupt", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const nowMs = Date.now();
    await insertOperatorApproval({
      approval: {
        id: " approval-edge ",
        kind: "exec",
        presentation: {
          kind: "exec",
          commandText: "exact padded key",
          allowedDecisions: ["allow-once", "deny"],
        },
        runtimeEpoch: "approval-handler-test",
        createdAtMs: nowMs,
        expiresAtMs: nowMs + 60_000,
        reviewerDeviceIds: ["reviewer"],
      },
      databaseOptions,
    });
    corruptDurableApprovalPresentation(databaseOptions, " approval-edge ");
    const trimmed = await registerExec(managers.exec, { id: "approval-edge" });
    const handlers = createHandlers(managers, databaseOptions);
    const client = createClient({ deviceId: "reviewer" });

    const got = await invoke({
      handlers,
      method: "approval.get",
      body: { id: " approval-edge " },
      client,
    });
    expect(got.ok).toBe(false);
    expect(got.error).toMatchObject({ code: "INVALID_REQUEST" });

    const resolved = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id: " approval-edge ", kind: "exec", decision: "deny" },
      client,
    });
    expect(resolved.ok).toBe(false);
    expect(resolved.error).toMatchObject({ code: "INVALID_REQUEST" });
    const neighborLive = managers.exec.getLiveSnapshot(trimmed.record.id);
    expect(neighborLive).toMatchObject({ id: trimmed.record.id });
    expect(neighborLive).not.toHaveProperty("terminalReason");
    let neighborSettled = false;
    void trimmed.decision.then(() => {
      neighborSettled = true;
    });
    await Promise.resolve();
    expect(neighborSettled).toBe(false);
    const neighbor = await invoke({
      handlers,
      method: "approval.get",
      body: { id: trimmed.record.id },
      client,
    });
    expect(neighbor.ok).toBe(true);
    expect(neighbor.result).toMatchObject({
      approval: { id: trimmed.record.id, status: "pending" },
    });
  });
});
