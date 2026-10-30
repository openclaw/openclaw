import fs from "node:fs";
import {
  normalizePromptCapabilityIds,
  SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END,
} from "@openclaw/ai/internal/shared";
import { parseCronRunScopeSuffix } from "../sessions/session-key-utils.js";
import { escapeRegExp } from "../shared/regexp.js";
import { sanitizeForPromptLiteral } from "./sanitize-for-prompt.js";
import type { SystemPromptRuntimeInfo } from "./system-prompt.types.js";

/** Stands in for a blind child's withheld agent workspace path. */
const BLIND_WORKSPACE_PLACEHOLDER = "<workspace>";

/** A blind child's Runtime facts omit its model, default model, agent, session and repository. */
export function blindRuntime(
  runtimeInfo: SystemPromptRuntimeInfo | undefined,
): SystemPromptRuntimeInfo | undefined {
  if (!runtimeInfo?.blind) {
    return runtimeInfo;
  }
  const {
    model: _model,
    defaultModel: _defaultModel,
    agentId: _agentId,
    agentName: _agentName,
    sessionKey: _sessionKey,
    sessionId: _sessionId,
    sessionUrl: _sessionUrl,
    repoRoot: _repoRoot,
    ...environment
  } = runtimeInfo;
  return environment;
}

function realpathOrUndefined(value: string): string | undefined {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return undefined;
  }
}

/** Replaces every rendered spelling of a blind child's workspace path, keeping relative suffixes. */
export function blindWorkspace(
  prompt: string,
  params: { workspaceDir: string; runtimeInfo?: SystemPromptRuntimeInfo },
): string {
  if (!params.runtimeInfo?.blind) {
    return prompt;
  }
  const roots = new Set<string>();
  for (const candidate of [params.workspaceDir, realpathOrUndefined(params.workspaceDir)]) {
    const root = candidate?.trim().replace(/[\\/]+$/u, "");
    if (root) {
      roots.add(root);
      roots.add(sanitizeForPromptLiteral(root));
    }
  }
  let withheld = prompt;
  // Longest first: `/tmp/ws` also occurs inside its realpath `/private/tmp/ws`.
  for (const root of [...roots].toSorted((a, b) => b.length - a.length)) {
    // `/var/tmp/ws` and `/tmp/ws-old` are different paths; only the whole path matches.
    withheld = withheld.replace(
      new RegExp(`(?<![\\w.~-])${escapeRegExp(root)}(?![\\w.~-])`, "gu"),
      BLIND_WORKSPACE_PLACEHOLDER,
    );
  }
  // The directory section comes first; explain the placeholder where the model meets it.
  return withheld.replace(
    /^Working directory: .*$/mu,
    (line) =>
      `${line}\n${BLIND_WORKSPACE_PLACEHOLDER} stands for a withheld path; use paths relative to the working directory.`,
  );
}

export function buildRuntimeLine(
  runtimeInfo?: SystemPromptRuntimeInfo,
  runtimeChannel?: string,
  runtimeCapabilities: string[] = [],
): string {
  const normalizedRuntimeCapabilities = normalizePromptCapabilityIds(runtimeCapabilities);
  // Transcript ids rotate on rewind; isolated cron keys also carry per-run ids.
  // Keep only stable session identity in the cached Runtime line.
  const { baseSessionKey } = parseCronRunScopeSuffix(runtimeInfo?.sessionKey);
  const fields = {
    name: runtimeInfo?.agentName,
    agent: runtimeInfo?.agentId,
    session: baseSessionKey && sanitizeForPromptLiteral(baseSessionKey),
    sessionUrl: runtimeInfo?.sessionUrl && sanitizeForPromptLiteral(runtimeInfo.sessionUrl),
    host: runtimeInfo?.host,
    repo: runtimeInfo?.repoRoot,
    os: runtimeInfo?.os && `${runtimeInfo.os}${runtimeInfo.arch ? ` (${runtimeInfo.arch})` : ""}`,
    arch: runtimeInfo?.os ? undefined : runtimeInfo?.arch,
    node: runtimeInfo?.node,
    active_node: runtimeInfo?.activeNode && sanitizeForPromptLiteral(runtimeInfo.activeNode),
    active_node_identity: runtimeInfo?.activeNodeIdentity,
    model: runtimeInfo?.model,
    default_model: runtimeInfo?.defaultModel,
    shell: runtimeInfo?.shell,
    channel: runtimeChannel,
    // Named for the channel so models never read it as this session's tool capabilities.
    channel_capabilities: runtimeChannel && (normalizedRuntimeCapabilities.join(",") || "none"),
  };
  return `Runtime: ${Object.entries(fields)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${value}`)
    .join(" | ")}`;
}
/** Complete only the renderer-owned runtime region with the executing host's facts. */
export function completeSystemPromptRuntime(
  systemPrompt: string,
  environment: SystemPromptRuntimeInfo,
): string {
  return systemPrompt.replace(
    SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END,
    () =>
      ` | ${buildRuntimeLine(environment).slice("Runtime: ".length)}${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END}`,
  );
}
