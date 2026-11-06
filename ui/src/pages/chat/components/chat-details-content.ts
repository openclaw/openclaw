import type { ApplicationGateway } from "../../../app/gateway.ts";
import { sessionParticipantIdentityKey } from "../../../lib/chat/sender-label.ts";
import { canPresentGatewayMethod } from "../../../lib/gateway-methods.ts";
import { readChatMachinePlacement } from "../chat-pane-placement.ts";
import { hasLoadedDetailsSubagents } from "../chat-spawned-subagent.ts";
import { listSubagents } from "../chat-subagent-wait.ts";
import type { ProcessesPanelData } from "../processes-panel-data.ts";
import type { ChatDetailsSnapshot } from "../session-details-snapshot-schema.ts";
import type { ChatDetailsEnvironmentDesktopProps, ChatDetailsProps } from "./chat-details-types.ts";
import type { DetailsViewer } from "./chat-details-viewer.ts";
import { hasEnvironmentTextChanges } from "./chat-environment-changes.ts";
import { hasChatDesktopOutputs } from "./chat-outputs-data.ts";
import type { ChatPullRequestsProps } from "./chat-pull-request-shared.tsx";
import {
  hasChatPublishedPullRequests,
  retainedPublication,
  showWorkRow,
} from "./chat-pull-requests.ts";
type DetailsSession = ChatDetailsProps["selectedSession"];
type DetailsWork = Pick<
  ChatPullRequestsProps,
  "branch" | "branchDismissed" | "publication" | "pullRequests"
>;
export function detailsSessionFacts(details: ChatDetailsProps | undefined): DetailsSession {
  const selected = details?.selectedSession;
  const cached = !details?.sessionFactsReady && details?.cachedDetails?.session;
  return selected && cached ? { ...selected, ...cached } : selected;
}

/** One People policy for the rendered section and its pre-hydration reservation. */

/** Boolean policy shared with the lazy row owner; no people/summary rows are materialized here. */
export function hasDetailsPeople(
  session: DetailsSession,
  viewer: DetailsViewer = { pending: true },
) {
  const participants = session?.expandedParticipants ?? session?.participants ?? [];
  const count = session?.participantCount ?? participants.length;
  if (count > 1) {
    return true;
  }
  const owner = session?.owner?.actor;
  let first: string | undefined;
  let person: DetailsViewer["identity"];
  for (const actor of [owner, session?.createdActor, ...participants]) {
    if (!actor?.identity) {
      continue;
    }
    const key = sessionParticipantIdentityKey(actor.identity);
    if (first !== undefined && first !== key) {
      return true;
    }
    first = key;
    person = actor.identity;
  }
  return Boolean(
    (first !== undefined ||
      count ||
      session?.createdActor?.label ||
      session?.createdActor?.id ||
      owner) &&
    !viewer.pending &&
    (count > participants.length ||
      [owner, session?.createdActor].some((actor) => actor && !actor.identity) ||
      !viewer.identity ||
      (person && (person.type !== viewer.identity.type || person.id !== viewer.identity.id))),
  );
}
export function environmentWork<T extends DetailsWork>(candidate: T | undefined) {
  if (
    !candidate ||
    candidate.publication?.result?.status === "published" ||
    (!candidate.branch &&
      !candidate.publication?.locked &&
      candidate.pullRequests.some((pr) => pr.state === "open" || pr.state === "draft"))
  ) {
    return undefined;
  }
  const publication = candidate.publication;
  return showWorkRow(candidate) ||
    (retainedPublication(publication) &&
      (publication?.result?.status !== "published" || publication.error))
    ? candidate
    : undefined;
}

export function hasDetailsEnvironment(
  details: ChatDetailsProps | undefined,
  environment: Pick<ChatDetailsEnvironmentDesktopProps, "placement" | "uncommitted"> | undefined,
  candidate: DetailsWork | undefined,
) {
  const machine = readChatMachinePlacement(
    { session: details?.selectedSession, ...environment?.placement }.session,
  );
  const work = environmentWork(candidate);
  const cached = !details?.sessionFactsReady && details?.cachedDetails?.environment;
  const branch = cached
    ? cached.branch
    : (details?.detailsWorkspace?.branch ?? work?.branch?.branch);
  const worktree = cached ? cached.worktree : Boolean(details?.selectedSession?.worktree);
  return Boolean(
    (machine.showPlacementMenu &&
      (environment?.placement || machine.workerPlacement?.environmentId)) ||
    branch ||
    work ||
    worktree ||
    (environment?.uncommitted &&
      !environment.uncommitted.unavailableReason &&
      hasEnvironmentTextChanges(environment.uncommitted)),
  );
}
export function hasDetailsSubagents(
  details: ChatDetailsProps | undefined,
  rows = details ? listSubagents(details) : [],
  desktop = true,
) {
  return (
    rows.length > 0 ||
    Boolean(
      desktop &&
      details &&
      !hasLoadedDetailsSubagents(details) &&
      (details.cachedDetails?.subagents?.total ?? 0) > 0,
    )
  );
}
export function hasDetailsProcesses(
  snapshot: Pick<ProcessesPanelData["snapshot"], "hasResult" | "errorKind" | "rows"> | undefined,
  cached: ChatDetailsSnapshot["processes"],
) {
  return snapshot?.hasResult || snapshot?.errorKind === "access"
    ? snapshot.rows.some((row) => row.status === "running")
    : (cached?.rows.length ?? 0) > 0;
}
export function admittedDetailsAutomationsCache(
  cache: NonNullable<ChatDetailsProps["cachedDetails"]>["automations"],
  snapshot: ApplicationGateway["snapshot"] | undefined,
  loaded = false,
  denied = false,
  readable = canPresentGatewayMethod(snapshot, "cron.list", "operator.read", {
    requireAdvertisement: false,
  }),
) {
  return !loaded && !denied && (!snapshot?.hello || readable) ? cache : undefined;
}

export function hasDetailsContent(
  details: ChatDetailsProps | undefined,
  facts: { automation?: boolean; processes?: boolean; viewer?: DetailsViewer } = {},
) {
  return Boolean(
    (Boolean(details?.onOpenProcesses) &&
      (facts.processes ?? hasDetailsProcesses(undefined, details?.cachedDetails?.processes))) ||
    hasDetailsSubagents(details) ||
    (facts.automation ??
      (admittedDetailsAutomationsCache(
        details?.cachedDetails?.automations,
        details?.pullRequestsGateway?.snapshot,
      )?.rows.length ?? 0) > 0) ||
    hasChatPublishedPullRequests({
      pullRequests: details?.pullRequests ?? [],
      publication: details?.githubPublication,
    }) ||
    details?.progressCard ||
    details?.progressCardError === "access-denied" ||
    Boolean(
      details?.outputs && hasChatDesktopOutputs(details.outputs, details.cachedDetails?.outputs),
    ) ||
    hasDetailsPeople(detailsSessionFacts(details), facts.viewer) ||
    hasDetailsEnvironment(details, details?.environment, {
      branch: details?.pullRequestsBranch,
      branchDismissed: details?.pullRequestsBranchDismissed,
      publication: details?.githubPublication,
      pullRequests: details?.pullRequests ?? [],
    }),
  );
}
