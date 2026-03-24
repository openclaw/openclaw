import { hashLargeText } from "../research/events/redaction.js";
import type { ResearchEventV1, RewardSignal, RewardSignalKind } from "../research/events/types.js";
import type { SuggestedRLMethod, TrajectoryPackage, TrajectorTurn } from "./types.js";

function stablePayloadHash(ev: ResearchEventV1): string {
  const minimal = {
    kind: ev.kind,
    payload: ev.payload,
  };
  return hashLargeText(JSON.stringify(minimal));
}

function collectSkills(events: ResearchEventV1[]): string[] {
  const names = new Set<string>();
  for (const ev of events) {
    if (ev.kind === "tool.start") {
      names.add(ev.payload.toolName);
    }
  }
  return [...names].toSorted();
}

function deriveRouting(rewardKinds: Array<RewardSignal["kind"]>): {
  dominant: RewardSignalKind;
  suggested: SuggestedRLMethod;
} {
  if (rewardKinds.length === 0) {
    return { dominant: "binary", suggested: "binary" };
  }
  const hasDirectional = rewardKinds.includes("directional");
  const hasBinary = rewardKinds.includes("binary");
  if (hasDirectional && hasBinary) {
    return { dominant: "combined", suggested: "combined" };
  }
  if (hasDirectional) {
    return { dominant: "directional", suggested: "opd" };
  }
  return { dominant: "binary", suggested: "binary" };
}

function buildTurns(enriched: ResearchEventV1[], packageId: string): TrajectorTurn[] {
  const turns: TrajectorTurn[] = [];
  let stepIdx = 0;
  for (const ev of enriched) {
    if (ev.kind === "run.start" || ev.kind === "run.end") {
      continue;
    }
    const contentHash = stablePayloadHash(ev);
    const base = {
      turnId: `${packageId}-t${stepIdx}`,
      contentHash,
      stepIdx,
      rewardSignal: ev.reward,
    };
    if (ev.kind === "llm.request") {
      turns.push({
        ...base,
        role: "user",
      });
      stepIdx += 1;
      continue;
    }
    if (ev.kind === "llm.response") {
      turns.push({
        ...base,
        role: "assistant",
      });
      stepIdx += 1;
      continue;
    }
    if (ev.kind === "tool.start" || ev.kind === "tool.end") {
      const toolName = ev.payload.toolName;
      turns.push({
        ...base,
        role: "tool",
        toolName,
      });
      stepIdx += 1;
    }
  }
  return turns;
}

export type BuildTrajectoryPackageParams = {
  packageId: string;
  agentId: string;
  runId: string;
  sessionId: string;
  createdAtMs: number;
  enrichedEvents: ResearchEventV1[];
};

export function buildTrajectoryPackage(params: BuildTrajectoryPackageParams): TrajectoryPackage {
  const rewards = params.enrichedEvents
    .map((e) => e.reward)
    .filter((r): r is NonNullable<typeof r> => Boolean(r));
  const rewardKinds = rewards.map((r) => r.kind);
  const { dominant, suggested } = deriveRouting(rewardKinds);

  return {
    schemaVersion: "trajectory.v2",
    packageId: params.packageId,
    agentId: params.agentId,
    createdAt: params.createdAtMs,
    runId: params.runId,
    sessionId: params.sessionId,
    turns: buildTurns(params.enrichedEvents, params.packageId),
    rewardSignals: rewards,
    skillsActivated: collectSkills(params.enrichedEvents),
    sessionRecallHits: 0,
    dominantSignalKind: dominant,
    suggestedRLMethod: suggested,
    scrubbed: true,
    consentScope: "local_only",
  };
}
