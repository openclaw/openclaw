/** Original physical writer custody; captured facts are not a new admission. */
export type SessionEntryCommitContext = {
  readonly env: NodeJS.ProcessEnv;
  assertCurrent: () => void;
};
