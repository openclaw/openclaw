import { expect, it, vi } from "vitest";
import type { ModelAuthAvailabilityEvaluation } from "../agents/model-auth-availability.js";
import { createRetiredModelFixture as fixture } from "./doctor-retired-models.test-support.js";
import {
  createRetiredModelRefRepairResolver as createResolver,
  repairRetiredConfigModelRefs as repairConfig,
} from "./doctor/shared/retired-model-ref-repair.js";

async function useRealRoutes() {
  const routes = await import("../agents/openai-model-routes.js");
  const actual = await vi.importActual<typeof routes>("../agents/openai-model-routes.js");
  vi.spyOn(routes, "createOpenAIModelRoutesResolver").mockImplementation(
    actual.createOpenAIModelRoutesResolver,
  );
}

function repairContext(params: Omit<Parameters<typeof createResolver>[0], "warnings">) {
  const warnings: string[] = [];
  const resolve = createResolver({ ...params, warnings });
  return { warnings, resolve, repair: () => repairConfig(params.cfg, resolve, warnings) };
}

// #156155: validate successors against the selected route before rewriting config.
it.each(["available", "cooldown", "authoritative-cooldown"] as const)(
  "migrates a supported successor absent from catalogs (%s)",
  async (availability) => {
    const source = "openai/retired-with-successor";
    const successor = "openai/current-model";
    const { cfg, state } = await fixture(
      "oauth",
      availability === "available" ? undefined : Date.now() + 60_000,
    );
    if (availability === "authoritative-cooldown") {
      const modelAuthAvailability = await import("../agents/model-auth-availability.js");
      const createAuthResolver = modelAuthAvailability.createModelAuthAvailabilityResolver;
      vi.spyOn(modelAuthAvailability, "createModelAuthAvailabilityResolver").mockImplementation(
        (params) => {
          const resolver = createAuthResolver(params);
          return {
            ...resolver,
            evaluateRuntimeModelAuth: (provider, ref): ModelAuthAvailabilityEvaluation => {
              const result = resolver.evaluateRuntimeModelAuth(provider, ref);
              return ref?.modelId === "current-model"
                ? {
                    ...result,
                    availability: false,
                    availabilityAuthoritative: true,
                    unavailableReason: "cooldown",
                  }
                : result;
            },
          };
        },
      );
    }
    const { loadManifestMetadataSnapshot } =
      await import("../plugins/manifest-contract-eligibility.js");
    const metadataSnapshot = loadManifestMetadataSnapshot({ config: cfg, env: state.env });
    const catalog = metadataSnapshot.plugins.find((plugin) => plugin.id === "openai")?.modelCatalog
      ?.providers?.openai?.models;
    expect(catalog?.length).toBeGreaterThan(0);
    expect(catalog?.some((model) => model.id === "current-model")).toBe(false);
    expect(cfg.models?.providers?.openai?.models).toEqual([]);
    cfg.agents!.defaults!.model = { primary: source, fallbacks: [source] };
    cfg.agents!.defaults!.modelPolicy = { allow: [source] };
    const originalConfig = structuredClone(cfg);
    const { warnings, resolve, repair } = repairContext({ cfg, env: state.env, metadataSnapshot });
    expect(resolve({ modelRef: source, agentId: "main" })).toEqual({
      kind: "replace",
      modelRef: successor,
      reason: "retirement",
      retirementScope: "route",
    });
    const repaired = repair();
    expect(cfg).toEqual(originalConfig);
    expect(repaired.config.agents?.defaults).toEqual({
      model: { primary: successor, fallbacks: [successor] },
      modelPolicy: { allow: [source, successor] },
    });
    expect(warnings).toEqual([]);
  },
);

it.each(["retired-incompat-chain", "retired-global-parent", "retired-chain-to-retired"])(
  "keeps selectors, fallbacks and policy when %s has an unsupported successor",
  async (source) => {
    const { cfg, state } = await fixture("oauth");
    if (source === "retired-incompat-chain") {
      await useRealRoutes();
      cfg.models!.providers!.openai!.api = "openai-chatgpt-responses";
      cfg.models!.providers!.openai!.baseUrl = "https://chatgpt.com/backend-api/codex";
    }
    const modelRef = `openai/${source}`;
    cfg.agents!.defaults!.model = {
      primary: modelRef,
      fallbacks: [modelRef, "openai/current-model"],
    };
    cfg.agents!.defaults!.modelPolicy = { allow: [modelRef] };
    const originalConfig = structuredClone(cfg);
    const { warnings, resolve, repair } = repairContext({ cfg, env: state.env });
    expect(resolve({ modelRef, agentId: "main" })).toEqual({ kind: "unchanged" });
    const repaired = repair();
    expect(repaired.config).toEqual(originalConfig);
    expect(warnings.join("\n")).toContain("successor");
  },
);

it.each([
  ["inherited", "qualified"],
  ["local", "unqualified"],
  ["explicit-successor", "unqualified"],
] as const)("preserves runtime settings (%s, %s)", async (scope, keyForm) => {
  const { cfg, state } = await fixture("oauth");
  await useRealRoutes();
  delete cfg.models;
  const source = "openai/retired-runtime-parent";
  const sourceKey = keyForm === "qualified" ? source : "retired-runtime-parent";
  const successor = "openai/gpt-5.5";
  cfg.agents!.defaults!.model = { primary: "openai/current-model", fallbacks: [source] };
  cfg.agents!.defaults!.modelPolicy = { allow: [source, "openai/current-model"] };
  cfg.agents!.defaults!.models = {
    [sourceKey]: { agentRuntime: { id: scope === "local" ? "codex" : "agentsapi" } },
    ...(scope === "local" ? { [successor]: { agentRuntime: { id: "codex" } } } : {}),
  };
  if (scope === "local") {
    cfg.agents!.entries!.main!.models = { [sourceKey]: { agentRuntime: { id: "agentsapi" } } };
  } else if (scope === "explicit-successor") {
    cfg.agents!.entries!.main!.models = { [successor]: { agentRuntime: { id: "codex" } } };
  }
  const originalConfig = structuredClone(cfg);
  const { warnings, repair } = repairContext({ cfg, env: state.env });
  const repaired = repair();
  expect(cfg).toEqual(originalConfig);
  if (scope === "explicit-successor") {
    expect(repaired.config.agents?.defaults?.model).toEqual({
      primary: "openai/current-model",
      fallbacks: [successor],
    });
    expect(repaired.config.agents?.entries?.main?.models?.[successor]?.agentRuntime?.id).toBe(
      "codex",
    );
  } else {
    expect(repaired.config).toEqual(originalConfig);
    expect(warnings.join("\n")).toContain("successor");
  }
});
