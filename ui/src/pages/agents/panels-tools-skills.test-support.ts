import { vi } from "vitest";
import type { ToolsCatalogResult, ToolsEffectiveResult } from "../../api/types.ts";
import { githubIdentityViewFixture } from "../../features/github-connections/github-identity.test-support.ts";
import { createAgentViewTestProps } from "./agents-view.test-helpers.ts";
import type { AgentTools } from "./panels-tools-skills.tsx";

type Params = Parameters<typeof AgentTools>[0] & {
  catalog: ToolsCatalogResult | null;
  effective: ToolsEffectiveResult | null;
};

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
    presentationRetired: Promise.withResolvers<void>().promise,
    catalog: null,
    readCatalog() {
      return this.catalog;
    },
    catalogRequest: null,
    onRetryCatalog: vi.fn(),
    effective: null,
    readEffective() {
      return this.effective;
    },
    get effectivePreview() {
      return this.effective;
    },
    effectiveRequest: null,
    runtimeSessionKey: "main",
    runtimeSessionMatchesSelectedAgent: true,
    githubIdentity,
    onOpenGitHubConnections: vi.fn(),
    onProfileChange: () => undefined,
    onOverridesChange: () => undefined,
    onConfigReload: async () => undefined,
    onConfigSave: async () => undefined,
    ...overrides,
  };
}
