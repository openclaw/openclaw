import type { SessionParticipant } from "../../../../../packages/gateway-protocol/src/schema/session-participant.js";
import { sessionParticipantIdentityKey } from "../../../lib/chat/sender-label.ts";
import { projectDetailsSubagents } from "../chat-details-snapshot.ts";
import { hasLoadedDetailsSubagents } from "../chat-spawned-subagent.ts";
import { listSubagents } from "../chat-subagent-wait.ts";
import {
  environmentWork,
  hasDetailsEnvironment,
  hasDetailsSubagents,
} from "./chat-details-content.ts";
import type { ChatDetailsEnvironmentDesktopProps, ChatDetailsProps } from "./chat-details-types.ts";
import { hasEnvironmentTextChanges } from "./chat-environment-changes.ts";
import type { ChatPullRequestsProps } from "./chat-pull-request-shared.tsx";

type DetailsSession = ChatDetailsProps["selectedSession"];
type DetailsWork = Pick<
  ChatPullRequestsProps,
  "branch" | "branchDismissed" | "publication" | "pullRequests"
>;

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

/** Preserve the Environment owner's suppression of already-published work. */
/** Availability and display facts share the exact same cache, placement, work and Changes rules. */
export function readDetailsEnvironment<T extends DetailsWork>(
  details: ChatDetailsProps | undefined,
  environment: Pick<ChatDetailsEnvironmentDesktopProps, "placement" | "uncommitted"> | undefined,
  candidate: T | undefined,
) {
  const session = details?.selectedSession;
  const work = environmentWork(candidate);
  const result = environment?.uncommitted;
  const changes =
    result && !result.unavailableReason && hasEnvironmentTextChanges(result) ? result : undefined;
  const live = {
    branch: details?.detailsWorkspace?.branch ?? work?.branch?.branch,
    worktree: Boolean(session?.worktree),
  };
  const facts = (!details?.sessionFactsReady && details?.cachedDetails?.environment) || live;
  return {
    work,
    changes,
    live,
    facts,
    visible: hasDetailsEnvironment(details, environment, candidate),
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
  return { liveSummary, summary, visible: hasDetailsSubagents(details, rows, desktop) };
}

/** Before mount, inventory flags use their fresh-owner defaults; mounted owners supply them.
 * Offline previews follow that owner, while a current hello must admit cron reads. */
