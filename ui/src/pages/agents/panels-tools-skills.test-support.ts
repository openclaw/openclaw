import { vi } from "vitest";
import { GitHubIdentityController } from "../../features/github-connections/github-identity-controller.ts";
import type { AgentTools } from "./panels-tools-skills.tsx";

export function createBaseParams(overrides: Partial<Parameters<typeof AgentTools>[0]> = {}) {
  const githubIdentity = new GitHubIdentityController({
    requestUpdate: () => undefined,
    runExternalMutation: async () => ({
      ok: false,
      reason: "unavailable",
      error: "Mutation unavailable in rendering test.",
    }),
  });
  githubIdentity.sync({
    client: null,
    connected: false,
    target: { kind: "shared", scope: "agent", agentId: "main", config: null },
    statusReadable: true,
    configurable: false,
    authorizable: false,
    clientRevision: 0,
  });
  return {
    agentId: "main",
    canUpdateConfig: true,
    configForm: {
      agents: {
        entries: { main: { tools: { profile: "full" } } },
      },
    } as Record<string, unknown>,
    configLoading: false,
    configSaving: false,
    configDirty: false,
    toolsCatalogLoading: false,
    toolsCatalogError: null,
    toolsCatalogResult: null,
    toolsEffectiveLoading: false,
    toolsEffectiveError: null,
    toolsEffectiveResult: null,
    runtimeSessionKey: "main",
    runtimeSessionMatchesSelectedAgent: true,
    githubIdentity,
    onOpenGitHubConnections: vi.fn(),
    onProfileChange: () => undefined,
    onOverridesChange: () => undefined,
    onConfigReload: () => undefined,
    onConfigSave: () => undefined,
    ...overrides,
  };
}
