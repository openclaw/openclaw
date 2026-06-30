/**
 * CLI command for `openclaw memory backfill --agent <id>` (Phase 4, 04-03). Drives the two
 * resumable backfill stages (04-02) in one foreground invocation: stage 1 seeds the agent's
 * historical transcripts into the durable `turns` store, stage 2 organizes them into
 * navigable spans/boxes/tags/entities. Both stages resume from their own cursor, so an
 * interrupted run continues without redoing finished work — the command itself stays
 * stateless. Per-agent and opt-in: it targets exactly the one operator-named agent and runs
 * only via this explicit CLI entry — never wired into any automatic/background flow, so the
 * heavy batch stays off the hot path (D-01/D-04).
 */
import { withEnv } from "../agents/memory/backfill-cursor.js";
import { runBackfillOrganize } from "../agents/memory/backfill-organize.js";
import { runBackfillSeed } from "../agents/memory/backfill-seed.js";
import { isValidAgentId, normalizeAgentId } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

export type MemoryBackfillCommandOptions = {
  agent?: string;
  json?: boolean;
  // Test seams (not exposed as CLI flags): isolate the per-agent DB and inject the
  // transcripts dir so the command can run end-to-end without a real home dir.
  env?: NodeJS.ProcessEnv;
  transcriptsDir?: string;
};

/**
 * Validate the operator-supplied agent id with the canonical `isValidAgentId` (VALID_ID_RE),
 * then return its normalized form. Rejecting up front with the same predicate the rest of the
 * system uses means a malformed id (leading `_`/`-`, path traversal like `../other`, embedded
 * dots) never reaches path/DB resolution (V5 — no traversal before path resolution); we do NOT
 * let `normalizeAgentId` silently coerce a bad id into a different agent's data.
 */
function resolveCommandAgentId(raw: string | undefined, runtime: RuntimeEnv): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    runtime.error("--agent <id> is required.");
    runtime.exit(1);
    return null;
  }
  if (!isValidAgentId(trimmed)) {
    runtime.error(`Invalid --agent id: ${trimmed}`);
    runtime.exit(1);
    return null;
  }
  return normalizeAgentId(trimmed);
}

export async function runMemoryBackfillCommand(
  options: MemoryBackfillCommandOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const agentId = resolveCommandAgentId(options.agent, runtime);
  if (agentId == null) {
    return;
  }
  const env = options.env;

  if (!options.json) {
    runtime.log(`Backfilling memory for agent "${agentId}" (session agent:${agentId}:main)`);
  }

  // Stage 1: seed (resumes from its file cursor).
  const seed = runBackfillSeed({
    agentId,
    ...withEnv(env),
    ...(options.transcriptsDir ? { transcriptsDir: options.transcriptsDir } : {}),
  });
  if (!options.json) {
    runtime.log(
      `Seed: ${seed.filesProcessed} file(s) processed, ${seed.filesSkipped} skipped, ${seed.inserted} new turn(s).`,
    );
    for (const warning of seed.warnings) {
      runtime.log(`Warning: ${warning}`);
    }
  }

  // Stage 2: organize (resumes from its own cursor; idempotent upserts).
  const organize = runBackfillOrganize({ agentId, ...withEnv(env) });
  if (!options.json) {
    runtime.log(`Organize: ${organize.boxes} box(es), ${organize.spans} span(s).`);
    runtime.log("Backfill complete.");
    return;
  }

  writeRuntimeJson(runtime, { agentId, sessionKey: seed.sessionKey, seed, organize });
}
