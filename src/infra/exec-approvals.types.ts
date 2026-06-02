export type ExecAllowlistEntry = {
  /** Stable entry id for persisted allow-always records. */
  id?: string;
  /** Executable path, basename, or glob pattern that may be approved. */
  pattern: string;
  /** Marks entries generated from an allow-always decision. */
  source?: "allow-always";
  /** Original command text used when the entry was created. */
  commandText?: string;
  /** Optional argv regex that narrows the executable match. */
  argPattern?: string;
  /** Timestamp of the most recent successful match. */
  lastUsedAt?: number;
  /** Command text observed during the most recent successful match. */
  lastUsedCommand?: string;
  /** Resolved executable path observed during the most recent successful match. */
  lastResolvedPath?: string;
};
