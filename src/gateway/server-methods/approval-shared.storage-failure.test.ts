import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { registerPendingApprovalRecord } from "./approval-registration.js";
import { buildRequestedApprovalEvent, handlePendingApprovalRequest } from "./approval-shared.js";
import { handleApprovalResolve } from "./approval.test-support.js";
import type { GatewayRequestContext } from "./types.js";

vi.mock("../../infra/approval-turn-source.js", () => ({ hasApprovalTurnSourceRoute: () => false }));

let databasePath: string;
let manager: ExecApprovalManager;
let record: ReturnType<ExecApprovalManager["create"]>;
const respond = vi.fn();
const logError = vi.fn();
const context = {
  getRuntimeConfig: () => ({}),
  broadcast: vi.fn(),
  logGateway: { error: logError },
} as unknown as GatewayRequestContext;

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
  const error = expect.objectContaining({
    code: "UNAVAILABLE",
    message: `approval ${operation} unavailable`,
  });
  expect(respond).toHaveBeenCalledWith(false, undefined, error);
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
      context: { logGateway: context.logGateway } as unknown as GatewayRequestContext,
    }),
  ).toBeUndefined();
  expectStorageFailure("request");
});

it.each(["no-route", "resolve"] as const)(
  "sanitizes %s storage failure and denies the waiter",
  async (operation) => {
    const decisionPromise = (await manager.register(record, 60_000)).decision;
    const afterDecision = vi.fn();
    await makeStoreUnavailable();
    if (operation === "no-route") {
      await handlePendingApprovalRequest({
        manager,
        record,
        respond,
        afterDecision,
        context: { ...context, hasExecApprovalClients: () => false },
        requestEventName: "exec.approval.requested",
        requestEvent: buildRequestedApprovalEvent(record),
        twoPhase: true,
        deliverRequest: () => false,
      });
      await manager.drain();
      expect(respond).toHaveBeenCalledOnce();
      expect(afterDecision).not.toHaveBeenCalled();
    } else {
      await handleApprovalResolve({
        approvalKind: "exec",
        manager,
        inputId: record.id,
        decision: "deny",
        respond,
        context: { ...context, broadcastToConnIds: vi.fn() },
        client: null,
      });
    }
    expectStorageFailure(operation === "no-route" ? "request" : "resolve");
    await expect(decisionPromise).resolves.toBe("deny");
  },
);
