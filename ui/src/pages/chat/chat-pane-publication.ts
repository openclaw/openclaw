import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { isCloudWorkerPlacementState } from "../../components/session-row-badges.ts";
import { canCallGatewayMethod, isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { GitHubPublicationOwner } from "../../lib/sessions/github-publication-owner.ts";
import type { createSessionGitHubPublication } from "../../lib/sessions/session-github-publication.ts";
import type { GitHubPublicationBinding } from "../../lib/sessions/session-types.ts";

/** Attach the pane to session-owned publication state without taking custody of the operation. */
export function synchronizeChatPanePublication(params: {
  holder: { binding: GitHubPublicationBinding | null };
  publications: Pick<ReturnType<typeof createSessionGitHubPublication>, "attach">;
  gatewaySnapshot: ApplicationGatewaySnapshot;
  readRow: () => GatewaySessionRow | undefined;
  isScopeCurrent: (() => boolean) | undefined;
  isPresented: () => boolean;
  participationBlocked: boolean;
  runActive: boolean;
  workspaceConflict: boolean;
}) {
  const { holder, gatewaySnapshot, readRow, isScopeCurrent } = params;
  const row = readRow();
  if (
    !isScopeCurrent ||
    !row ||
    isGatewayMethodAdvertised(gatewaySnapshot, "sessions.github.publish") !== true ||
    !canCallGatewayMethod(gatewaySnapshot, "sessions.github.options", "operator.read")
  ) {
    holder.binding?.detach();
    holder.binding = null;
    return;
  }
  if (!holder.binding?.matches(row)) {
    holder.binding?.detach();
    holder.binding = params.publications.attach(row, GitHubPublicationOwner);
  }
  const publication = holder.binding;
  const canMutate = !row.archived && !params.participationBlocked;
  const placement = row.placement;
  publication?.sync({
    canPublishShared:
      canMutate &&
      readSessionMethodAccess(gatewaySnapshot, {
        method: "sessions.github.publish",
        requiredScope: "operator.sessions.write",
        session: row,
      }).allowed,
    canPublishPersonal: canMutate && hasOperatorWriteAccess(gatewaySnapshot.hello?.auth ?? null),
    personalReady:
      !params.runActive &&
      (!isCloudWorkerPlacementState(placement?.state) ||
        (Boolean(row.repositoryWorkspaceId) && placement?.state === "active")) &&
      !params.workspaceConflict,
    isPresented: params.isPresented,
    isCurrent: () => {
      const currentRow = readRow();
      return isScopeCurrent() && currentRow !== undefined && publication?.matches(currentRow);
    },
  });
}
