import type { SessionsDispatchResult } from "../../../packages/gateway-protocol/src/schema/session-placement.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readGatewayRunId } from "../subagents/spawn/subagent-spawn-gateway.js";
import type { InProcessGatewayCaller } from "./in-process-gateway.js";
import { runWithScopedSessionAccess } from "./scoped-session-access.js";

/** Adapts a visible spawn to the existing placement and native launch owners. */
export async function startVisibleCloudSession(params: {
  cfg: OpenClawConfig;
  key: string;
  sessionId: string;
  profileId: string;
  os?: string;
  machineClass?: string;
  task: string;
  runTimeoutSeconds: number;
  callGateway: InProcessGatewayCaller;
  launchAgent: (
    request: Record<string, unknown>,
    assertAdmissionCurrent: () => void,
  ) => Promise<unknown>;
  terminateRun: (runId: string) => Promise<void>;
  assertActive: () => void;
  signal?: AbortSignal;
}) {
  let taskSubmitted = false;
  let acceptedRunId: string | undefined;
  const taskRunId = "visible-cloud-spawn:" + params.sessionId;
  let placement: SessionsDispatchResult["placement"] | undefined;
  try {
    return await runWithScopedSessionAccess({
      cfg: params.cfg,
      targetSessionKey: params.key,
      expectedSessionId: params.sessionId,
      signal: params.signal,
      run: async () => {
        params.assertActive();
        const dispatched = await params.callGateway<SessionsDispatchResult>(
          "sessions.dispatch",
          {
            key: params.key,
            profileId: params.profileId,
            ...(params.os ? { os: params.os } : {}),
            ...(params.machineClass ? { machineClass: params.machineClass } : {}),
          },
          {
            signal: params.signal,
            timeoutMs: null,
            sessionMutationCommitGuard: params.assertActive,
          },
        );
        params.assertActive();
        if (
          dispatched.key !== params.key ||
          dispatched.sessionId !== params.sessionId ||
          dispatched.placement.state !== "active"
        ) {
          throw new Error("Cloud dispatch did not confirm the created session as active");
        }
        placement = dispatched.placement;
        // The initiating admission is excluded from its own placement barrier;
        // external replacement/reclaim cannot race this child's first task.
        taskSubmitted = true;
        let admissionOpen = true;
        try {
          const response = await params.launchAgent(
            {
              sessionKey: params.key,
              sessionId: params.sessionId,
              expectedExistingSessionId: params.sessionId,
              message: params.task,
              deliver: false,
              sessionEffects: "visible",
              timeout: params.runTimeoutSeconds,
              idempotencyKey: taskRunId,
            },
            () => {
              if (!admissionOpen) {
                throw new Error("Cloud task admission has closed");
              }
              params.assertActive();
            },
          );
          // Native launch preserves acceptance instead of dropping the receipt
          // when parent authority closes immediately after the child is admitted.
          acceptedRunId = readGatewayRunId(response);
        } finally {
          admissionOpen = false;
        }
        params.assertActive();
        if (!acceptedRunId) {
          throw new Error("Cloud initial task did not return a run id");
        }
        return { runStarted: true as const, runId: acceptedRunId, placement };
      },
    });
  } catch (error) {
    // Admission is closed before exact-run cleanup, so even a timed-out launch
    // cannot commit later after an authoritative abort miss. Preserve the
    // session/lease for placement recovery; never leave an unregistered run active.
    if (taskSubmitted) {
      await params.terminateRun(acceptedRunId ?? taskRunId);
    }
    return {
      runStarted: false as const,
      ...(acceptedRunId ? { runId: acceptedRunId } : {}),
      runError: error instanceof Error ? error.message : String(error),
      ...(placement ? { placement } : {}),
      initialTaskStatus: taskSubmitted ? ("unknown" as const) : ("not-sent" as const),
    };
  }
}
