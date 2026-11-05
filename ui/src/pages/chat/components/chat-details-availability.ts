import type { SessionParticipant } from "../../../../../packages/gateway-protocol/src/schema/session-participant.js";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import { sessionParticipantIdentityKey } from "../../../lib/chat/sender-label.ts";
import { canPresentGatewayMethod } from "../../../lib/gateway-methods.ts";
import { projectDetailsSubagents } from "../chat-details-snapshot.ts";
import { readChatMachinePlacement } from "../chat-pane-placement.ts";
import { hasLoadedDetailsSubagents } from "../chat-spawned-subagent.ts";
import { listSubagents } from "../chat-subagent-wait.ts";
import type { ChatDetailsEnvironmentDesktopProps, ChatDetailsProps } from "./chat-details-types.ts";
import { hasEnvironmentTextChanges } from "./chat-environment-content.tsx";
import { hasChatDesktopOutputs } from "./chat-outputs-data.ts";
import type { ChatPullRequestsProps } from "./chat-pull-request-shared.tsx";
import {
  hasChatPublishedPullRequests,
  retainedPublication,
  showWorkRow,
} from "./chat-pull-requests.ts";

type DetailsSession = ChatDetailsProps["selectedSession"];
type DetailsViewer = { pending: boolean; identity?: SessionParticipant["identity"] };
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
export function readDetailsPeople(session: DetailsSession) {
  const participants = session?.expandedParticipants ?? session?.participants ?? [];
  const count = session?.participantCount ?? participants.length;
  const partial = count > participants.length;
  const owner = session?.owner?.actor;
  const union = new Map<string, SessionParticipant>();
  for (const person of [owner, session?.createdActor, ...participants]) {
    if (!person?.identity) {
      continue;
    }
    const key = sessionParticipantIdentityKey(person.identity);
    const previous = union.get(key);
    union.set(key, {
      identity: person.identity,
      label: person.label ?? previous?.label,
      avatarUrl: person.avatarUrl ?? previous?.avatarUrl,
    });
  }
  const people = [...union.values()];
  const unknownActor = [owner, session?.createdActor].some((actor) => actor && !actor.identity);
  const hasContent = Boolean(
    people.length || count || session?.createdActor?.label || session?.createdActor?.id || owner,
  );
  return { participants, count, partial, people, unknownActor, hasContent };
}

export function hasDetailsPeople(
  facts: ReturnType<typeof readDetailsPeople>,
  viewer: DetailsViewer = { pending: true },
) {
  const identity = viewer.identity;
  // The server count excludes the owner. Unknown actors alone remain inconclusive.
  return (
    facts.hasContent &&
    (facts.count > 1 ||
      facts.people.length > 1 ||
      (!viewer.pending &&
        (facts.partial ||
          facts.unknownActor ||
          !identity ||
          facts.people.some(
            (person) =>
              person.identity.type !== identity.type || person.identity.id !== identity.id,
          ))))
  );
}

/** Preserve the Environment owner's suppression of already-published work. */
function environmentWork<T extends DetailsWork>(candidate: T | undefined) {
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

/** Availability and display facts share the exact same cache, placement, work and Changes rules. */
export function readDetailsEnvironment<T extends DetailsWork>(
  details: ChatDetailsProps | undefined,
  environment: Pick<ChatDetailsEnvironmentDesktopProps, "placement" | "uncommitted"> | undefined,
  candidate: T | undefined,
) {
  const session = details?.selectedSession;
  const machine = readChatMachinePlacement({ session, ...environment?.placement }.session);
  const work = environmentWork(candidate);
  const result = environment?.uncommitted;
  const changes =
    result && !result.unavailableReason && hasEnvironmentTextChanges(result) ? result : undefined;
  const live = {
    branch: details?.detailsWorkspace?.branch ?? work?.branch?.branch,
    worktree: Boolean(session?.worktree),
  };
  const facts = (!details?.sessionFactsReady && details?.cachedDetails?.environment) || live;
  const hasMachine =
    machine.showPlacementMenu &&
    Boolean(environment?.placement || machine.workerPlacement?.environmentId);
  return {
    work,
    changes,
    live,
    facts,
    visible: Boolean(hasMachine || facts.branch || work || facts.worktree || changes),
  };
}

/** The mounted owner and pre-hydration layout consume the same roster/cache policy. */
export function readDetailsSubagents(
  details: ChatDetailsProps | undefined,
  rows = details ? listSubagents(details) : [],
  desktop = true,
) {
  const liveSummary =
    desktop && details && hasLoadedDetailsSubagents(details)
      ? projectDetailsSubagents(rows.filter((row) => row.listed))
      : undefined;
  const summary = liveSummary ?? (desktop ? details?.cachedDetails?.subagents : undefined);
  return { liveSummary, summary, visible: rows.length > 0 || (summary?.total ?? 0) > 0 };
}

/** Before mount, inventory flags use their fresh-owner defaults; mounted owners supply them.
 * Offline previews follow that owner, while a current hello must admit cron reads. */
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
  automationAvailability?: boolean,
) {
  return Boolean(
    readDetailsSubagents(details).visible ||
    (automationAvailability ??
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
    (details?.outputs && hasChatDesktopOutputs(details.outputs)) ||
    hasDetailsPeople(readDetailsPeople(detailsSessionFacts(details))) ||
    readDetailsEnvironment(details, details?.environment, {
      branch: details?.pullRequestsBranch,
      branchDismissed: details?.pullRequestsBranchDismissed,
      publication: details?.githubPublication,
      pullRequests: details?.pullRequests ?? [],
    }).visible,
  );
}
