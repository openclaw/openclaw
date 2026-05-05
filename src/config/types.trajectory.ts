export type TrajectoryConfig = {
  /**
   * Interval (ms) for periodic flush of trajectory events to storage.
   * When set, the trajectory recorder will flush buffered events to disk
   * at this interval, in addition to explicit flushes at turn/session boundaries.
   *
   * @default undefined (no periodic flush)
   */
  flushTimeoutMs?: number;
};
