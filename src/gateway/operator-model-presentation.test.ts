import { beforeEach, describe, expect, it, vi } from "vitest";
import { modelDefinition } from "../agents/model-auth.fixtures.test-support.js";
import { listConfiguredOwnerInputs } from "../agents/prepared-model-runtime.configured.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { modelSelectionPoliciesMatch } from "./operator-model-presentation.js";

const loadManifestMetadataSnapshot = vi.hoisted(() => vi.fn());
vi.mock("../plugins/manifest-contract-eligibility.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../plugins/manifest-contract-eligibility.js")>();
  loadManifestMetadataSnapshot.mockImplementation(actual.loadManifestMetadataSnapshot);
  return { ...actual, loadManifestMetadataSnapshot };
});

const configWithPrimary = (primary: string): OpenClawConfig => ({
  agents: { defaults: { model: { primary } } },
  models: {
    providers: {
      vllm: {
        baseUrl: "http://127.0.0.1:1/v1",
        api: "openai-completions",
        models: ["model-a", "model-b"].map((id) =>
          modelDefinition(id, { reasoning: false, maxTokens: 1024 }),
        ),
      },
    },
  },
});

// Config reload holds the plugin lifecycle lease, whose operation cache cannot see the
// Gateway's published inventory; a metadata load there rescans plugin files.
const inLifecycleOperation = <T>(run: () => T): T => withPluginCache(createPluginCache(), run);

describe("post-commit readers use the published plugin inventory", () => {
  beforeEach(() => {
    loadManifestMetadataSnapshot.mockClear();
  });

  it("compares model selection policies without loading plugin metadata", () => {
    const published = createPluginMetadataSnapshotFixture();

    const matches = inLifecycleOperation(() =>
      modelSelectionPoliciesMatch(
        configWithPrimary("model-a"),
        configWithPrimary("model-b"),
        published,
      ),
    );

    expect(matches).toBe(true);
    expect(loadManifestMetadataSnapshot).not.toHaveBeenCalled();
  });

  it("collects prepared runtime inputs without loading plugin metadata", async () => {
    await withOpenClawTestState({ label: "published-metadata-inputs" }, async () => {
      const published = createPluginMetadataSnapshotFixture();

      const inputs = inLifecycleOperation(() =>
        listConfiguredOwnerInputs(
          configWithPrimary("model-a"),
          undefined,
          true,
          undefined,
          published,
        ),
      );

      expect(inputs.map((input) => input.agentId)).toEqual(["main"]);
      expect(loadManifestMetadataSnapshot).not.toHaveBeenCalled();
    });
  });
});
