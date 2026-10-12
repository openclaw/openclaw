/** Optional code-only warming; database admission remains with the broker. */
export type SqliteWorkerRuntimePreparation = {
  release(): Promise<void>;
};
