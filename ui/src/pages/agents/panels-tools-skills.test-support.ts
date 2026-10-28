import { flush } from "solid-js";
import { vi } from "vitest";
import type { ToolsCatalogResult, ToolsEffectiveResult } from "../../api/types.ts";
import { githubIdentityViewFixture } from "../../features/github-connections/github-identity.test-support.ts";
import { GitLabManagedIdentityState } from "../../features/gitlab-connections/gitlab-managed-identity.ts";
import { createAgentViewTestProps } from "./agents-view.test-helpers.ts";
import type { AgentTools } from "./panels-tools-skills.tsx";

type Params = Parameters<typeof AgentTools>[0] & {
  catalog: ToolsCatalogResult | null;
  effective: ToolsEffectiveResult | null;
};

/** Reveal the groups whose tool controls a test exercises. */
export function openToolGroups(container: HTMLElement) {
  for (const group of container.querySelectorAll<HTMLDetailsElement>(".agent-tools-group")) {
    group.open = true;
    group.dispatchEvent(new Event("toggle"));
  }
  flush();
}

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
    gitlabIdentity: new GitLabManagedIdentityState(),
    onOpenGitHubConnections: vi.fn(),
    onProfileChange: () => undefined,
    onOverridesChange: () => undefined,
    onConfigReload: async () => undefined,
    onConfigSave: async () => undefined,
    ...overrides,
  };
}

export function createReadToolCatalog(agentId = "main", label = "read"): ToolsCatalogResult {
  return {
    agentId,
    profiles: [{ id: "full", label: "Full" }],
    groups: [
      {
        id: "files",
        label: "Files",
        source: "core",
        tools: [
          {
            id: label,
            label,
            description: label === "read" ? "Read file contents" : label,
            source: "core",
            defaultProfiles: ["full"],
          },
        ],
      },
    ],
  };
}
