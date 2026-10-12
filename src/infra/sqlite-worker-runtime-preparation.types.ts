/** Code-only carrier custody; the broker alone validates and consumes it. */
export type SqliteWorkerRuntimePreparation = {
  release(): Promise<void>;
};
