export type ConfigHealthFingerprint = {
  hash: string;
  bytes: number;
  mtimeMs: number | null;
  ctimeMs: number | null;
  dev: string | null;
  ino: string | null;
  mode: number | null;
  nlink: number | null;
  uid: number | null;
  gid: number | null;
  hasMeta: boolean;
  gatewayMode: string | null;
  observedAt: string;
};

export type ConfigHealthEntry = {
  lastKnownGood?: ConfigHealthFingerprint;
  lastPromotedGood?: ConfigHealthFingerprint;
  lastObservedSuspiciousSignature?: string | null;
};

export type ConfigHealthState = {
  entries?: Record<string, ConfigHealthEntry>;
};

export type ConfigHealthEntryChanges = {
  [Key in keyof ConfigHealthEntry]?: ConfigHealthEntry[Key] | null;
};

/** Exact persisted facts, separate from permissively decoded fingerprints. */
export type ConfigHealthEntryBasis = Readonly<{
  lastKnownGoodJson: string | null;
  lastPromotedGoodJson: string | null;
  suspiciousSignature: string | null;
  updatedAtMs: number;
}>;

export type ConfigHealthSnapshot = {
  state: ConfigHealthState;
  /** Null means the read failed; an empty map proves there were no rows. */
  basis: Readonly<Record<string, ConfigHealthEntryBasis>> | null;
};
