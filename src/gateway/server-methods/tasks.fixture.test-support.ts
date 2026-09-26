import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  type HeartbeatWakeRequest,
  requestHeartbeat,
  setHeartbeatWakeHandler,
} from "../../infra/heartbeat-wake.js";
import { resetSystemEventsForTest } from "../../infra/system-events.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { runTaskHandler } from "./tasks.test-helpers.js";

const cancelSessionMock = vi.hoisted(() => vi.fn());
vi.mock("../../tasks/task-registry-control.runtime.js", () => ({
  cancelBackgroundExecSession: () => false,
  cancelActiveCronTaskRun: () => false,
  getAcpSessionManager: () => ({ cancelSession: cancelSessionMock }),
  killSubagentRunAdmin: async () => {
    throw new Error("Unexpected subagent cancellation in task handler fixture");
  },
}));

export const mainSessionTaskScope = {
  requesterSessionKey: "agent:main:main",
  ownerKey: "agent:main:main",
  scopeKind: "session",
} as const;

export function useTaskGatewayFixture() {
  const stateDirEnvSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let heartbeatWakeRequests: HeartbeatWakeRequest[] = [];
  let disposeHeartbeatWakeHandler: (() => void) | undefined;
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      try {
        // Drain older targeted wakes before their fixture state retires.
        const reason = `gateway-tasks-test-flush-${randomUUID()}`;
        requestHeartbeat({ source: "other", intent: "immediate", reason, coalesceMs: 0 });
        await vi.waitFor(() => {
          expect(heartbeatWakeRequests.some((request) => request.reason === reason)).toBe(true);
        });
      } finally {
        disposeHeartbeatWakeHandler?.();
        disposeHeartbeatWakeHandler = undefined;
        await closeOpenClawAgentDatabasesAsync();
        closeOpenClawAgentDatabasesForTest();
        resetSystemEventsForTest();
        resetTaskRegistryForTests();
        await closeOpenClawStateDatabaseAsync();
        closeOpenClawStateDatabaseForTest();
        stateDirEnvSnapshot.restore();
        cleanup();
      }
    }),
  );

  beforeEach(async () => {
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-gateway-tasks-"));
    resetTaskRegistryForTests();
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: mainSessionTaskScope.requesterSessionKey },
      { sessionId: "session-main", updatedAt: 1 },
    );
    heartbeatWakeRequests = [];
    disposeHeartbeatWakeHandler = setHeartbeatWakeHandler(async (request) => {
      heartbeatWakeRequests.push(request);
      return { status: "ran", durationMs: 0 };
    });
    cancelSessionMock.mockReset();
  });

  return { cancelSessionMock };
}

export async function getTaskPayload(taskId: string) {
  const { calls, payload } = await runTaskHandler("tasks.get", { taskId });
  expect(calls[0]?.[0]).toBe(true);
  expect(payload?.task?.id).toBe(taskId);
  return { calls, payload };
}
