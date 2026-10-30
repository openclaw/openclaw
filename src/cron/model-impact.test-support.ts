import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { CronModelImpactOwner } from "./model-impact.js";
import type { CronStoredJob } from "./types.js";

export function impactConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "fixture/old", fallbacks: ["fixture/pinned"] },
        models: { "fixture/*": { agentRuntime: { id: "openclaw" } } },
      },
      entries: { main: {}, ops: { model: "fixture/pinned" } },
    },
    models: {
      providers: {
        fixture: {
          baseUrl: "https://fixture.invalid/v1",
          api: "openai-completions",
          apiKey: "fixture:work",
          models: [],
        },
      },
    },
  };
}
export function impactOwner(cfg = impactConfig(), agentId = "main"): CronModelImpactOwner {
  return {
    config: cfg,
    observationConfig: cfg,
    agentId,
    catalogOwner: { agentId, workspaceDir: "/synthetic/workspace" },
    agentDir: "/synthetic/agent",
    workspaceDir: "/synthetic/workspace",
    authModes: {},
    authStore: {
      version: 1,
      profiles: { "fixture:work": { type: "api_key", provider: "fixture", key: "synthetic-key" } },
    },
    modelCatalog: {
      entries: ["old", "new", "pinned"].map((id) => ({
        id,
        name: id,
        provider: "fixture",
        api: "openai-completions",
        baseUrl: "https://fixture.invalid/v1",
      })),
      routeVariants: [],
    },
    metadataSnapshot: createPluginMetadataSnapshotFixture(),
    isCurrent: () => true,
  };
}
export function impactJob(id: string, overrides: Partial<CronStoredJob> = {}): CronStoredJob {
  return {
    id,
    name: id,
    agentId: "main",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "at", at: "2020-01-01T00:00:00.000Z" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "synthetic task" },
    state: {},
    inferenceBinding: {
      version: 1,
      provider: "fixture",
      profileId: "fixture:work",
      authorizationId: "a".repeat(64),
      authRequirement: "api-key",
      source: "auto",
      runtime: "openclaw",
    },
    ...overrides,
  };
}
