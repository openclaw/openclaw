export type CommitmentCategoryConfig = {
  /** Enable inferred event check-ins such as "interview tomorrow". Default: true. */
  eventCheckIns?: boolean;
  /** Enable inferred deadline/progress check-ins. Default: true. */
  deadlineCheckIns?: boolean;
  /** Enable inferred open-loop check-ins such as "waiting to hear back". Default: true. */
  openLoops?: boolean;
  /**
   * Enable personal care check-ins. "gentle" keeps conservative extraction and delivery wording.
   * Default: "gentle".
   */
  careCheckIns?: boolean | "gentle";
};

export type CommitmentExtractionConfig = {
  /** Enable the background LLM extractor. Default: true. */
  enabled?: boolean;
  /** Optional model override (provider/model) for extractor runs. Defaults to the agent model. */
  model?: string;
  /** Debounce before draining queued extraction items. Default: 15000. */
  debounceMs?: number;
  /** Max extraction items per model call. Default: 8. */
  batchMaxItems?: number;
  /** Minimum confidence accepted for routine inferred commitments. Default: 0.72. */
  confidenceThreshold?: number;
  /** Minimum confidence accepted for care check-ins. Default: 0.86. */
  careConfidenceThreshold?: number;
  /** Extractor run timeout in seconds. Default: 45. */
  timeoutSeconds?: number;
};

export type CommitmentDeliveryConfig = {
  /** Max due commitments injected into one heartbeat turn. Default: 3. */
  maxPerHeartbeat?: number;
  /** Pending commitments older than this after latest due time are expired. Default: 72. */
  expireAfterHours?: number;
};

export type CommitmentsConfig = {
  /** Enable inferred commitment creation and heartbeat delivery. Default: true. */
  enabled?: boolean;
  /** Optional JSON store path. Defaults to ~/.openclaw/commitments/commitments.json. */
  store?: string;
  categories?: CommitmentCategoryConfig;
  extraction?: CommitmentExtractionConfig;
  delivery?: CommitmentDeliveryConfig;
};
