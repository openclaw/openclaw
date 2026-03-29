import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { writeTextAtomic } from "../infra/json-files.js";
import { isPathInside } from "../infra/path-guards.js";
import { writeJsonFileAtomically } from "../plugin-sdk/json-store.js";
import { resolveConfigDir, resolveUserPath } from "../utils.js";
import type { TrajectorTurn, TrajectoryPackage } from "./types.js";

export async function resolveRlFeedRoot(cfg?: OpenClawConfig): Promise<string> {
  const configured = cfg?.research?.learningBridge?.outputDir?.trim();
  const stateDir = resolveConfigDir();
  const root = configured ? resolveUserPath(configured) : path.join(stateDir, "rl-feed");
  let realRoot = root;
  try {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    realRoot = await fs.realpath(root);
  } catch {
    realRoot = path.resolve(root);
  }
  const realState = await fs.realpath(stateDir).catch(() => path.resolve(stateDir));
  if (!isPathInside(realState, realRoot)) {
    throw new Error(
      `learning bridge outputDir must resolve inside OpenClaw state directory (${realState}); got ${realRoot}`,
    );
  }
  return realRoot;
}

function serializeTurnLine(turn: TrajectorTurn): string {
  const o: Record<string, unknown> = {
    turnId: turn.turnId,
    role: turn.role,
    contentHash: turn.contentHash,
    stepIdx: turn.stepIdx,
  };
  if (turn.contentScrubbed !== undefined) {
    o.contentScrubbed = turn.contentScrubbed;
  }
  if (turn.toolName !== undefined) {
    o.toolName = turn.toolName;
  }
  if (turn.rewardSignal !== undefined) {
    o.rewardSignal = turn.rewardSignal;
  }
  return JSON.stringify(o);
}

export type RlFeedRewardsFile = {
  packageId: string;
  signals: TrajectoryPackage["rewardSignals"];
};

export type RlFeedMetadataFile = {
  schemaVersion: TrajectoryPackage["schemaVersion"];
  packageId: string;
  agentId: string;
  createdAt: number;
  runId: string;
  sessionId: string;
  dominantSignalKind: TrajectoryPackage["dominantSignalKind"];
  suggestedRLMethod: TrajectoryPackage["suggestedRLMethod"];
  skillsActivated: string[];
  sessionRecallHits: number;
  scrubbed: boolean;
  consentScope: TrajectoryPackage["consentScope"];
  turnCount: number;
};

export async function writeRlFeedPackage(params: {
  cfg?: OpenClawConfig;
  pkg: TrajectoryPackage;
}): Promise<void> {
  const root = await resolveRlFeedRoot(params.cfg);
  const trajDir = path.join(root, "trajectories");
  const rewardsDir = path.join(root, "rewards");
  const metaDir = path.join(root, "metadata");
  await fs.mkdir(trajDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(rewardsDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(metaDir, { recursive: true, mode: 0o700 });

  const base = params.pkg.packageId;
  const jsonlPath = path.join(trajDir, `${base}.jsonl`);
  const rewardsPath = path.join(rewardsDir, `${base}.json`);
  const metaPath = path.join(metaDir, `${base}.meta.json`);

  const lines = params.pkg.turns.map((t) => serializeTurnLine(t)).join("\n");
  const jsonlPayload = lines.length > 0 ? `${lines}\n` : "";
  await writeTextAtomic(jsonlPath, jsonlPayload, {
    mode: 0o600,
    ensureDirMode: 0o700,
    appendTrailingNewline: false,
  });

  const rewardsBody: RlFeedRewardsFile = {
    packageId: params.pkg.packageId,
    signals: params.pkg.rewardSignals,
  };
  await writeJsonFileAtomically(rewardsPath, rewardsBody);

  const metaBody: RlFeedMetadataFile = {
    schemaVersion: params.pkg.schemaVersion,
    packageId: params.pkg.packageId,
    agentId: params.pkg.agentId,
    createdAt: params.pkg.createdAt,
    runId: params.pkg.runId,
    sessionId: params.pkg.sessionId,
    dominantSignalKind: params.pkg.dominantSignalKind,
    suggestedRLMethod: params.pkg.suggestedRLMethod,
    skillsActivated: params.pkg.skillsActivated,
    sessionRecallHits: params.pkg.sessionRecallHits,
    scrubbed: params.pkg.scrubbed,
    consentScope: params.pkg.consentScope,
    turnCount: params.pkg.turns.length,
  };
  await writeJsonFileAtomically(metaPath, metaBody);
}
