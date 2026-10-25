/**
 * Static identity of the spawn tool, kept beside the factory because that file is
 * at its line cap.
 *
 * `sessions_spawn` stays outside the Tool Search catalog. The prompt names it for
 * delegated work, so deferring it leaves the request's `tools` without a tool the
 * guidance still tells the model to call; a provider that only makes calls for
 * names it was given returns that call as text, and the turn ends without
 * spawning. `sessions_yield` holds the same contract from the other end of the
 * flow.
 */
export const sessionsSpawnToolIdentity = {
  label: "Sessions",
  name: "sessions_spawn",
  catalogMode: "direct-only",
} as const;
