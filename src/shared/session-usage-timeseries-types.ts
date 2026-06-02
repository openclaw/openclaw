export type SessionUsageTimePoint = {
  /** Bucket timestamp in milliseconds since epoch. */
  timestamp: number;
  /** Input tokens counted in the bucket. */
  input: number;
  /** Output tokens counted in the bucket. */
  output: number;
  /** Cached input tokens read in the bucket. */
  cacheRead: number;
  /** Cached input tokens written in the bucket. */
  cacheWrite: number;
  /** Total tokens counted in the bucket. */
  totalTokens: number;
  /** Estimated cost counted in the bucket. */
  cost: number;
  /** Running total tokens through this point. */
  cumulativeTokens: number;
  /** Running estimated cost through this point. */
  cumulativeCost: number;
};

export type SessionUsageTimeSeries = {
  /** Session id represented by the series, when resolved from usage storage. */
  sessionId?: string;
  /** Chronologically sorted usage points, possibly downsampled by the loader. */
  points: SessionUsageTimePoint[];
};
