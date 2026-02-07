/**
 * Experiential reconstitution hook
 *
 * Injects experiential context at session start for continuity across sessions.
 * Opt-in: requires hooks.internal.entries.experiential-reconstitution.enabled = true.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_EXISTENCE_FILENAME } from "../../../agents/workspace.js";
import {
  buildReconstitutionContext,
  determineDepth,
} from "../../../experiential/reconstitution.js";
import { ExperientialStore } from "../../../experiential/store.js";
import { isSubagentSessionKey } from "../../../routing/session-key.js";
import { resolveHookConfig } from "../../config.js";
import { isAgentBootstrapEvent, type HookHandler } from "../../hooks.js";

const HOOK_KEY = "experiential-reconstitution";
const EXISTENCE_FILENAME = DEFAULT_EXISTENCE_FILENAME;

const reconstitutionHook: HookHandler = async (event) => {
  if (!isAgentBootstrapEvent(event)) {
    return;
  }

  const context = event.context;

  // Skip subagent sessions
  if (context.sessionKey && isSubagentSessionKey(context.sessionKey)) {
    return;
  }

  const cfg = context.cfg;
  const hookConfig = resolveHookConfig(cfg, HOOK_KEY);

  // Opt-in: skip unless explicitly enabled
  if (!hookConfig || hookConfig.enabled !== true) {
    return;
  }

  try {
    const store = new ExperientialStore();
    try {
      const summaries = store.getRecentSummaries(3);
      const checkpoints = store.getRecentCheckpoints(2);
      const moments = store.getRecentMoments(5, 0.6);

      // Determine depth based on most recent activity
      const lastActivity =
        summaries.length > 0
          ? summaries[0].endedAt
          : checkpoints.length > 0
            ? checkpoints[0].timestamp
            : null;

      const depth = determineDepth(lastActivity);
      const content = buildReconstitutionContext({ depth, summaries, checkpoints, moments });

      // Write EXISTENCE.md to workspace
      const workspaceDir = context.workspaceDir;
      if (workspaceDir) {
        const existencePath = path.join(workspaceDir, EXISTENCE_FILENAME);
        await fs.writeFile(existencePath, content, "utf-8");
        console.log(`[experiential-reconstitution] Wrote ${EXISTENCE_FILENAME} (depth: ${depth})`);

        // Add to bootstrap files if not already present
        if (Array.isArray(context.bootstrapFiles)) {
          const existing = context.bootstrapFiles.find((f) => f.name === EXISTENCE_FILENAME);
          if (existing) {
            existing.content = content;
            existing.missing = false;
          } else {
            context.bootstrapFiles.push({
              name: EXISTENCE_FILENAME,
              path: existencePath,
              content,
              missing: false,
            });
          }
        }
      }
    } finally {
      store.close();
    }
  } catch (err) {
    console.error(
      "[experiential-reconstitution] Failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
};

export default reconstitutionHook;
