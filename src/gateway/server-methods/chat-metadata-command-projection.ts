import { formatErrorMessage } from "../../infra/errors.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { resolveSessionSkillWorkspaceDir } from "../../skills/loading/workspace-skill-roots.js";
import type { ChatMetadataReadParams, ChatMetadataSessionEntry } from "./chat-metadata-contract.js";
import type { ChatMetadataRuntimeDeps } from "./chat-metadata-facts.js";

export type CommandProjectionEntry =
  | { state: "pending"; promise: Promise<unknown[] | undefined> }
  | { state: "ready"; commands: unknown[] | undefined };

export function commandProjectionKey(params: ChatMetadataReadParams): string {
  const entry = params.sessionEntry;
  return JSON.stringify([
    normalizeAgentId(params.agentId),
    params.sessionKey,
    entry?.sessionId,
    entry?.lifecycleRevision,
    resolveSessionSkillWorkspaceDir(entry),
    entry?.skillLibrarySelections,
    entry?.execHost,
    entry?.execNode,
    entry?.execCwd,
    entry?.permissionMode,
    entry?.sandbox,
  ]);
}

/** Command preparation retains skill inputs, never a session row or its read authority. */
function projectChatCommandSessionEntry(entry: ChatMetadataSessionEntry) {
  return {
    worktree: entry.worktree,
    spawnedCwd: entry.spawnedCwd,
    spawnedWorkspaceDir: entry.spawnedWorkspaceDir,
    skillLibrarySelections: entry.skillLibrarySelections,
    execHost: entry.execHost,
    execNode: entry.execNode,
    execCwd: entry.execCwd,
    permissionMode: entry.permissionMode,
    sandbox: entry.sandbox,
  };
}

/** The metadata generation owns this cache and retires all entries together. */
export function prepareChatCommandProjection(params: {
  entries: Map<string, CommandProjectionEntry>;
  config: Parameters<ChatMetadataRuntimeDeps["buildCommands"]>[0]["cfg"];
  readParams: ChatMetadataReadParams;
  buildCommands: ChatMetadataRuntimeDeps["buildCommands"];
  isCurrent: () => boolean;
  maxEntries: number;
  log: { warn: (message: string) => void };
}): Promise<unknown[] | undefined> {
  const { entries, readParams, buildCommands } = params;
  const key = commandProjectionKey(readParams);
  const cached = entries.get(key);
  if (cached) {
    return cached.state === "ready" ? Promise.resolve(cached.commands) : cached.promise;
  }
  const promise = buildCommands({
    cfg: params.config,
    agentId: normalizeAgentId(readParams.agentId),
    ...(readParams.sessionKey ? { sessionKey: readParams.sessionKey } : {}),
    ...(readParams.sessionEntry
      ? { sessionEntry: projectChatCommandSessionEntry(readParams.sessionEntry) }
      : {}),
  })
    .then(
      ({ commands }) => commands,
      (error: unknown) => {
        params.log.warn(
          `chat metadata continuing without text commands for ${readParams.agentId}: ${formatErrorMessage(error)}`,
        );
        return undefined;
      },
    )
    .then((commands) => {
      if (params.isCurrent() && entries.get(key) === entry) {
        entries.set(key, { state: "ready", commands });
      }
      return commands;
    });
  const entry: CommandProjectionEntry = { state: "pending", promise };
  entries.set(key, entry);
  pruneMapToMaxSize(entries, params.maxEntries);
  return promise;
}
