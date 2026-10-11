import { toUSVString } from "node:util";
import type {
  SessionActorMemoryCollaborationCommand,
  SessionActorMemoryCollaborationQuery,
} from "./session-actor-memory-collaboration-contract.js";
import {
  readSessionActorMemoryReactions,
  setSessionActorMemoryReaction,
} from "./session-actor-memory-reactions.js";
import type { SessionActorMemoryStorageContext } from "./session-actor-memory-storage-context.js";
import {
  mutateSessionActorMemorySuggestion,
  readSessionActorMemorySuggestions,
} from "./session-actor-memory-suggestions.js";
import { MAX_SESSION_PARTICIPANTS } from "./session-entry-provenance.js";
import {
  participantIdentityNamespace,
  mergeParticipantAggregate,
} from "./session-participant-identity.js";
import { SessionWorkStartInvalidatedError } from "./work-start-error.js";

export function readSessionActorMemoryCollaboration(
  context: SessionActorMemoryStorageContext,
  query: SessionActorMemoryCollaborationQuery,
) {
  switch (query.type) {
    case "session.members.read":
      return { entry: context.state.hot.entry, members: context.state.hot.members };
    case "session.participants.read":
      return context.state.hot.participants;
    case "session.suggestions.read":
      return readSessionActorMemorySuggestions(context, query.input.params);
    case "session.reactions.read":
      return readSessionActorMemoryReactions(context.state, query.input.sessionId);
  }
}

export function mutateSessionActorMemoryCollaboration(
  context: SessionActorMemoryStorageContext,
  command: SessionActorMemoryCollaborationCommand,
) {
  const { state } = context;
  if (command.type === "session.category.apply") {
    const changed: Array<{ sessionKey: string; sessionId: string }> = [];
    for (const [sessionKey, candidate] of context.entries()) {
      if (candidate.hot.entry?.category?.trim() !== command.input.from) {
        continue;
      }
      const current = context.edit(sessionKey).hot.entry!;
      if (command.input.to === undefined) {
        delete current.category;
      } else {
        current.category = command.input.to;
      }
      changed.push({ sessionKey, sessionId: current.sessionId });
    }
    return changed;
  }
  if (command.type === "session.collaboration.involvement") {
    return { accepted: false, changed: false };
  }
  const entry = state.hot.entry;
  const expectedSessionId =
    "params" in command.input && "expectedSessionId" in command.input.params
      ? command.input.params.expectedSessionId
      : "expectedSessionId" in command.input
        ? command.input.expectedSessionId
        : undefined;
  // This binds an actual write to the requested transcript, not a bookkeeping revision.
  if (expectedSessionId !== undefined && entry?.sessionId !== expectedSessionId) {
    throw new SessionWorkStartInvalidatedError("session changed before collaboration mutation");
  }
  switch (command.type) {
    case "session.collaboration.add": {
      if (!entry) {
        throw new Error("session changed before sharing mutation");
      }
      const { params } = command.input;
      const identityId = params.identityId.trim();
      const addedBy = params.addedBy.trim();
      if (!identityId || !addedBy) {
        throw new Error("session member identity and actor are required");
      }
      const member = { identityId, addedBy, addedAt: params.addedAt ?? Date.now() };
      const inserted = !state.hot.members.some((row) => row.identityId === toUSVString(identityId));
      if (inserted) {
        state.hot.members.push({
          ...member,
          identityId: toUSVString(identityId),
          addedBy: toUSVString(addedBy),
        });
        state.hot.members.sort((left, right) =>
          Buffer.compare(Buffer.from(left.identityId), Buffer.from(right.identityId)),
        );
      }
      return {
        value: { member, inserted },
        ...(inserted
          ? {
              facts: {
                kind: "member" as const,
                sessionId: entry.sessionId,
                identityId: toUSVString(identityId),
                present: true,
              },
            }
          : {}),
      };
    }
    case "session.collaboration.remove": {
      if (!entry) {
        throw new Error("session changed before sharing mutation");
      }
      const { identityId, expected } = command.input;
      const index = state.hot.members.findIndex(
        (row) =>
          row.identityId === toUSVString(identityId.trim()) &&
          (!expected || (row.addedBy === expected.addedBy && row.addedAt === expected.addedAt)),
      );
      const value = index < 0 ? null : state.hot.members.splice(index, 1)[0]!;
      return {
        value,
        ...(value
          ? {
              facts: {
                kind: "member" as const,
                sessionId: entry.sessionId,
                identityId: value.identityId,
                present: false,
              },
            }
          : {}),
      };
    }
    case "session.collaboration.owner.assign": {
      if (!entry) {
        return { value: null };
      }
      const { owner, assignedBy, assignedAt = Date.now() } = command.input.params;
      const value = { actor: owner, assignedBy, assignedAt };
      entry.owner = structuredClone(value);
      return {
        value,
        facts: {
          kind: "owner" as const,
          sessionId: entry.sessionId,
          lifecycleRevision: entry.lifecycleRevision ?? null,
          owner: value,
        },
      };
    }
    case "session.collaboration.participant": {
      const { params, profileAliases = [] } = command.input;
      const { identity } = params;
      const projection = () =>
        state.hot.participants.length
          ? {
              participants: state.hot.participants.map(({ identity: actor }) => ({
                identity: actor,
              })),
              participantCount: state.hot.participants.length,
            }
          : {};
      if (!identity.id || (identity.type === "agent" && identity.id === params.sessionAgentId)) {
        return { value: null, projectionChanged: false, participants: projection() };
      }
      const namespace = participantIdentityNamespace(identity);
      const candidates = state.hot.participants.filter(
        (row) => participantIdentityNamespace(row.identity) === namespace,
      );
      const previous =
        candidates.find((row) => row.identity.id === identity.id) ??
        (identity.type === "profile"
          ? candidates
              .toSorted((left, right) =>
                Buffer.compare(Buffer.from(left.identity.id), Buffer.from(right.identity.id)),
              )
              .find((row) => profileAliases.includes(row.identity.id))
          : undefined);
      if (!previous && state.hot.participants.length >= MAX_SESSION_PARTICIPANTS) {
        return { value: "capped" as const, projectionChanged: false, participants: projection() };
      }
      const promptedAt = params.promptedAt ?? Date.now();
      const aggregate = mergeParticipantAggregate(
        previous
          ? {
              contribution_count: previous.contributionCount,
              first_prompted_at: previous.firstPromptedAt,
              last_prompted_at: previous.lastPromptedAt,
            }
          : undefined,
        { contribution_count: 1, first_prompted_at: promptedAt, last_prompted_at: promptedAt },
        "sum",
      );
      const next = {
        identity: previous?.identity ?? structuredClone(identity),
        contributionCount: aggregate.contribution_count,
        firstPromptedAt: aggregate.first_prompted_at,
        lastPromptedAt: aggregate.last_prompted_at,
      };
      if (previous) {
        state.hot.participants.splice(state.hot.participants.indexOf(previous), 1, next);
      } else {
        state.hot.participants.push(next);
      }
      state.hot.participants.sort(
        (left, right) =>
          (left.firstPromptedAt === null ? -Infinity : left.firstPromptedAt) -
            (right.firstPromptedAt === null ? -Infinity : right.firstPromptedAt) ||
          Buffer.compare(Buffer.from(left.identity.id), Buffer.from(right.identity.id)) ||
          Buffer.compare(
            Buffer.from(participantIdentityNamespace(left.identity)),
            Buffer.from(participantIdentityNamespace(right.identity)),
          ),
      );
      const participants = projection();
      if (entry) {
        Object.assign(entry, participants);
      }
      return {
        value: previous ? ("updated" as const) : ("inserted" as const),
        projectionChanged:
          !previous ||
          previous.identity.id !== identity.id ||
          previous.firstPromptedAt !== next.firstPromptedAt,
        participants,
      };
    }
    case "session.collaboration.suggestion.add":
    case "session.collaboration.suggestion.claim":
    case "session.collaboration.suggestion.release":
    case "session.collaboration.suggestion.finalize":
      return mutateSessionActorMemorySuggestion(context, command);
    case "session.reaction.set":
      return setSessionActorMemoryReaction(state, command.input.params);
  }
}
