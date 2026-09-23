import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseByPathAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { handlePendingApprovalRequest, registerPendingApprovalRecord } from "./approval-shared.js";
import { handleApprovalResolve } from "./approval.test-support.js";
import type { GatewayRequestContext } from "./types.js";

vi.mock("../../infra/approval-turn-source.js", () => ({ hasApprovalTurnSourceRoute: () => false }));

describe("approval storage failures", () => {
  it("sanitizes durable registration failures while retaining server diagnostics", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-register-failure-"));
    const databasePath = path.join(tempDir, "state.sqlite");
    fs.mkdirSync(databasePath);
    const manager = new ExecApprovalManager({
      approvalKind: "exec",
      persistence: {
        runtimeEpoch: "approval-shared-register-failure",
        databaseOptions: { path: databasePath },
      },
    });
    const record = manager.create({ command: "echo safe" }, 60_000, "registration-failure");
    const respond = vi.fn();
    const logError = vi.fn();

    try {
      expect(
        await registerPendingApprovalRecord({
          manager,
          record,
          timeoutMs: 60_000,
          respond,
          context: { logGateway: { error: logError } } as unknown as GatewayRequestContext,
        }),
      ).toBeUndefined();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE", message: "approval request unavailable" }),
      );
      expect(JSON.stringify(respond.mock.calls)).not.toContain(databasePath);
      expect(logError).toHaveBeenCalledTimes(1);
    } finally {
      await manager.drain();
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
      closeOpenClawStateDatabaseForTest();
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("sanitizes a no-route storage failure while failing the waiter closed", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-route-failure-"));
    const databasePath = path.join(tempDir, "state.sqlite");
    const manager = new ExecApprovalManager({
      approvalKind: "exec",
      persistence: {
        runtimeEpoch: "approval-shared-route-failure",
        databaseOptions: { path: databasePath },
      },
    });
    const record = manager.create({ command: "echo safe" }, 60_000, "route-failure");
    const decisionPromise = (await manager.register(record, 60_000)).decision;
    const afterDecision = vi.fn();
    await closeOpenClawStateDatabaseByPathAsync(databasePath);
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(databasePath, { force: true });
    fs.mkdirSync(databasePath);
    const respond = vi.fn();
    const logError = vi.fn();

    try {
      await handlePendingApprovalRequest({
        manager,
        record,
        respond,
        context: {
          getRuntimeConfig: () => ({}),
          broadcast: vi.fn(),
          hasExecApprovalClients: () => false,
          logGateway: { error: logError },
        } as unknown as GatewayRequestContext,
        requestEventName: "exec.approval.requested",
        requestEvent: {
          id: record.id,
          request: record.request,
          createdAtMs: record.createdAtMs,
          expiresAtMs: record.expiresAtMs,
        },
        twoPhase: true,
        deliverRequest: () => false,
        afterDecision,
      });
      await manager.drain();

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE", message: "approval request unavailable" }),
      );
      expect(respond).toHaveBeenCalledOnce();
      expect(afterDecision).not.toHaveBeenCalled();
      expect(JSON.stringify(respond.mock.calls)).not.toContain(databasePath);
      expect(logError).toHaveBeenCalledTimes(1);
      await expect(decisionPromise).resolves.toBe("deny");
    } finally {
      await manager.drain();
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
      closeOpenClawStateDatabaseForTest();
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("sanitizes durable resolve failures while failing the waiter closed", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-resolve-failure-"));
    const databasePath = path.join(tempDir, "state.sqlite");
    const manager = new ExecApprovalManager({
      approvalKind: "exec",
      persistence: {
        runtimeEpoch: "approval-shared-resolve-failure",
        databaseOptions: { path: databasePath },
      },
    });
    const record = manager.create({ command: "echo safe" }, 60_000, "resolve-failure");
    const decisionPromise = (await manager.register(record, 60_000)).decision;
    await closeOpenClawStateDatabaseByPathAsync(databasePath);
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(databasePath, { force: true });
    fs.mkdirSync(databasePath);
    const respond = vi.fn();
    const logError = vi.fn();

    try {
      await handleApprovalResolve({
        approvalKind: "exec",
        manager,
        inputId: record.id,
        decision: "deny",
        respond,
        context: {
          getRuntimeConfig: () => ({}),
          broadcast: vi.fn(),
          broadcastToConnIds: vi.fn(),
          logGateway: { error: logError },
        } as unknown as GatewayRequestContext,
        client: null,
      });

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE", message: "approval resolve unavailable" }),
      );
      expect(JSON.stringify(respond.mock.calls)).not.toContain(databasePath);
      expect(logError).toHaveBeenCalledTimes(1);
      await expect(decisionPromise).resolves.toBe("deny");
    } finally {
      await manager.drain();
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
      closeOpenClawStateDatabaseForTest();
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });
});
