import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { handlePendingApprovalRequest, registerPendingApprovalRecord } from "./approval-shared.js";
import { handleApprovalResolve } from "./approval.test-support.js";
import type { GatewayRequestContext } from "./types.js";

vi.mock("../../infra/approval-turn-source.js", () => ({ hasApprovalTurnSourceRoute: () => false }));

describe("approval storage failures", () => {
  let databasePath: string;
  let manager: ExecApprovalManager;
  let record: ReturnType<ExecApprovalManager["create"]>;
  const respond = vi.fn();
  const logError = vi.fn();

  beforeEach(({ onTestFinished }) => {
    vi.clearAllMocks();
    const tempDir = useAutoCleanupTempDirTracker(onTestFinished).make("openclaw-approval-failure-");
    databasePath = path.join(tempDir, "state.sqlite");
    manager = new ExecApprovalManager({
      scheduler: createTestGatewayScheduler(),
      approvalKind: "exec",
      persistence: {
        runtimeEpoch: "approval-shared-storage-failure",
        databaseOptions: { path: databasePath },
      },
    });
    record = manager.create({ command: "echo safe" }, 60_000, "storage-failure");
  });

  afterEach(async () => {
    await manager.drain();
    await closeOpenClawStateDatabaseByPathAsync(databasePath);
    closeOpenClawStateDatabaseForTest();
  });

  async function makeStoreUnavailable() {
    await closeOpenClawStateDatabaseByPathAsync(databasePath);
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(databasePath, { force: true });
    fs.mkdirSync(databasePath);
  }

  function expectStorageFailure(operation: "request" | "resolve") {
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: `approval ${operation} unavailable`,
      }),
    );
    expect(JSON.stringify(respond.mock.calls)).not.toContain(databasePath);
    expect(logError).toHaveBeenCalledTimes(1);
  }

  it("sanitizes durable registration failures while retaining server diagnostics", async () => {
    fs.mkdirSync(databasePath);
    expect(
      await registerPendingApprovalRecord({
        manager,
        record,
        timeoutMs: 60_000,
        respond,
        context: { logGateway: { error: logError } } as unknown as GatewayRequestContext,
      }),
    ).toBeUndefined();
    expectStorageFailure("request");
  });

  it("sanitizes a no-route storage failure while failing the waiter closed", async () => {
    const decisionPromise = (await manager.register(record, 60_000)).decision;
    const afterDecision = vi.fn();
    await makeStoreUnavailable();
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

    expectStorageFailure("request");
    expect(respond).toHaveBeenCalledOnce();
    expect(afterDecision).not.toHaveBeenCalled();
    await expect(decisionPromise).resolves.toBe("deny");
  });

  it("sanitizes durable resolve failures while failing the waiter closed", async () => {
    const decisionPromise = (await manager.register(record, 60_000)).decision;
    await makeStoreUnavailable();
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

    expectStorageFailure("resolve");
    await expect(decisionPromise).resolves.toBe("deny");
  });
});
