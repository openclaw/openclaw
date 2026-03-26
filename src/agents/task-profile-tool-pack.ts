import { resolveTaskProfile, type TaskProfileId } from "./task-profile.js";
import {
  mergeAlsoAllowPolicy,
  normalizeToolName,
  resolveToolProfilePolicy,
  type ToolPolicyLike,
} from "./tool-policy.js";

type ToolPackProfile = "minimal" | "coding" | "messaging" | "full";

export type TaskProfileToolPack = {
  taskProfile: TaskProfileId;
  toolProfile: ToolPackProfile;
  alsoAllow?: string[];
  policy?: ToolPolicyLike;
  signal?: string;
};

const TASK_PROFILE_TOOL_PACKS: Record<
  TaskProfileId,
  { toolProfile: ToolPackProfile; alsoAllow?: string[] }
> = {
  coding: {
    toolProfile: "coding",
  },
  research: {
    toolProfile: "minimal",
    alsoAllow: [
      "read",
      "web_search",
      "web_fetch",
      "browser",
      "memory_search",
      "memory_get",
      "image",
    ],
  },
  ops: {
    toolProfile: "minimal",
    alsoAllow: [
      "read",
      "exec",
      "process",
      "gateway",
      "cron",
      "nodes",
      "sessions_list",
      "sessions_history",
      "memory_search",
      "memory_get",
      "web_fetch",
    ],
  },
  assistant: {
    toolProfile: "minimal",
    alsoAllow: [
      "read",
      "message",
      "sessions_send",
      "web_search",
      "web_fetch",
      "memory_search",
      "memory_get",
    ],
  },
};

export function resolveTaskProfileToolPack(params: {
  promptText?: string;
  sessionKey?: string;
  workspaceDir?: string;
}): TaskProfileToolPack {
  const resolvedTaskProfile = resolveTaskProfile({
    promptText: params.promptText,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    tools: [],
  });
  const taskProfile = resolvedTaskProfile.id;
  const resolvedPack = TASK_PROFILE_TOOL_PACKS[taskProfile];
  const basePolicy = resolveToolProfilePolicy(resolvedPack.toolProfile);
  return {
    taskProfile,
    toolProfile: resolvedPack.toolProfile,
    ...(resolvedPack.alsoAllow ? { alsoAllow: [...resolvedPack.alsoAllow] } : {}),
    policy: mergeAlsoAllowPolicy(basePolicy, resolvedPack.alsoAllow) ?? basePolicy,
    ...(resolvedTaskProfile.signal ? { signal: resolvedTaskProfile.signal } : {}),
  };
}

export function constrainTaskProfileToolPackToAvailableTools(
  pack: TaskProfileToolPack,
  availableToolNames: Iterable<string>,
): TaskProfileToolPack {
  const available = new Set(
    Array.from(availableToolNames, (name) => normalizeToolName(name)).filter(Boolean),
  );
  const filterAllowlist = (list?: string[]) =>
    list?.filter((entry) => entry === "*" || available.has(normalizeToolName(entry)));

  const nextAlsoAllow = filterAllowlist(pack.alsoAllow);
  const nextPolicy =
    pack.policy && (pack.policy.allow || pack.policy.deny)
      ? {
          ...pack.policy,
          allow: filterAllowlist(pack.policy.allow),
        }
      : pack.policy;

  return {
    ...pack,
    ...(nextAlsoAllow?.length ? { alsoAllow: nextAlsoAllow } : {}),
    ...(!nextAlsoAllow?.length && pack.alsoAllow ? { alsoAllow: undefined } : {}),
    ...(nextPolicy ? { policy: nextPolicy } : {}),
  };
}
