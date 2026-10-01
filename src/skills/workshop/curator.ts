import path from "node:path";
import type { SkillsCuratorLiveStatusResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { listAgentIds } from "../../agents/agent-scope-config.js";
import { canonicalizePath } from "../../agents/utils/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  onTrustedInternalDiagnosticEvent,
  type DiagnosticSkillUsedEvent,
} from "../../infra/diagnostic-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { normalizeSkillIndexName } from "../discovery/skill-index.js";
import { parseSkillProposalRow } from "./store-sqlite-record.js";
import {
  listWritableWorkshopSkillSummaries,
  type WritableWorkshopSkillSummary,
} from "./workspace-skill-read.js";

const log = createSubsystemLogger("skills/curator");

export const SKILL_LIFECYCLE_CURATION_RETIRED_MESSAGE =
  "Skill lifecycle curation is retired. The weekly collection review manages the skill collection; pin, unpin, and restore no longer exist.";

function canonicalSkillKey(name: string): string {
  const key = normalizeSkillIndexName(name);
  if (!key) {
    throw new Error(`Invalid skill name: ${name}`);
  }
  return key;
}

export async function getSkillCuratorStatus(
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> & { config: OpenClawConfig },
): Promise<SkillsCuratorLiveStatusResult> {
  const context = captureOpenClawStateWorkerContext(options);
  const curatedByFile = new Map<string, WritableWorkshopSkillSummary>();
  for (const agentId of listAgentIds(options.config)) {
    for (const skill of listWritableWorkshopSkillSummaries({
      config: options.config,
      agentId,
      env: options.env,
    })) {
      const skillFile = canonicalizePath(skill.filePath);
      curatedByFile.set(skillFile, skill);
    }
  }
  const { executeOpenClawStateWorker } = await import("../../state/openclaw-state-worker-store.js");
  const { proposalRows, usageRows, reviewStatus } = await executeOpenClawStateWorker(context, {
    type: "skills.curator.read",
    input: { skillFiles: [...curatedByFile.keys()] },
  });
  const createdAtByFile = new Map<string, number>();
  for (const row of proposalRows) {
    const record = parseSkillProposalRow(row);
    if (!record || !record.appliedAt) {
      continue;
    }
    const appliedAtMs = Date.parse(record.appliedAt);
    const skillFile = canonicalizePath(record.target.skillFile);
    if (!Number.isFinite(appliedAtMs)) {
      continue;
    }
    createdAtByFile.set(
      skillFile,
      Math.min(createdAtByFile.get(skillFile) ?? appliedAtMs, appliedAtMs),
    );
  }
  const usageByFile = new Map(usageRows.map((row) => [row.skill_file, row]));
  const curatedSkills = [...curatedByFile.entries()].toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  const skills: SkillsCuratorLiveStatusResult["skills"] = curatedSkills.map(
    ([skillFile, skill]) => {
      const usage = usageByFile.get(skillFile);
      return {
        skillFile,
        skillKey: skill.skillKey,
        skillName: skill.name,
        createdAtMs: createdAtByFile.get(skillFile) ?? null,
        state: "active",
        pinned: false,
        stateChangedAtMs: createdAtByFile.get(skillFile) ?? null,
        lastUsedAtMs: usage?.last_used_at_ms ?? null,
        useCount: usage?.use_count ?? 0,
        archivedReason: null,
      };
    },
  );
  return {
    inventory: "live-workshop",
    lastAttemptAtMs: reviewStatus.lastAttemptAtMs,
    lastSuccessAtMs: reviewStatus.lastSuccessAtMs,
    lastError: reviewStatus.lastError,
    collectionReview: reviewStatus.collectionReviews,
    experienceReview: reviewStatus.experienceReviews,
    counts: { active: skills.length, stale: 0, archived: 0 },
    skills,
    overlaps: [],
  };
}

async function recordSkillUsage(
  event: Pick<DiagnosticSkillUsedEvent, "agentId" | "skillName" | "skillSource" | "ts"> & {
    skillFile?: string;
  },
  context: OpenClawStateWorkerContext,
): Promise<void> {
  const rawSkillFile = event.skillFile?.trim();
  // File identity prevents a same-named skill in another workspace from inheriting usage.
  if (!rawSkillFile || !path.isAbsolute(rawSkillFile)) {
    log.debug(`skipping skill usage without file identity: ${event.skillName}`);
    return;
  }
  const skillFile = canonicalizePath(path.resolve(rawSkillFile));
  const skillKey = canonicalSkillKey(event.skillName);
  const { executeOpenClawStateWorker } = await import("../../state/openclaw-state-worker-store.js");
  await executeOpenClawStateWorker(context, {
    type: "skills.usage.record",
    input: { ...event, skillFile, skillKey },
  });
}

/** Listener failures must never propagate into the tool execution that emitted usage. */
export function registerSkillUsageTracking(
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> = {},
): () => Promise<void> {
  const context = captureOpenClawStateWorkerContext(options);
  const work = new AsyncWorkScope();
  let closing: Promise<void> | undefined;
  const unregister = onTrustedInternalDiagnosticEvent(
    (event, metadata, privateData) => {
      if (closing || !metadata.trusted || event.type !== "skill.used") {
        return;
      }
      void work.track(async () => {
        try {
          await recordSkillUsage(
            { ...event, skillFile: privateData.skillUsage?.skillFile },
            context,
          );
        } catch (error) {
          log.warn(`failed to record skill usage: ${String(error)}`);
        }
      });
    },
    { include: ["skill.used"] },
  );
  return () => {
    unregister();
    // Stop acceptance first; closing the scope must not cancel accepted persistence.
    return (closing ??= AsyncWorkScope.runWhenAllIdle(
      () => [work],
      () => work.drain(),
    ));
  };
}
