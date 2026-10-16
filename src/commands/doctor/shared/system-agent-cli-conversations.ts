// Finds a system agent's stored CLI-backend conversations and carries Claude CLI ones to a new
// working directory, so a Doctor workspace pin does not restart them.
import fs from "node:fs";
import path from "node:path";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { hashCliSessionText } from "../../../agents/cli-session.js";
import { resolveClaudeCliProjectDirForWorkspace } from "../../../agents/command/claude-cli-project-dir.js";
import { getCliSessionBinding } from "../../../config/sessions/cli-session-binding.js";
import {
  patchSessionEntryCore,
  scanDoctorSessionEntriesTolerant,
} from "../../../config/sessions/session-accessor.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../../../config/sessions/targets.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { hasErrnoCode } from "../../../infra/errno.js";
import { loadLegacySessionStore } from "../../../infra/state-migrations.legacy-session-store.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import { parseAgentSessionKey } from "../../../sessions/session-key-utils.js";

const CLAUDE_CLI = "claude-cli";

export type StoredCliConversation = {
  scope: { agentId: string; env: NodeJS.ProcessEnv; storePath: string; sessionKey: string };
  /** Backends holding a native conversation for this session. */
  providers: string[];
  /** Native Claude CLI session ids, from the binding, the id map, or the legacy field. */
  claudeSessionIds: string[];
  /** Working directory hash the Claude CLI binding recorded, when it recorded one. */
  claudeCwdHash?: string;
  /** Read from a legacy sessions.json store, which this repair does not rewrite. */
  legacyStore: boolean;
};

function isSafeClaudeSessionId(id: string | undefined): id is string {
  return id !== undefined && id !== "." && id !== ".." && !/[\0/\\]/.test(id);
}

function describeConversation(entry: SessionEntry) {
  const providers = [
    ...Object.keys(entry.cliSessionBindings ?? {}),
    ...Object.keys(entry.cliSessionIds ?? {}),
  ].filter((provider) => getCliSessionBinding(entry, provider));
  const legacyClaudeId = normalizeOptionalString(entry.claudeCliSessionId);
  if (legacyClaudeId !== undefined) {
    providers.push(CLAUDE_CLI);
  }
  const claudeBinding = getCliSessionBinding(entry, CLAUDE_CLI);
  const claudeSessionIds = [claudeBinding?.sessionId, legacyClaudeId];
  const claudeCwdHash = normalizeOptionalString(claudeBinding?.cwdHash);
  return {
    providers: [...new Set(providers.map(normalizeProviderId))],
    claudeSessionIds: [...new Set(claudeSessionIds.filter((id) => id !== undefined))],
    ...(claudeCwdHash !== undefined ? { claudeCwdHash } : {}),
  };
}

/**
 * Lists the agent's stored sessions bound to a CLI-backend conversation. The binding records the
 * working directory it started in, so changing that directory starts a new native conversation
 * unless the conversation is carried along.
 */
export function listStoredCliConversations(
  cfg: OpenClawConfig,
  agentId: string,
  env: NodeJS.ProcessEnv,
): StoredCliConversation[] {
  const conversations = new Map<string, StoredCliConversation>();
  const visit = (
    sessionKey: string,
    entry: SessionEntry,
    target: { agentId: string; storePath: string },
    legacyStore: boolean,
  ) => {
    const owner = parseAgentSessionKey(sessionKey)?.agentId ?? target.agentId;
    if (normalizeAgentId(owner) !== agentId) {
      return;
    }
    const { providers, ...claude } = describeConversation(entry);
    if (providers.length > 0 && !conversations.get(sessionKey)?.legacyStore) {
      conversations.set(sessionKey, {
        scope: { agentId: target.agentId, env, storePath: target.storePath, sessionKey },
        providers,
        ...claude,
        legacyStore,
      });
    }
  };
  for (const target of resolveAllAgentSessionStoreTargetsSync(cfg, { env })) {
    scanDoctorSessionEntriesTolerant(
      { agentId: target.agentId, env, storePath: target.storePath },
      ({ entry, sessionKey }) => visit(sessionKey, entry, target, false),
    );
    if (!target.storePath.endsWith(".sqlite") && fs.existsSync(target.storePath)) {
      for (const [sessionKey, entry] of Object.entries(loadLegacySessionStore(target.storePath))) {
        if (entry && typeof entry === "object") {
          visit(sessionKey, entry, target, true);
        }
      }
    }
  }
  return [...conversations.values()];
}

type TranscriptCopy = "absent" | "copy" | "current" | "diverged";

/** Undefined when missing; `link` reports a symbolic link itself instead of its target. */
function statIfExists(file: string, link = false): fs.Stats | undefined {
  try {
    return link ? fs.lstatSync(file) : fs.statSync(file);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

/** True when the first `length` bytes of both files match, read a chunk at a time. */
function sameHead(a: string, b: string, length: number): boolean {
  const fdA = fs.openSync(a, "r");
  try {
    const fdB = fs.openSync(b, "r");
    try {
      const chunkA = Buffer.alloc(64 * 1024);
      const chunkB = Buffer.alloc(chunkA.length);
      for (let offset = 0; offset < length; offset += chunkA.length) {
        const size = Math.min(chunkA.length, length - offset);
        const readA = fs.readSync(fdA, chunkA, 0, size, offset);
        const readB = fs.readSync(fdB, chunkB, 0, size, offset);
        if (
          readA !== size ||
          readB !== size ||
          !chunkA.subarray(0, size).equals(chunkB.subarray(0, size))
        ) {
          return false;
        }
      }
      return true;
    } finally {
      fs.closeSync(fdB);
    }
  } finally {
    fs.closeSync(fdA);
  }
}

/**
 * Compares `<id>.jsonl` in both Claude project folders. A target that is a prefix of the source
 * (an earlier copy the conversation has since grown past) is refreshed; a target with turns the
 * source lacks, or that is not a regular file, has diverged and is never overwritten.
 */
function planTranscriptCopy(fromProject: string, toProject: string, id: string): TranscriptCopy {
  const source = path.join(fromProject, `${id}.jsonl`);
  const target = path.join(toProject, `${id}.jsonl`);
  const sourceStat = statIfExists(source);
  if (!sourceStat?.isFile()) {
    return "absent";
  }
  const targetStat = statIfExists(target, true);
  if (targetStat === undefined) {
    return "copy";
  }
  if (
    !targetStat.isFile() ||
    targetStat.size > sourceStat.size ||
    !sameHead(source, target, targetStat.size)
  ) {
    return "diverged";
  }
  return targetStat.size === sourceStat.size ? "current" : "copy";
}

function claudeProjects(from: string, to: string, env: NodeJS.ProcessEnv) {
  const homeDir = normalizeOptionalString(env.HOME);
  return {
    fromProject: resolveClaudeCliProjectDirForWorkspace({ workspaceDir: from, homeDir }),
    toProject: resolveClaudeCliProjectDirForWorkspace({ workspaceDir: to, homeDir }),
  };
}

/**
 * A Claude CLI binding recorded in another directory already starts fresh in `dir`, so moving
 * away from `dir` changes nothing for it.
 */
export function cliConversationResumesIn(
  conversation: StoredCliConversation,
  dir: string,
): boolean {
  return (
    conversation.claudeCwdHash === undefined ||
    !conversation.providers.every((provider) => provider === CLAUDE_CLI) ||
    conversation.claudeCwdHash === hashCliSessionText(dir)
  );
}

/**
 * Only Claude CLI conversations in the SQLite store can be carried, and only when each transcript
 * is in the Claude project folder of `from` and any copy already in `to` holds nothing it lacks.
 * A transcript Doctor cannot read is not carried.
 */
export function canCarryCliConversation(
  conversation: StoredCliConversation,
  from: string,
  to: string,
  env: NodeJS.ProcessEnv,
): boolean {
  if (
    conversation.legacyStore ||
    normalizeOptionalString(env.HOME) === undefined ||
    !conversation.providers.every((provider) => provider === CLAUDE_CLI) ||
    !conversation.claudeSessionIds.every(isSafeClaudeSessionId)
  ) {
    return false;
  }
  const { fromProject, toProject } = claudeProjects(from, to, env);
  try {
    return conversation.claudeSessionIds.every((id) => {
      const copy = planTranscriptCopy(fromProject, toProject, id);
      return copy !== "absent" && copy !== "diverged";
    });
  } catch {
    return false;
  }
}

async function clearClaudeBindingCwd(
  conversation: StoredCliConversation,
  fromHash: string | undefined,
): Promise<void> {
  await patchSessionEntryCore(
    conversation.scope,
    (entry) => {
      const key = Object.keys(entry.cliSessionBindings ?? {}).find(
        (provider) => normalizeProviderId(provider) === CLAUDE_CLI,
      );
      const binding = key ? entry.cliSessionBindings?.[key] : undefined;
      if (!key || !binding || binding.cwdHash !== fromHash) {
        return null;
      }
      const { cwdHash: _cwdHash, ...rest } = binding;
      return { cliSessionBindings: { ...entry.cliSessionBindings, [key]: rest } };
    },
    { preserveActivity: true, skipMaintenance: true },
  );
}

/**
 * Copies each conversation's Claude CLI transcript into the Claude project folder of `to` (the
 * originals stay in place), then drops the binding's recorded working directory. Both folders
 * then hold the transcript, so the next turn resumes the same native session in whichever
 * directory it runs, whether or not the workspace pin is published, and records that directory.
 */
export async function carryClaudeCliConversations(
  conversations: StoredCliConversation[],
  from: string,
  to: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const { fromProject, toProject } = claudeProjects(from, to, env);
  for (const conversation of conversations) {
    for (const sessionId of conversation.claudeSessionIds) {
      const copy = planTranscriptCopy(fromProject, toProject, sessionId);
      if (copy === "absent" || copy === "diverged") {
        throw new Error(`the transcript of Claude CLI session ${sessionId} changed during repair`);
      }
      await fs.promises.mkdir(toProject, { recursive: true });
      if (copy === "copy") {
        await fs.promises.copyFile(
          path.join(fromProject, `${sessionId}.jsonl`),
          path.join(toProject, `${sessionId}.jsonl`),
        );
      }
      // A sibling `<id>/` folder holds the transcript's tool results; existing files are kept.
      const results = path.join(fromProject, sessionId);
      if (statIfExists(path.join(toProject, sessionId), true)?.isSymbolicLink()) {
        throw new Error(
          `the tool results of Claude CLI session ${sessionId} would be written through a link`,
        );
      }
      if (fs.existsSync(results)) {
        await fs.promises.cp(results, path.join(toProject, sessionId), {
          recursive: true,
          force: false,
          errorOnExist: false,
        });
      }
    }
  }
  const fromHash = hashCliSessionText(from);
  for (const conversation of conversations) {
    await clearClaudeBindingCwd(conversation, fromHash);
  }
}
