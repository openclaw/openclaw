import path from "node:path";
import type { SkillsCuratorLiveStatusResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { listAgentIds } from "../../agents/agent-scope-config.js";
import { canonicalizePath } from "../../agents/utils/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  onTrustedInternalDiagnosticEvent,
  type DiagnosticSkillUsedEvent,
} from "../../infra/diagnostic-events.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { DB as OpenClawStateDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { normalizeSkillIndexName } from "../discovery/skill-index.js";
import { readSkillCuratorReviewStatus } from "./collection-review-state.js";
import { parseSkillProposalRow } from "./store-sqlite-record.js";
import {
  listWritableWorkshopSkillSummaries,
  type WritableWorkshopSkillSummary,
} from "./workspace-skill-read.js";

const log = createSubsystemLogger("skills/curator");

export const SKILL_LIFECYCLE_CURATION_RETIRED_MESSAGE =
  "Skill lifecycle curation is retired. The weekly collection review manages the skill collection; pin, unpin, and restore no longer exist.";

type CuratorDatabase = Pick<OpenClawStateDatabase, "skill_usage" | "skill_workshop_proposals">;

function curatorDb(options: OpenClawStateDatabaseOptions = {}) {
  const database = openOpenClawStateDatabase(options);
  return { database, kysely: getNodeSqliteKysely<CuratorDatabase>(database.db) };
}

function canonicalSkillKey(name: string): string {
  const key = normalizeSkillIndexName(name);
  if (!key) {
    throw new Error(`Invalid skill name: ${name}`);
  }
  return key;
}

export function getSkillCuratorStatus(
  options: OpenClawStateDatabaseOptions & { config: OpenClawConfig },
): SkillsCuratorLiveStatusResult {
  const { database, kysely } = curatorDb(options);
  const reviewStatus = readSkillCuratorReviewStatus(options);
  const proposalRows = executeSqliteQuerySync(
    database.db,
    kysely
      .selectFrom("skill_workshop_proposals")
      .selectAll()
      .where("kind", "=", "create")
      .where("status", "=", "applied")
      .orderBy("applied_at", "asc")
      .orderBy("proposal_id", "asc"),
  ).rows;
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
  const usageRows = curatedByFile.size
    ? executeSqliteQuerySync(
        database.db,
        kysely
          .selectFrom("skill_usage")
          .select(["skill_file", "last_used_at_ms", "use_count"])
          .where("skill_file", "in", [...curatedByFile.keys()]),
      ).rows
    : [];
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

function recordSkillUsage(
  event: Pick<DiagnosticSkillUsedEvent, "agentId" | "skillName" | "skillSource" | "ts"> & {
    skillFile?: string;
  },
  options: OpenClawStateDatabaseOptions = {},
): void {
  const rawSkillFile = event.skillFile?.trim();
  // File identity prevents a same-named skill in another workspace from inheriting usage.
  if (!rawSkillFile || !path.isAbsolute(rawSkillFile)) {
    log.debug(`skipping skill usage without file identity: ${event.skillName}`);
    return;
  }
  const skillFile = canonicalizePath(path.resolve(rawSkillFile));
  const skillKey = canonicalSkillKey(event.skillName);
  runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = getNodeSqliteKysely<CuratorDatabase>(db);
    executeSqliteQuerySync(
      db,
      kysely
        .insertInto("skill_usage")
        .values({
          skill_file: skillFile,
          skill_key: skillKey,
          skill_name: event.skillName,
          skill_source: event.skillSource,
          first_used_at_ms: event.ts,
          last_used_at_ms: event.ts,
          use_count: 1,
          last_agent_id: event.agentId ?? null,
        })
        .onConflict((conflict) =>
          conflict.column("skill_file").doUpdateSet((eb) => ({
            skill_key: skillKey,
            skill_name: event.skillName,
            skill_source: event.skillSource,
            first_used_at_ms: eb.fn<number>("min", [eb.ref("first_used_at_ms"), eb.val(event.ts)]),
            last_used_at_ms: eb.fn<number>("max", [eb.ref("last_used_at_ms"), eb.val(event.ts)]),
            use_count: eb("use_count", "+", 1),
            last_agent_id: eb
              .case()
              .when("last_used_at_ms", "<=", event.ts)
              .then(event.agentId ?? null)
              .else(eb.ref("last_agent_id"))
              .end(),
          })),
        ),
    );
  }, options);
}

/** Listener failures must never propagate into the tool execution that emitted usage. */
export function registerSkillUsageTracking(options: OpenClawStateDatabaseOptions = {}): () => void {
  return onTrustedInternalDiagnosticEvent(
    (event, metadata, privateData) => {
      if (!metadata.trusted || event.type !== "skill.used") {
        return;
      }
      try {
        recordSkillUsage({ ...event, skillFile: privateData.skillUsage?.skillFile }, options);
      } catch (error) {
        log.warn(`failed to record skill usage: ${String(error)}`);
      }
    },
    { include: ["skill.used"] },
  );
}
