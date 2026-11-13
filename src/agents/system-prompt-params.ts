/**
 * System prompt runtime parameter resolver.
 *
 * Collects repository, channel, and shell facts for prompt rendering.
 */
import path from "node:path";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { ChatType } from "../channels/chat-type.js";
import { resolveControlUiPublicSessionUrl } from "../config/control-ui-link-base.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  formatActiveNodeContextLabel,
  getActiveNodeIdentityScope,
  getCurrentActiveNodeContext,
} from "../infra/active-node-context.js";
import { findGitRootAsync } from "../infra/git-root.js";
import { safeStat } from "../infra/path-existence.js";
import { parseCronRunScopeSuffix } from "../sessions/session-key-utils.js";
import { resolveAgentIdentity } from "./identity.js";
import { sanitizeForPromptLiteral } from "./sanitize-for-prompt.js";
import type { SystemPromptRuntimeInfo } from "./system-prompt.types.js";

const MAX_RUNTIME_AGENT_NAME_CHARS = 128;

type RuntimeInfoInput = Omit<SystemPromptRuntimeInfo, "chatType"> &
  Required<Pick<SystemPromptRuntimeInfo, "host" | "os" | "arch" | "node" | "model">> & {
    chatType?: ChatType;
  };

export function buildSystemPromptParams(params: {
  config?: OpenClawConfig;
  agentId?: string;
  runtime: Omit<RuntimeInfoInput, "agentId" | "agentName" | "sessionUrl" | "gitCoauthorPrompt">;
  workspaceDir?: string;
  cwd?: string;
  preparedRepoRoot?: string | null;
  preparedGitCoauthorPrompt?: string | null;
  preparedSessionEntry?: InternalSessionEntry;
  requesterProfileId?: string;
}): {
  runtimeInfo: RuntimeInfoInput;
} {
  const repoRoot = params.preparedRepoRoot ?? undefined;
  const { runId } = parseCronRunScopeSuffix(params.runtime.sessionKey);
  // Exact isolated-cron URLs expose a volatile run id before prompt rendering can normalize it,
  // defeating byte-identical prompt-prefix reuse across runs of the same job.
  const sessionUrl =
    runId === undefined
      ? resolveControlUiPublicSessionUrl(params.config, {
          sessionKey: params.runtime.sessionKey,
          agentId: params.agentId,
          sessionId: params.runtime.sessionId,
          entry: params.preparedSessionEntry,
        })
      : undefined;
  return {
    runtimeInfo: {
      agentId: params.agentId,
      agentName:
        params.config && params.agentId
          ? resolveRuntimeAgentName(params.config, params.agentId)
          : undefined,
      ...params.runtime,
      gitCoauthorPrompt: params.preparedGitCoauthorPrompt ?? undefined,
      sessionUrl,
      activeNode: formatActiveNodeContextLabel(
        getCurrentActiveNodeContext(params.requesterProfileId),
      ),
      activeNodeIdentity: getActiveNodeIdentityScope(params.requesterProfileId),
      repoRoot,
    },
  };
}

export function resolveRuntimeAgentName(config: OpenClawConfig, agentId: string) {
  const name = sanitizeForPromptLiteral(resolveAgentIdentity(config, agentId)?.name ?? "").trim();
  const bounded = truncateUtf16Safe(name, MAX_RUNTIME_AGENT_NAME_CHARS).trimEnd();
  return bounded && bounded !== agentId ? bounded : undefined;
}

export async function resolveSystemPromptRepoRoot(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  cwd?: string;
}): Promise<string | undefined> {
  const configured = params.config?.agents?.defaults?.repoRoot?.trim();
  if (configured) {
    const resolved = path.resolve(configured);
    const stat = await safeStat(resolved);
    if (stat?.isDirectory()) {
      return resolved;
    }
  }
  const candidates = normalizeStringEntries([params.workspaceDir ?? "", params.cwd ?? ""]);
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    const root = await findGitRootAsync(resolved);
    if (root) {
      return root;
    }
  }
  return undefined;
}
