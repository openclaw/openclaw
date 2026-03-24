import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ResearchEventV1 } from "../research/events/types.js";
import { isLearningBridgeEnabled } from "../research/events/writer.js";
import { classifyResearchEvents } from "./reward-classifier.js";
import { writeRlFeedPackage } from "./rl-feed-exporter.js";
import { buildTrajectoryPackage } from "./trajectory-packager.js";

const log = createSubsystemLogger("learning-bridge");

/**
 * End-of-run export: classifies buffered research events and writes `rl-feed/` artifacts.
 * No-op unless `research.enabled` and `research.learningBridge.enabled`.
 */
export async function exportLearningBridgeRun(params: {
  cfg?: OpenClawConfig;
  runId: string;
  sessionId: string;
  agentId: string;
  events: ResearchEventV1[];
  /** Test injection for deterministic IDs. */
  nowMs?: number;
  packageId?: string;
}): Promise<void> {
  if (!isLearningBridgeEnabled(params.cfg)) {
    return;
  }
  if (params.events.length === 0) {
    return;
  }

  const enriched = classifyResearchEvents(params.events);
  const packageId = params.packageId ?? randomUUID();
  const createdAtMs = params.nowMs ?? Date.now();

  const pkg = buildTrajectoryPackage({
    packageId,
    agentId: params.agentId,
    runId: params.runId,
    sessionId: params.sessionId,
    createdAtMs,
    enrichedEvents: enriched,
  });

  try {
    await writeRlFeedPackage({ cfg: params.cfg, pkg });
  } catch (err) {
    log.warn(`learning bridge export failed: ${String(err)}`);
  }
}

export type { TrajectoryPackage, TrajectorTurn } from "./types.js";
export { classifyResearchEvents } from "./reward-classifier.js";
export { buildTrajectoryPackage } from "./trajectory-packager.js";
export { writeRlFeedPackage, resolveRlFeedRoot } from "./rl-feed-exporter.js";
