/**
 * Behavior this build declares to deploy tooling, in `dist/build-info.json` (written by
 * scripts/write-build-info.ts) and in `openclaw --version --json`. A build whose list lacks a
 * capability, or that has no list, is treated as lacking it: ancestry never substitutes for it.
 */
export const DECLARED_BUILD_CAPABILITIES = [
  // Continuation (karmaterminal): the continue_work turn-start fence (RFC §5.4.2). A build
  // without it re-drives a fenced, undelivered wake; `openclaw continuations` drains them first.
  "continuation-turn-start-fence",
] as const;
