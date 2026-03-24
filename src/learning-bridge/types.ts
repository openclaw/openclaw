import type { RewardSignal, RewardSignalKind } from "../research/events/types.js";

export type TrajectorySchemaVersion = "trajectory.v2";

export type SuggestedRLMethod = "binary" | "opd" | "combined";

export type ConsentScope = "local_only" | "hive_anonymous" | "hive_attributed";

export type TrajectorTurn = {
  turnId: string;
  role: "user" | "assistant" | "tool";
  contentHash: string;
  contentScrubbed?: string;
  toolName?: string;
  rewardSignal?: RewardSignal;
  stepIdx: number;
};

export type TrajectoryPackage = {
  schemaVersion: TrajectorySchemaVersion;
  packageId: string;
  agentId: string;
  createdAt: number;
  runId: string;
  sessionId: string;
  turns: TrajectorTurn[];
  rewardSignals: RewardSignal[];
  skillsActivated: string[];
  sessionRecallHits: number;
  dominantSignalKind: RewardSignalKind;
  suggestedRLMethod: SuggestedRLMethod;
  scrubbed: boolean;
  consentScope: ConsentScope;
};
