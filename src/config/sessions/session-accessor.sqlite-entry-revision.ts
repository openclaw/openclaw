/** Connection revision shared by entry snapshots and maintenance age facts. */
export type SqliteSessionEntryRevision = {
  dataVersion: number;
  sessionNodesGeneration: number;
};
