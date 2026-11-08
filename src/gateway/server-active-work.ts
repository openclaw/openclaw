// Adapts controller-owned sources and terminal state to the shared activity inspector.
import { getActiveCronJobCount } from "../cron/active-jobs.js";
import { getSuspensionVisibleCronTaskRunCount } from "../cron/service/active-run-cancellation.js";
import type { GatewayActiveWorkInspectors } from "../infra/gateway-active-work.js";
import {
  getRpcSourceIdentity,
  isRpcSourceQueued,
  listRpcSourceEntries,
  type RpcSourceRef,
} from "../sessions/session-controller.rpc-sources.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";
import { captureGatewayScopeMatcher } from "./session-runtime-scope.js";

const isActiveChatRun = (entry: RpcSourceRef) =>
  !entry.input.abortSignal.aborted &&
  !entry.input.retirementRequested &&
  entry.input.phase !== "consumed" &&
  !isRpcSourceQueued(entry);

const hasTerminalPersistence = (entry: RpcSourceRef) =>
  entry.adapter.controlUiVisible !== false &&
  entry.adapter.projectSessionTerminalPersisted !== true &&
  (entry.adapter.projectSessionTerminalPending === true ||
    entry.adapter.projectSessionTerminalPersistence !== undefined);

export function createGatewayServerActiveWorkInspectors(
  context: Pick<GatewayRequestContext, "terminalSessions" | "resolveGatewayContext"> & {
    cron: Pick<GatewayRequestContext["cron"], "getSuspensionBlockerCount">;
  },
): Partial<GatewayActiveWorkInspectors> {
  const matchesGateway = captureGatewayScopeMatcher(context.resolveGatewayContext);
  const entries = () => listRpcSourceEntries().filter(([, entry]) => matchesGateway(entry.input));
  const holders = (matches: (entry: RpcSourceRef) => boolean) =>
    entries()
      .filter(([, entry]) => matches(entry))
      .map(([runId, entry]) => `run=${runId} session=${getRpcSourceIdentity(entry).sessionKey}`);
  return {
    getCronRuns: () =>
      Math.max(getActiveCronJobCount(), getSuspensionVisibleCronTaskRunCount()) +
      (context.cron.getSuspensionBlockerCount?.() ?? 0),
    getChatRuns: () => entries().filter(([, entry]) => isActiveChatRun(entry)).length,
    getChatRunHolders: () => holders(isActiveChatRun),
    getQueuedTurns: () => entries().filter(([, entry]) => isRpcSourceQueued(entry)).length,
    getTerminalPersistence: () =>
      entries().filter(([, entry]) => hasTerminalPersistence(entry)).length,
    getTerminalPersistenceHolders: () => holders(hasTerminalPersistence),
    getTerminalSessions: () => context.terminalSessions?.size ?? 0,
  };
}
