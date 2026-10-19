import type { SessionEntry } from "../../../config/sessions/types.js";
import type { FreshChildSession } from "../../../gateway/in-process-session-run.js";
import { MAX_RECOVERY_SOURCE_BYTES } from "../../../gateway/operator-run-recovery-source.codec.js";
import { captureQueuedOperatorRecoverySource } from "../../../gateway/operator-run-recovery-source.js";
import { stringifyRouteThreadId } from "../../../plugin-sdk/channel-route.js";
import type { DeliveryContext } from "../../../utils/delivery-context.types.js";
import type { AdmittedRunOperatorAuthority } from "../../admitted-run-context.js";
import type { BootstrapContextMode } from "../../bootstrap-files.js";
import type { RequesterOrigin } from "../../requester-origin.js";
import { normalizeSpawnedRunMetadata } from "../../spawned-context.js";
import type { SubagentLaunchAuthorization } from "./subagent-launch-authorization.js";
import { resolveSubagentAgentGatewayTimeoutMs } from "./subagent-spawn-gateway.js";
import { AGENT_LANE_SUBAGENT } from "./subagent-spawn.runtime.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";
import type { SubagentCompletionMode } from "./subagent-system-prompt.js";

export function buildSubagentLaunchRequest(params: {
  completionMode: SubagentCompletionMode;
  spawnMode: SpawnSubagentMode;
  message: string;
  spawnedByKey: string;
  toolSpawnMetadata: Parameters<typeof normalizeSpawnedRunMetadata>[0];
  spawnedWorkspaceDir?: string;
  childSessionKey: string;
  childSession: {
    entry?: Pick<SessionEntry, "sessionId" | "lifecycleRevision">;
    freshChild?: FreshChildSession;
  };
  childSessionOrigin?: DeliveryContext;
  childIdem: string;
  outputSchema?: Record<string, unknown>;
  childSystemPrompt: string;
  runTimeoutSeconds: number;
  lightContext: boolean;
  requesterOrigin?: DeliveryContext;
  currentMessagingTarget?: string;
  currentChannelId?: string;
  currentMessageId?: string | number;
  launchAuthorization?: SubagentLaunchAuthorization;
  requesterFacts?: RequesterOrigin;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  swarmSchedulerGroupKey?: string;
  swarmMaxConcurrent: number;
}) {
  const bootstrapContextMode: BootstrapContextMode | undefined = params.lightContext
    ? "lightweight"
    : undefined;
  const collect = params.completionMode === "collector";
  const spawnedMetadata = normalizeSpawnedRunMetadata({
    spawnedBy: params.spawnedByKey,
    ...params.toolSpawnMetadata,
    workspaceDir: params.spawnedWorkspaceDir,
  });
  const {
    spawnedBy: _spawnedBy,
    workspaceDir: _workspaceDir,
    ...publicSpawnedMetadata
  } = spawnedMetadata;
  const request: Record<string, unknown> = {
    message: params.message,
    sessionKey: params.childSessionKey,
    ...(collect
      ? {}
      : {
          channel: params.childSessionOrigin?.channel,
          to: params.childSessionOrigin?.to,
          accountId: params.childSessionOrigin?.accountId,
          threadId:
            params.childSessionOrigin?.threadId != null
              ? stringifyRouteThreadId(params.childSessionOrigin.threadId)
              : undefined,
        }),
    idempotencyKey: params.childIdem,
    deliver: params.completionMode === "thread-direct",
    lane: AGENT_LANE_SUBAGENT,
    disableMessageTool: true,
    swarmCollector: collect,
    swarmOutputSchema: params.outputSchema,
    cleanupBundleMcpOnRunEnd: params.spawnMode !== "session",
    extraSystemPrompt: params.childSystemPrompt,
    timeout: params.runTimeoutSeconds,
    // Creation owns label and thinking; delayed launches preserve later session edits.
    ...(bootstrapContextMode
      ? {
          bootstrapContextMode,
          bootstrapContextRunKind: "default" as const,
        }
      : {}),
    ...publicSpawnedMetadata,
  };
  const childLaunch = {
    request,
    ...(params.launchAuthorization ? { authorization: params.launchAuthorization } : {}),
    timeoutMs: resolveSubagentAgentGatewayTimeoutMs(params.runTimeoutSeconds),
  };
  const operatorRecovery = collect
    ? captureQueuedOperatorRecoverySource(params.operatorAuthority)
    : undefined;
  const queuedLaunch =
    collect && params.swarmSchedulerGroupKey
      ? {
          ...childLaunch,
          // Preserve the current in-memory launch even when restart cannot retain
          // its exact requester; recovery will report that explicit missing basis.
          requesterRecovery: {
            facts:
              params.requesterFacts &&
              Buffer.byteLength(JSON.stringify(params.requesterFacts), "utf8") >
                MAX_RECOVERY_SOURCE_BYTES
                ? null
                : params.requesterFacts,
            operator: operatorRecovery,
          },
          schedulerGroupKey: params.swarmSchedulerGroupKey,
          maxConcurrent: params.swarmMaxConcurrent,
        }
      : undefined;
  const childEntry = params.childSession.entry;
  return {
    childLaunch,
    queuedLaunch,
    // Private admission facts stay out of the persisted restart descriptor.
    preparedLaunch:
      childEntry?.sessionId && childEntry.lifecycleRevision
        ? {
            sessionKey: params.childSessionKey,
            sessionId: childEntry.sessionId,
            lifecycleRevision: childEntry.lifecycleRevision,
            runId: params.childIdem,
            freshChild: params.childSession.freshChild,
          }
        : undefined,
    progressOrigin: {
      channel: params.requesterOrigin?.channel,
      accountId: params.requesterOrigin?.accountId,
      to: params.currentMessagingTarget ?? params.requesterOrigin?.to,
      threadId: params.requesterOrigin?.threadId,
      channelId: params.currentChannelId,
      messageId: params.currentMessageId,
    },
    spawnedMetadata,
  };
}
