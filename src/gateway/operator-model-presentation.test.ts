import { beforeEach, describe, expect, it, vi } from "vitest";
import { modelDefinition } from "../agents/model-auth.fixtures.test-support.js";
import { listConfiguredOwnerInputs } from "../agents/prepared-model-runtime.configured.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  modelSelectionPoliciesMatch,
  prepareOperatorModelPolicyPresentation,
} from "./operator-model-presentation.js";

it("reuses row redactions before copying while evaluating current model visibility", () => {
  let visible = false;
  const allows = vi.fn(() => visible);
  const presentation = prepareOperatorModelPolicyPresentation({
    cfg: {},
    policy: { models: [], allows },
  })!;
  const readLabel = vi.fn(() => "Synthetic row");
  const row = Object.freeze({
    get label() {
      return readLabel();
    },
    modelProvider: "fixture",
    model: "private",
    activeModelProvider: null,
    activeModel: null,
    contextBudgetStatus: { provider: "fixture", model: "private" },
  });
  const variants: (typeof row)[] = [];
  const first = presentation.session(row, variants);
  expect(first).toEqual({ label: "Synthetic row", activeModelProvider: null, activeModel: null });
  readLabel.mockClear();
  allows.mockClear();
  expect(presentation.session(row, variants)).toBe(first);
  expect(readLabel).not.toHaveBeenCalled();
  expect(Object.isFrozen(first)).toBe(true);
  expect(allows).toHaveBeenCalledTimes(2);
  visible = true;
  expect(presentation.session(row, variants)).toBe(row);
  visible = false;
  expect(presentation.session(row, variants)).toBe(first);
  expect(variants).toEqual([first]);
});

it.each([true, false])(
  "filters explicit Access grants on every runtime choice (model ceiling=%s)",
  (restricted) => {
    const allows = ({ model }: { model: string }) => model === "fixture";
    const projection = prepareOperatorModelPolicyPresentation({
      cfg: {},
      policy: restricted ? { models: [], allows } : undefined,
      rolePolicy: { accessPrograms: { cyber: ["daybreak_blue"] } },
    })!;
    const programs = { cyber: ["standard", "daybreak_blue", "daybreak_red"] as const };
    const input = {
      models: [
        {
          provider: "openai",
          id: "fixture",
          name: "Fixture",
          availableAccessPrograms: { cyber: [...programs.cyber] },
          runtimeChoices: [
            {
              agentRuntime: { id: "codex", label: "Codex", source: "model" as const },
              availableAccessPrograms: { cyber: [...programs.cyber] },
            },
          ],
        },
      ],
    };
    const result = projection.forAgent("main").catalog(input);
    expect(result.models[0]?.availableAccessPrograms?.cyber).toEqual(["standard", "daybreak_blue"]);
    expect(result.models[0]?.runtimeChoices?.[0]?.availableAccessPrograms?.cyber).toEqual([
      "standard",
      "daybreak_blue",
    ]);
    expect(input.models[0]?.availableAccessPrograms.cyber).toEqual(programs.cyber);
    if (!restricted) {
      expect(result.modelSelectionPolicy).toBeUndefined();
      const defaults = { model: "fixture", modelProvider: "openai", contextTokens: 1000 };
      expect(projection.forAgent("main").defaults(defaults)).toBe(defaults);
    }
    const ungranted = prepareOperatorModelPolicyPresentation({ cfg: {}, rolePolicy: {} })!;
    expect(
      ungranted.forAgent("main").catalog(input).models[0]?.availableAccessPrograms?.cyber,
    ).toEqual(["standard"]);
  },
);

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
