export type PreparedSqliteReadOnlyLocation = {
  cleanup: () => boolean;
  cleanupAsync: () => Promise<boolean>;
  location: string;
  // The directory cleanup actually removes (dirname(location) without an explicit
  // owned root), so diagnostics name the retained path, not an already-deleted child.
  cleanupRoot?: string;
};
