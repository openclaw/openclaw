import fs from "node:fs/promises";
import path from "node:path";
import { resolveDefaultModelForAgent } from "../../agents/model-selection-config.js";
import { resolveSandboxConfigForAgent } from "../../agents/sandbox/config.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import { canonicalizePath } from "../../agents/utils/paths.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadCronJobsStore } from "../../cron/store.js";
import { resolveCronJobsStorePathFromConfig } from "../../cron/store/paths.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { WorkshopChange } from "./changes.kernel.js";
import { resolveSkillWorkshopConfig } from "./config.js";
import {
  archiveWorkshopSkill,
  listWorkshopChanges,
  listWorkshopSkills,
  WorkshopWriteError,
} from "./library.js";
import { isSkillUsageTracked, readSkillUsage } from "./skill-usage.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";

const log = createSubsystemLogger("skills/workshop");

const UNUSED_ARCHIVE_MS = 30 * 24 * 60 * 60_000;
const UNUSED_ARCHIVE_REASON = "unused for 30 days";
// listWorkshopChanges caps at the feed's per-agent retention.
const CHANGE_FEED_LIMIT = 500;

/** Every scheduled job's payload text, including paused jobs; a job may run less than monthly. */
async function readCronPayloadText(config: OpenClawConfig): Promise<string> {
  const store = await loadCronJobsStore(resolveCronJobsStorePathFromConfig(config));
  return store.jobs.map((job) => JSON.stringify(job.payload ?? {})).join("\n");
}

function mentionsSkill(text: string, name: string): boolean {
  return new RegExp(`(?<![a-z0-9-])${name}(?![a-z0-9-])`).test(text);
}

/**
 * Archives an agent's learned skills with no activity for 30 days. Activity is the latest of:
 * recorded use (a file read or a foreground skill_workshop view, via skill_usage), the skill's
 * last change row, and its files' mtime/ctime. ctime never predates the file, so a skill copied
 * in with old mtimes still counts as young. A skill named in any cron job is kept: scheduled
 * work can run less often than the cutoff. Archive is the normal versioned, undoable archive.
 */
export async function archiveUnusedWorkshopSkills(
  config: OpenClawConfig,
  agentId: string,
  nowMs = Date.now(),
): Promise<WorkshopChange[]> {
  // Fail closed where reads go unrecorded: only the Gateway persists skill.used, and only the
  // embedded openclaw harness reports SKILL.md reads (its read tool runs the before-tool-call
  // wrapper; Code Mode `skills.read` reports through the same owner). Codex app-server reads
  // skills through its native shell; the native hook relay never matches those reads to a
  // skill, so only foreground skill_workshop views would count there, and every skill read
  // with `cat` would look unused. Sandboxed runs read skills from paths rewritten by sandbox
  // preparation, so their recorded usage never matches the workshop path looked up here.
  // Accepted risk: an `exec` shell read (`cat SKILL.md`) on the openclaw harness is not
  // recorded either; archive is versioned and undoable.
  if (!isSkillUsageTracked() || resolveSandboxConfigForAgent(config, agentId).mode !== "off") {
    return [];
  }
  const model = resolveDefaultModelForAgent({ cfg: config, agentId });
  const runtime = resolveEffectiveAgentRuntime({
    cfg: config,
    provider: model.provider,
    modelId: model.model,
    agentId,
  });
  if (runtime !== "openclaw") {
    return [];
  }
  const skills = await listWorkshopSkills(config, agentId);
  if (skills.length === 0) {
    return [];
  }
  const root = resolveWorkshopSkillsDir(config, agentId);
  const entries = skills.map((skill) => ({
    skill,
    skillFile: canonicalizePath(path.join(root, skill.name, "SKILL.md")),
  }));
  const [usage, changes, cronText] = await Promise.all([
    readSkillUsage(
      {},
      entries.map((entry) => entry.skillFile),
    ),
    listWorkshopChanges(agentId, { limit: CHANGE_FEED_LIMIT }),
    readCronPayloadText(config),
  ]);
  // The feed is newest first, so the first row per skill is its last change.
  const lastChangeMs = new Map<string, number>();
  for (const change of changes) {
    if (!lastChangeMs.has(change.skillName)) {
      lastChangeMs.set(change.skillName, change.createdAtMs);
    }
  }
  const cutoffMs = nowMs - UNUSED_ARCHIVE_MS;
  const archived: WorkshopChange[] = [];
  // The pass was admitted under the turn's config; the operator may switch Learning Off since.
  const learningOn = () =>
    resolveSkillWorkshopConfig(getRuntimeConfig()).autonomous.mode === "auto";
  const assertLive = () => {
    if (!learningOn()) {
      throw new WorkshopWriteError("Learning is off.");
    }
  };
  for (const { skill, skillFile } of entries) {
    const stat = await fs.stat(skillFile).catch(() => undefined);
    const lastActivityMs = Math.max(
      skill.updatedAtMs,
      stat ? Math.max(stat.mtimeMs, stat.ctimeMs) : nowMs,
      lastChangeMs.get(skill.name) ?? 0,
      usage.get(skillFile)?.lastUsedAtMs ?? 0,
    );
    if (lastActivityMs > cutoffMs || mentionsSkill(cronText, skill.name)) {
      continue;
    }
    if (!learningOn()) {
      break;
    }
    try {
      archived.push(
        await archiveWorkshopSkill(
          { config, agentId, actor: "curator", assertLive },
          { name: skill.name, reason: UNUSED_ARCHIVE_REASON },
        ),
      );
    } catch (error) {
      log.warn(`unused skill archive failed: skill=${skill.name} ${formatErrorMessage(error)}`);
    }
  }
  return archived;
}
