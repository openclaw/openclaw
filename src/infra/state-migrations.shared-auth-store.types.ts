export type SharedAuthStoreMigrationDetection = {
  sourcePath: string;
  hasLegacy: boolean;
  held?: boolean;
  /** Agent whose store is the relocation source; absent means main. */
  ownerId?: string;
  /** Main's store, when it also holds credentials the owner's relocation would drop. */
  conflictingSourcePath?: string;
};
