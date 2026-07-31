import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { repairStaleAgentModelRefs } from "./stale-agent-model-ref-repair.js";

const mocks = vi.hoisted(() => ({
  resolvePluginMetadataSnapshot: vi.fn(),
}));

vi.mock("../../../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/plugin-metadata-snapshot.js")>()),
  resolvePluginMetadataSnapshot: mocks.resolvePluginMetadataSnapshot,
}));

function metadataSnapshot(workspaceDir: string) {
  const providerIds = workspaceDir === "/tmp/openclaw-ops" ? ["workspace-provider"] : [];
  return {
    workspaceDir,
    diagnostics: [],
    manifestRegistry: { plugins: [] },
    owners: {
      providers: new Map(providerIds.map((providerId) => [providerId, ["workspace-plugin"]])),
      modelCatalogProviders: new Map(),
      setupProviders: new Map(),
      cliBackends: new Map(),
    },
  } as never;
}

describe("stale agent model reference repair", () => {
  beforeEach(() => {
    mocks.resolvePluginMetadataSnapshot.mockReset();
    mocks.resolvePluginMetadataSnapshot.mockImplementation(({ workspaceDir }) =>
      metadataSnapshot(workspaceDir),
    );
  });

  it("preserves a provider discovered in one agent workspace", () => {
    const cfg = {
      agents: {
        ownership: "explicit",
        entries: {
          ops: {
            workspace: "/tmp/openclaw-ops",
            model: "workspace-provider/ops-model",
          },
          research: {
            workspace: "/tmp/openclaw-research",
            model: "openai/gpt-5.5",
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = repairStaleAgentModelRefs(cfg, {
      persistedProviderIdsByAgentId: new Map([
        ["ops", new Set()],
        ["research", new Set()],
      ]),
    });

    expect(result.changes).toEqual([]);
    expect(result.config).toEqual(cfg);
    expect(mocks.resolvePluginMetadataSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: "/tmp/openclaw-ops" }),
    );
    expect(mocks.resolvePluginMetadataSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: "/tmp/openclaw-research" }),
    );
  });

  it("does not expose one workspace provider to another agent", () => {
    const cfg = {
      agents: {
        ownership: "explicit",
        entries: {
          ops: {
            workspace: "/tmp/openclaw-ops",
            model: "workspace-provider/ops-model",
          },
          research: {
            workspace: "/tmp/openclaw-research",
            model: "workspace-provider/research-model",
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = repairStaleAgentModelRefs(cfg, {
      persistedProviderIdsByAgentId: new Map([
        ["ops", new Set()],
        ["research", new Set()],
      ]),
    });

    expect(result.config.agents?.entries?.ops?.model).toBe("workspace-provider/ops-model");
    expect(result.config.agents?.entries?.research?.model).toBeUndefined();
    expect(result.changes).toContainEqual(
      expect.stringContaining(
        'Removed stale agents.entries.research.model "workspace-provider/research-model"',
      ),
    );
  });
});
