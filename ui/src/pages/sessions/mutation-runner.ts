export type SessionsPageMutationResult =
  | "completed"
  | "stale"
  | { status: "failed"; error: unknown };
