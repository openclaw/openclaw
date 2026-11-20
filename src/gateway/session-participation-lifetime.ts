/** Exact invitation producers retire permanently on a committed access reduction. */
type ParticipationTarget = Readonly<{
  profileId: string;
  agentId: string;
  sessionKey: string;
  sessionId: string;
}>;

const producers = new Set<{ target: ParticipationTarget; controller: AbortController }>();

export function retainSessionParticipation(target: ParticipationTarget) {
  const producer = { target, controller: new AbortController() };
  producers.add(producer);
  return {
    signal: producer.controller.signal,
    followIncarnation: (previous: string | null, current: string) => {
      if (producer.target.sessionId === previous && !producer.controller.signal.aborted) {
        producer.target = { ...producer.target, sessionId: current };
      }
    },
    release: () => producers.delete(producer),
  };
}

export function revokeSessionParticipation(target: ParticipationTarget): void {
  for (const producer of producers) {
    const original = producer.target;
    if (
      original.profileId === target.profileId &&
      original.agentId === target.agentId &&
      original.sessionKey === target.sessionKey &&
      original.sessionId === target.sessionId
    ) {
      producer.controller.abort(new Error("Session participation was revoked."));
    }
  }
}
