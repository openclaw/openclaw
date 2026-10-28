import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
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

it.for(["register", "no-route", "resolve"] as const)(
  "sanitizes %s storage failure",
  async (operation, { onTestFinished }) => {
    const dir = useAutoCleanupTempDirTracker(onTestFinished).make("openclaw-approval-failure-");
    const databasePath = path.join(dir, "state.sqlite");
    const manager = new ExecApprovalManager({
      scheduler: createTestGatewayScheduler(),
      approvalKind: "exec",
      persistence: {
        runtimeEpoch: "approval-shared-storage-failure",
        databaseOptions: { path: databasePath },
      },
    });
    const record = manager.create({ command: "echo safe" }, 60_000, "storage-failure");
    const respond = vi.fn();
    const logError = vi.fn();
    const context = {
      getRuntimeConfig: () => ({}),
      broadcast: vi.fn(),
      logGateway: { error: logError },
    } as unknown as GatewayRequestContext;
    const options = { manager, record, respond, context };
    const close = async () => {
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
      closeOpenClawStateDatabaseForTest();
    };
    try {
      const decision =
        operation === "register" ? undefined : (await manager.register(record, 60_000)).decision;
      if (decision) {
        await close();
        fs.rmSync(databasePath, { force: true });
      }
      fs.mkdirSync(databasePath);
      if (operation === "register") {
        expect(
          await registerPendingApprovalRecord({ ...options, timeoutMs: 60_000 }),
        ).toBeUndefined();
      } else if (operation === "no-route") {
        const afterDecision = vi.fn();
        await handlePendingApprovalRequest({
          ...options,
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
          ...options,
          approvalKind: "exec",
          inputId: record.id,
          decision: "deny",
          context: { ...context, broadcastToConnIds: vi.fn() },
          client: null,
        });
      }
      const error = expect.objectContaining({
        code: "UNAVAILABLE",
        message: `approval ${operation === "resolve" ? "resolve" : "request"} unavailable`,
      });
      expect(respond).toHaveBeenCalledWith(false, undefined, error);
      expect(JSON.stringify(respond.mock.calls)).not.toContain(databasePath);
      expect(logError).toHaveBeenCalledTimes(1);
      if (decision) {
        await expect(decision).resolves.toBe("deny");
      }
    } finally {
      await manager.drain();
      await close();
    }
  },
);
