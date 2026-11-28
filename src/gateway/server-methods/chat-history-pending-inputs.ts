import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import type { PendingInputHistoryTerminalCheck } from "../../config/sessions/session-pending-input-history.types.js";
import { readSessionPendingInputReceiptsInWorker } from "../../config/sessions/session-pending-input-receipts.js";
import { isTerminalSessionStatus } from "../../config/sessions/types.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import type { GatewaySessionRow } from "../session-utils.types.js";
import type { ChatHistoryMethod } from "./chat-history-recovery.js";
import { captureQueuedChatInputRunIds, readChatPendingInputs } from "./chat-pending-inputs.js";
import type { GatewayClient } from "./types.js";

/** Exact receipts and the display page belong to the current physical session, not archived history. */
export async function readChatHistoryPendingInputs(
  scope: { agentId: string; sessionKey: string; storePath: string; sessionId?: string },
  options: Pick<
    Parameters<typeof readChatPendingInputs>[1],
    "before" | "limit" | "maxChars" | "cronStorePath" | "physicalPaths" | "resolveGatewayContext"
  > & {
    isCurrentSession: boolean;
    inputRunIds?: readonly string[];
    messageId?: string;
    client: GatewayClient | null;
    method: ChatHistoryMethod;
  },
) {
  const { sessionId } = scope;
  const current = sessionId && options.isCurrentSession ? { ...scope, sessionId } : undefined;
  const runtimeScope = {
    physicalPaths: options.physicalPaths,
    resolveGatewayContext: options.resolveGatewayContext,
  };
  const queuedRunIds = current && captureQueuedChatInputRunIds({ ...current, ...runtimeScope });
  let matchesTerminal: PendingInputHistoryTerminalCheck | undefined;
  const pendingInputs = current
    ? await measureDiagnosticsTimelineSpan(`gateway.${options.method}.pending_inputs`, () =>
        readChatPendingInputs(current, {
          ...runtimeScope,
          before: options.before,
          audience: { profileId: options.client?.authenticatedUserProfile?.profileId ?? "" },
          limit: options.limit,
          maxChars: options.maxChars,
          cronStorePath: options.cronStorePath,
          queuedRunIds,
          includeQueueObservation: hasGatewayClientCap(
            options.client?.connect.caps,
            GATEWAY_CLIENT_CAPS.CHAT_HISTORY_QUEUE_OBSERVATION,
          ),
          observeTerminalCheck: (check) => {
            matchesTerminal = check;
          },
        }),
      )
    : { items: [], total: 0 };
  const inputReceipts = options.inputRunIds
    ? !options.messageId && current
      ? (
          await readSessionPendingInputReceiptsInWorker(current, { runIds: options.inputRunIds })
        ).map((receipt) =>
          receipt.state === "pending" && !receipt.cancelled && queuedRunIds?.has(receipt.runId)
            ? { runId: receipt.runId, state: receipt.state, queued: true as const }
            : receipt,
        )
      : []
    : undefined;
  const inputConsumptions = inputReceipts?.flatMap((receipt) =>
    receipt.state === "consumed"
      ? [{ runId: receipt.runId, consumedByEventId: receipt.consumedByEventId }]
      : [],
  );
  return {
    pendingInputs,
    inputReceipts,
    inputConsumptions,
    hasCompatibleQueue: (sessionInfo: GatewaySessionRow | undefined) =>
      !current ||
      sessionInfo?.hasActiveRun !== false ||
      !sessionInfo.lastRunId ||
      !isTerminalSessionStatus(sessionInfo.status) ||
      matchesTerminal?.(sessionInfo.lastRunId, sessionInfo.status) === true,
  };
}
