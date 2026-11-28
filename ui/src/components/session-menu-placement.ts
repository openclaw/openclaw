import type { GatewaySessionRow } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import { formatUiError } from "../lib/format-error.ts";
import { showToast } from "../lib/toast.ts";

/** Menu hosts supply their live row owner, never the stale menu projection. */
export async function moveSessionFromMenu(params: {
  context: ApplicationContext;
  row: GatewaySessionRow;
  fallbackAgentId: string;
  currentRow: () => GatewaySessionRow | undefined;
  isCurrent: () => boolean;
  onAdmittedCommand?: (completion: Promise<void>) => void;
  publishError?: (error: unknown) => void;
}): Promise<void> {
  const { context, row } = params;
  const sessions = context.sessions;
  const client = context.gateway.snapshot.client;
  const revision = context.gateway.connectionRevision;
  const hello = context.gateway.snapshot.hello;
  const isCurrent = () =>
    params.isCurrent() &&
    context.sessions === sessions &&
    context.gateway.snapshot.client === client &&
    context.gateway.connectionRevision === revision &&
    context.gateway.snapshot.hello === hello;
  const publishError: (error: unknown) => void =
    params.publishError ??
    ((error) => showToast({ severity: "error", message: formatUiError(error) }));
  try {
    const { changeSessionPlacement } = await import("./session-placement.runtime.ts");
    await changeSessionPlacement({
      client,
      gatewaySnapshot: context.gateway.snapshot,
      currentGatewaySnapshot: () => context.gateway.snapshot,
      requiredProfile: () => context.agents.state.agentsList?.sessionPlacement?.requiredProfile?.id,
      mode: "move",
      pendingKey: null,
      row,
      fallbackAgentId: params.fallbackAgentId,
      currentRow: params.currentRow,
      isCurrent,
      onAdmittedCommand: params.onAdmittedCommand,
      onPendingChange: () => {},
      publishError,
      reconcileMutation: (agentId) => sessions.reconcileMutation(agentId),
    });
  } catch (error) {
    if (isCurrent()) {
      publishError(error);
    }
  }
}
