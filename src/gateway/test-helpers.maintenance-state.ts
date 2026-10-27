// Gateway maintenance-state test helper.
// Builds minimal timer/health/chat state for maintenance tests.
import { vi } from "vitest";
import { WorktreeGcProgress } from "../agents/worktrees/gc-progress.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import type { HealthSummary } from "./health/types.js";
import { createChatRunState } from "./server-chat-state.js";
import type { GatewayClient } from "./server-methods/client-types.js";
import * as localWorkspaceGc from "./worker-environments/local-workspace-gc.js";

/** Create a Gateway maintenance-state stub with configurable health/presence versions. */
export function createGatewayMaintenanceStateForTest(params?: {
  healthSummary?: HealthSummary;
  healthVersion?: number;
  presenceVersion?: number;
}) {
  const config: OpenClawConfig = {};
  const chatRunState = createChatRunState();
  const worktreeGcResult = new WorktreeGcProgress().result;
  const worktreeGc = vi.spyOn(managedWorktrees, "gc").mockResolvedValue(worktreeGcResult);
  // Timer fixtures keep both phases of worktree cleanup out of shared-state workers.
  vi.spyOn(localWorkspaceGc, "sweepLocalWorkspaceManifests").mockResolvedValue(undefined);
  return {
    worktreeGc,
    worktreeGcResult,
    scheduler: createTestGatewayScheduler("fake-timers"),
    clients: new Set<GatewayClient>(),
    broadcast: () => {},
    nodeSendToAllSubscribed: () => {},
    getPresenceVersion: () => params?.presenceVersion ?? 1,
    getHealthVersion: () => params?.healthVersion ?? 1,
    refreshGatewayHealthSnapshot: async () =>
      params?.healthSummary ?? ({ ok: true } as HealthSummary),
    logHealth: { info: () => {}, error: () => {} },
    restartRunningChannels: async () => true,
    activeWorkInspectors: {},
    refreshPresence: () => {},
    resetEventLoopHealth: () => {},
    dedupe: new Map(),
    restartRecoveryCandidates: new Map(),
    chatRunState,
    removeChatRun: () => undefined,
    agentRunSeq: new Map(),
    nodeSendToSession: () => {},
    getRuntimeConfig: () => config,
    runDeliveryQueueMediaGc: async () => undefined,
  };
}
