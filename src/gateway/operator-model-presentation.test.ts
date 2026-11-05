import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ModelChoice } from "../../packages/gateway-protocol/src/index.js";
import { modelDefinition } from "../agents/model-auth.fixtures.test-support.js";
import { listConfiguredOwnerInputs } from "../agents/prepared-model-runtime.configured.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  modelSelectionPoliciesMatch,
  prepareOperatorModelPolicyPresentation,
} from "./operator-model-presentation.js";

it.each([false, true])(
  "disables unsupported selected and alternative runtimes for the requester (Access-only=%s)",
  (accessOnly) => {
    const previous = captureActivePluginRegistrySnapshot();
    onTestFinished(() => restoreActivePluginRegistrySnapshot(previous));
    const registry = createEmptyPluginRegistry();
    for (const exact of [false, true]) {
      registry.agentHarnesses.push({
        pluginId: "fixture",
        source: "fixture",
        harness: {
          id: exact ? "exact-fixture" : "unsupported-fixture",
          label: "Fixture",
          nativeModelPolicySupport: exact ? "exact" : undefined,
          supports: () => ({ supported: true }),
          runAttempt: vi.fn(),
        },
      });
    }
    setActivePluginRegistry(registry);
    const presentation = prepareOperatorModelPolicyPresentation({
      cfg: {},
      ...(accessOnly ? { rolePolicy: {} } : { policy: { models: [], allows: () => true } }),
    })!;
    const runtime = (id: string) => ({
      agentRuntime: { id, label: id, source: "model" as const },
      available: true,
    });
    const model: ModelChoice = {
      provider: "fixture",
      id: "model",
      name: "Fixture",
      ...runtime("unsupported-fixture"),
      runtimeChoices: [
        runtime("unsupported-fixture"),
        runtime("exact-fixture"),
        runtime("openclaw"),
      ],
    };
    const result = presentation.forAgent("main").catalog({ models: [model] }).models[0];
    expect(result).toMatchObject({ available: false, unavailableReason: "unsupported-runtime" });
    expect(result?.runtimeChoices).toMatchObject([
      { available: false, unavailableReason: "unsupported-runtime" },
      { available: true },
      { available: true },
    ]);
    expect(model.available).toBe(true);
    expect(model.runtimeChoices?.every((choice) => choice.available)).toBe(true);
    expect(prepareOperatorModelPolicyPresentation({ cfg: {} })).toBeUndefined();
    const granted = prepareOperatorModelPolicyPresentation({
      cfg: {},
      rolePolicy: { accessPrograms: { cyber: ["daybreak_blue", "daybreak_red"] } },
    })!;
    expect(granted.forAgent("main").catalog({ models: [model] }).models[0]?.available).toBe(true);
  },
);

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
      utilityModel: { modelRef: "openai/fixture@private", source: "config" as const },
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
    expect(result.utilityModel).toEqual({ modelRef: "openai/fixture", source: "config" });
    expect(input.utilityModel.modelRef).toBe("openai/fixture@private");
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
