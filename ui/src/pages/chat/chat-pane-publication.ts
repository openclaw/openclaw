import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { isCloudWorkerPlacementState } from "../../components/session-row-badge-presentation.ts";
import { canCallGatewayMethod, isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import {
  GitHubPublicationOwner,
  type GitHubPublicationView,
} from "../../lib/sessions/github-publication-owner.ts";
import type { createSessionGitHubPublication } from "../../lib/sessions/session-github-publication.ts";
import type { GitHubPublicationBinding } from "../../lib/sessions/session-types.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId, selectedChatSessionRow } from "./chat-state-route.ts";
import { retainedPublication } from "./components/chat-pull-requests.ts";

export function readChatPanePublicationRow(state: ChatPageHost, archived: boolean) {
  const row = selectedChatSessionRow(state);
  return (
    row && {
      ...row,
      agentId: row.agentId ?? resolveChatAgentId(state) ?? undefined,
      archived,
    }
  );
}

export function selectChatPanePublication(
  github: GitHubPublicationView | undefined,
  gitlab: GitHubPublicationView | undefined,
) {
  return retainedPublication(github)
    ? github
    : retainedPublication(gitlab) || gitlab?.target
      ? gitlab
      : github;
}

/** Attach the pane to session-owned publication state without taking custody of the operation. */
export function synchronizeChatPanePublication(params: {
  provider?: "github" | "gitlab";
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
  const provider = params.provider ?? "github";
  const { holder, gatewaySnapshot, readRow, isScopeCurrent } = params;
  const row = readRow();
  if (
    !isScopeCurrent ||
    !row ||
    isGatewayMethodAdvertised(gatewaySnapshot, `sessions.${provider}.publish`) !== true ||
    !canCallGatewayMethod(gatewaySnapshot, `sessions.${provider}.options`, "operator.read")
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
        method: `sessions.${provider}.publish`,
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

type PublicationPaneScope = Omit<
  Parameters<typeof synchronizeChatPanePublication>[0],
  "provider" | "holder" | "publications"
>;

export function synchronizeChatPanePublications(
  scope: PublicationPaneScope & {
    github: Pick<Parameters<typeof synchronizeChatPanePublication>[0], "holder" | "publications">;
    gitlab: Pick<Parameters<typeof synchronizeChatPanePublication>[0], "holder" | "publications">;
  },
) {
  const { github, gitlab, ...common } = scope;
  synchronizeChatPanePublication({ ...common, ...github, provider: "github" });
  synchronizeChatPanePublication({ ...common, ...gitlab, provider: "gitlab" });
}
