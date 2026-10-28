import { isDeepStrictEqual } from "node:util";
import {
  matchesAgentLifecycleBinding,
  matchesAgentLifecycleBindingAsync,
  type AgentLifecycleBinding,
} from "../agents/agent-lifecycle-registry.js";
import { resolveMutableAgentEntry } from "../agents/agent-scope.js";
import { applyAgentConfig } from "../commands/agents.config.js";
import { unsetConfigValueAtPath } from "../config/config-paths.js";
import { mutateConfigFileWithRetry } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GitLabToolIdentityConfig } from "../config/types.tools.js";

export async function updateGitLabToolIdentityConfig(params: {
  scope: "system" | "agent";
  agentId: string;
  identity?: GitLabToolIdentityConfig;
  expectedIdentity?: GitLabToolIdentityConfig | null;
  agentLifecycleBinding?: AgentLifecycleBinding;
  assertCurrent?: () => void | Promise<void>;
}): Promise<OpenClawConfig> {
  const mutation = await mutateConfigFileWithRetry({
    afterWrite: { mode: "auto" },
    mutate: async (draft) => {
      await params.assertCurrent?.();
      if (params.scope === "system") {
        if (
          params.expectedIdentity !== undefined &&
          !isDeepStrictEqual(draft.tools?.gitlab ?? null, params.expectedIdentity)
        ) {
          throw new Error("GitLab identity changed while setup was in progress.");
        }
        draft.tools ??= {};
        if (params.identity) {
          draft.tools.gitlab = params.identity;
        } else {
          unsetConfigValueAtPath(draft, ["tools", "gitlab"]);
        }
        return;
      }

      if (
        params.agentLifecycleBinding &&
        (!(await matchesAgentLifecycleBindingAsync(() => draft, params.agentLifecycleBinding)) ||
          !matchesAgentLifecycleBinding(draft, params.agentLifecycleBinding))
      ) {
        throw new Error("Agent changed while GitLab setup was in progress.");
      }
      let entry = resolveMutableAgentEntry(draft, params.agentId);
      if (params.agentLifecycleBinding && !entry) {
        throw new Error("Agent changed while GitLab setup was in progress.");
      }
      if (
        params.expectedIdentity !== undefined &&
        !isDeepStrictEqual(entry?.tools?.gitlab ?? null, params.expectedIdentity)
      ) {
        throw new Error("GitLab identity changed while setup was in progress.");
      }
      if (!entry && params.identity && !params.agentLifecycleBinding) {
        Object.assign(draft, applyAgentConfig(draft, { agentId: params.agentId }));
        entry = resolveMutableAgentEntry(draft, params.agentId);
      }
      if (!entry) {
        return;
      }
      entry.tools ??= {};
      if (params.identity) {
        entry.tools.gitlab =
          entry.tools.gitlab?.allowInSandbox === undefined
            ? params.identity
            : { ...params.identity, allowInSandbox: entry.tools.gitlab.allowInSandbox };
      } else {
        unsetConfigValueAtPath(entry, ["tools", "gitlab"]);
      }
    },
  });
  return mutation.nextConfig;
}
