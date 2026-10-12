import path from "node:path";
import { canonicalizePath } from "../../agents/utils/paths.js";
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

const log = createSubsystemLogger("skills/usage");

/** Usage counters keyed by the canonical absolute SKILL.md path. */
export async function readSkillUsage(
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env">,
  skillFiles: readonly string[],
): Promise<Map<string, { useCount: number; lastUsedAtMs: number }>> {
  const canonicalFiles = [...new Set(skillFiles.map((file) => canonicalizePath(file)))];
  const usage = new Map<string, { useCount: number; lastUsedAtMs: number }>();
  if (canonicalFiles.length === 0) {
    return usage;
  }
  const context = captureOpenClawStateWorkerContext(options);
  const { executeOpenClawStateWorker } = await import("../../state/openclaw-state-worker-store.js");
  const rows = await executeOpenClawStateWorker(context, {
    type: "skills.usage.read",
    input: { skillFiles: canonicalFiles },
  });
  for (const row of rows) {
    usage.set(row.skillFile, { useCount: row.useCount, lastUsedAtMs: row.lastUsedAtMs });
  }
  return usage;
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
  const skillKey = normalizeSkillIndexName(event.skillName);
  if (!skillKey) {
    throw new Error(`Invalid skill name: ${event.skillName}`);
  }
  const { executeOpenClawStateWorker } = await import("../../state/openclaw-state-worker-store.js");
  await executeOpenClawStateWorker(context, {
    type: "skills.usage.record",
    input: { ...event, skillFile, skillKey },
  });
}

let activeTrackers = 0;

/** True while this process persists skill.used events (the Gateway registers the listener). */
export function isSkillUsageTracked(): boolean {
  return activeTrackers > 0;
}

/** Listener failures must never propagate into the tool execution that emitted usage. */
export function registerSkillUsageTracking(
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> = {},
): () => Promise<void> {
  const context = captureOpenClawStateWorkerContext(options);
  const work = new AsyncWorkScope();
  activeTrackers += 1;
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
    if (!closing) {
      activeTrackers -= 1;
    }
    unregister();
    // Stop acceptance first; closing the scope must not cancel accepted persistence.
    return (closing ??= AsyncWorkScope.runWhenAllIdle(
      () => [work],
      () => work.drain(),
    ));
  };
}
