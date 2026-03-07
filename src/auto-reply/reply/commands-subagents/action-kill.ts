import { abortEmbeddedPiRun } from "../../../agents/pi-embedded.js";
import { markSubagentRunTerminated } from "../../../agents/subagent-registry.js";
import {
  loadSessionStore,
  resolveStorePath,
  updateSessionStore,
} from "../../../config/sessions.js";
import { logVerbose } from "../../../globals.js";
import { stopSubagentsForRequester } from "../abort.js";
import type { CommandHandlerResult } from "../commands-types.js";
import { clearSessionQueues } from "../queue.js";
import { formatRunLabel } from "../subagents-utils.js";
import {
  type SubagentsCommandContext,
  COMMAND,
  loadSubagentSessionEntry,
  resolveSubagentEntryForToken,
  stopWithText,
} from "./shared.js";

export async function handleSubagentsKillAction(
  ctx: SubagentsCommandContext,
): Promise<CommandHandlerResult> {
  const { params, handledPrefix, requesterKey, runs, restTokens } = ctx;
  const target = restTokens[0];
  if (!target) {
    return stopWithText(
      handledPrefix === COMMAND ? "Usage: /subagents kill <id|#|all>" : "Usage: /kill <id|#|all>",
    );
  }

  if (target === "all" || target === "*") {
    stopSubagentsForRequester({
      cfg: params.cfg,
      requesterSessionKey: requesterKey,
    });
    return { shouldContinue: false };
  }

  const targetResolution = resolveSubagentEntryForToken(runs, target);
  if ("reply" in targetResolution) {
    return targetResolution.reply;
  }
  if (targetResolution.entry.endedAt) {
    return stopWithText(`${formatRunLabel(targetResolution.entry)} is already finished.`);
  }

  const childKey = targetResolution.entry.childSessionKey;
  const { storePath, store, entry } = loadSubagentSessionEntry(params, childKey, {
    loadSessionStore,
    resolveStorePath,
  });
  const sessionId = entry?.sessionId;
  if (sessionId) {
    abortEmbeddedPiRun(sessionId);
  }

  const cleared = clearSessionQueues([childKey, sessionId]);
  if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
    logVerbose(
      `subagents kill: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
    );
  }

  if (entry) {
    entry.abortedLastRun = true;
    entry.updatedAt = Date.now();
    store[childKey] = entry;
    await updateSessionStore(storePath, (nextStore) => {
      nextStore[childKey] = entry;
    });
  }

  markSubagentRunTerminated({
    runId: targetResolution.entry.runId,
    childSessionKey: childKey,
    reason: "killed",
  });

  stopSubagentsForRequester({
    cfg: params.cfg,
    requesterSessionKey: childKey,
  });

  return { shouldContinue: false };
}
