import type { SessionProfileInvolvement } from "./types.js";

type MentionSource = NonNullable<SessionProfileInvolvement["lastMention"]>;

export function isNewerSessionMention(source: MentionSource, previous: MentionSource): boolean {
  return source.generation === previous.generation
    ? source.sequence > previous.sequence
    : source.timestamp > previous.timestamp;
}

/** Profile merges combine mention evidence independently of the latest personal choice. */
export function mergeSessionProfileInvolvement(
  states: Iterable<SessionProfileInvolvement | undefined>,
): SessionProfileInvolvement | undefined {
  let latest: SessionProfileInvolvement | undefined;
  let lastMention: MentionSource | undefined;
  for (const state of states) {
    if (!state) {
      continue;
    }
    if (
      !latest ||
      state.updatedAt > latest.updatedAt ||
      (state.updatedAt === latest.updatedAt && state.hidden)
    ) {
      latest = state;
    }
    if (
      state.lastMention &&
      (!lastMention || isNewerSessionMention(state.lastMention, lastMention))
    ) {
      lastMention = state.lastMention;
    }
  }
  return latest ? { ...latest, ...(lastMention ? { lastMention } : {}) } : undefined;
}
