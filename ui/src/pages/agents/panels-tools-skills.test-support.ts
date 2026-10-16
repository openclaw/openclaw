import { vi } from "vitest";
import { githubIdentityViewFixture } from "../../features/github-connections/github-identity.test-support.ts";
import type { AgentTools } from "./panels-tools-skills.tsx";

export function createBaseParams(overrides: Partial<Parameters<typeof AgentTools>[0]> = {}) {
  const githubIdentity = githubIdentityViewFixture();
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
