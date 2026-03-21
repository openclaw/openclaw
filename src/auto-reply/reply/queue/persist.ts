import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../../config/paths.js";
import { defaultRuntime } from "../../../runtime.js";
import { FOLLOWUP_QUEUES } from "./state.js";
import type { FollowupRun } from "./types.js";

const PENDING_FOLLOWUPS_FILENAME = "pending-followups.json";

/**
 * Serializable subset of FollowupRun for persistence across restarts.
 * We strip non-serializable fields (config is large but JSON-safe;
 * skillsSnapshot and inputProvenance may not be — omit and let
 * replay reconstruct from fresh config).
 */
export type PersistedFollowupItem = {
  prompt: string;
  messageId?: string;
  summaryLine?: string;
  enqueuedAt: number;
  originatingChannel?: string;
  originatingTo?: string;
  originatingAccountId?: string;
  originatingThreadId?: string | number;
  originatingChatType?: string;
  sessionKey?: string;
  senderId?: string;
  senderName?: string;
  senderUsername?: string;
  senderE164?: string;
  senderIsOwner?: boolean;
  agentId?: string;
  messageProvider?: string;
  groupId?: string;
  groupChannel?: string;
  groupSpace?: string;
};

export type PersistedFollowupQueue = {
  queueKey: string;
  items: PersistedFollowupItem[];
};

export type PersistedFollowupsFile = {
  version: 1;
  persistedAt: string;
  queues: PersistedFollowupQueue[];
};

function resolvePersistedFollowupsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), PENDING_FOLLOWUPS_FILENAME);
}

function toPersistedItem(run: FollowupRun): PersistedFollowupItem {
  return {
    prompt: run.prompt,
    messageId: run.messageId,
    summaryLine: run.summaryLine,
    enqueuedAt: run.enqueuedAt,
    originatingChannel: run.originatingChannel,
    originatingTo: run.originatingTo,
    originatingAccountId: run.originatingAccountId,
    originatingThreadId: run.originatingThreadId,
    originatingChatType: run.originatingChatType,
    sessionKey: run.run.sessionKey,
    senderId: run.run.senderId,
    senderName: run.run.senderName,
    senderUsername: run.run.senderUsername,
    senderE164: run.run.senderE164,
    senderIsOwner: run.run.senderIsOwner,
    agentId: run.run.agentId,
    messageProvider: run.run.messageProvider,
    groupId: run.run.groupId,
    groupChannel: run.run.groupChannel,
    groupSpace: run.run.groupSpace,
  };
}

/**
 * Persist all non-empty followup queues to disk.
 * Called during gateway shutdown before in-memory state is cleared.
 */
export async function persistFollowupQueues(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const queues: PersistedFollowupQueue[] = [];
  let totalItems = 0;

  for (const [queueKey, state] of FOLLOWUP_QUEUES.entries()) {
    if (state.items.length === 0) {
      continue;
    }
    const items = state.items.map(toPersistedItem);
    queues.push({ queueKey, items });
    totalItems += items.length;
  }

  if (totalItems === 0) {
    try {
      await fs.unlink(resolvePersistedFollowupsPath(env));
    } catch {
      /* file may not exist */
    }
    return 0;
  }

  const filePath = resolvePersistedFollowupsPath(env);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const data: PersistedFollowupsFile = {
    version: 1,
    persistedAt: new Date().toISOString(),
    queues,
  };
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  defaultRuntime.info?.(
    `Persisted ${totalItems} followup queue item(s) across ${queues.length} queue(s)`,
  );
  return totalItems;
}

/**
 * Read and consume persisted followup items.
 * Returns the items grouped by queue key for replay, then deletes the file.
 */
export async function consumePersistedFollowups(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PersistedFollowupQueue[]> {
  const filePath = resolvePersistedFollowupsPath(env);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  let parsed: PersistedFollowupsFile;
  try {
    parsed = JSON.parse(raw) as PersistedFollowupsFile;
  } catch {
    await fs.unlink(filePath).catch(() => {});
    return [];
  }

  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.queues)) {
    await fs.unlink(filePath).catch(() => {});
    return [];
  }

  await fs.unlink(filePath).catch(() => {});

  const totalItems = parsed.queues.reduce((sum, q) => sum + q.items.length, 0);
  if (totalItems > 0) {
    defaultRuntime.info?.(
      `Consumed ${totalItems} persisted followup item(s) from ${parsed.queues.length} queue(s)`,
    );
  }

  return parsed.queues;
}
