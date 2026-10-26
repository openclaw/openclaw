export type SharedAuthStoreMigrationDetection = {
  sourcePath: string;
  ownerId?: string;
  conflictingSourcePath?: string;
  hasLegacy: boolean;
  held?: boolean;
};
