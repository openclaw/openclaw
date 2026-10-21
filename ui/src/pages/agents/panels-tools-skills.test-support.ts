import { vi } from "vitest";
import { githubIdentityViewFixture } from "../../features/github-connections/github-identity.test-support.ts";
import { createAgentViewTestProps } from "./agents-view.test-helpers.ts";
import type { AgentTools } from "./panels-tools-skills.tsx";

type Params = Parameters<typeof AgentTools>[0] &
  Pick<
    ReturnType<Parameters<typeof AgentTools>[0]["readData"]>,
    | "toolsCatalogLoading"
    | "toolsCatalogError"
    | "toolsCatalogResult"
    | "toolsEffectiveLoading"
    | "toolsEffectiveError"
    | "toolsEffectiveResult"
  >;

export function createBaseParams(overrides: Partial<Params> = {}): Params {
  const githubIdentity = githubIdentityViewFixture();
  return {
    readData() {
      return { ...createAgentViewTestProps().readData(), ...this };
    },
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
