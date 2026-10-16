import { describe, expect, it, vi } from "vitest";
import type { ModelAuthAvailabilityEvaluation } from "../agents/model-auth-availability.js";
import { createRetiredModelFixture as fixture } from "./doctor-retired-models.test-support.js";
import {
  createRetiredModelRefRepairResolver,
  repairRetiredConfigModelRefs,
} from "./doctor/shared/retired-model-ref-repair.js";

// #156155: validate successors against the selected route before rewriting config.
describe("doctor retired successor guard", () => {
  it.each(["available", "cooldown", "authoritative-cooldown"] as const)(
    "migrates a supported successor absent from catalogs (%s)",
    async (availability) => {
      const { cfg, state } = await fixture("oauth");
      if (availability !== "available") {
        await state.writeAuthProfiles({
          version: 1,
          profiles: {
            chatgpt: {
              provider: "openai",
              type: "oauth",
              access: "synthetic-access",
              refresh: "synthetic-refresh",
              expires: 9_999_999_999_999,
            },
            platform: { provider: "openai", type: "api_key", key: "synthetic-key" },
          },
          usageStats: { chatgpt: { cooldownUntil: Date.now() + 60_000 } },
        });
      }
      if (availability === "authoritative-cooldown") {
        const modelAuthAvailability = await import("../agents/model-auth-availability.js");
        const createResolver = modelAuthAvailability.createModelAuthAvailabilityResolver;
        vi.spyOn(modelAuthAvailability, "createModelAuthAvailabilityResolver").mockImplementation(
          (params) => {
            const resolver = createResolver(params);
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
      const catalog = metadataSnapshot.plugins.find((plugin) => plugin.id === "openai")
        ?.modelCatalog?.providers?.openai?.models;
      expect(catalog?.length).toBeGreaterThan(0);
      expect(catalog?.some((model) => model.id === "current-model")).toBe(false);
      expect(cfg.models?.providers?.openai?.models).toEqual([]);
      cfg.agents!.defaults!.model = {
        primary: "openai/retired-with-successor",
        fallbacks: ["openai/retired-with-successor"],
      };
      cfg.agents!.defaults!.modelPolicy = { allow: ["openai/retired-with-successor"] };
      const originalConfig = structuredClone(cfg);
      const warnings: string[] = [];
      const resolve = createRetiredModelRefRepairResolver({
        cfg,
        env: state.env,
        metadataSnapshot,
        warnings,
      });
      expect(resolve({ modelRef: "openai/retired-with-successor", agentId: "main" })).toEqual({
        kind: "replace",
        modelRef: "openai/current-model",
        reason: "retirement",
        retirementScope: "route",
      });
      const repaired = repairRetiredConfigModelRefs(cfg, resolve, warnings);
      expect(cfg).toEqual(originalConfig);
      expect(repaired.config.agents?.defaults?.model).toEqual({
        primary: "openai/current-model",
        fallbacks: ["openai/current-model"],
      });
      expect(repaired.config.agents?.defaults?.modelPolicy?.allow).toEqual([
        "openai/retired-with-successor",
        "openai/current-model",
      ]);
      expect(warnings).toEqual([]);
    },
  );

  it.each(["retired-incompat-chain", "retired-global-parent", "retired-chain-to-retired"])(
    "keeps selectors, fallbacks and policy when %s has an unsupported successor",
    async (source) => {
      const { cfg, state } = await fixture("oauth");
      if (source === "retired-incompat-chain") {
        const openaiModelRoutes = await import("../agents/openai-model-routes.js");
        const actual = await vi.importActual<typeof import("../agents/openai-model-routes.js")>(
          "../agents/openai-model-routes.js",
        );
        vi.spyOn(openaiModelRoutes, "createOpenAIModelRoutesResolver").mockImplementation(
          actual.createOpenAIModelRoutesResolver,
        );
        cfg.models!.providers!.openai!.api = "openai-chatgpt-responses";
        cfg.models!.providers!.openai!.baseUrl = "https://chatgpt.com/backend-api/codex";
      }
      const modelRef = `openai/${source}`;
      cfg.agents!.defaults!.model = {
        primary: modelRef,
        fallbacks: [modelRef, "openai/current-model"],
      };
      cfg.agents!.defaults!.modelPolicy = { allow: [modelRef] };
      const warnings: string[] = [];
      const resolve = createRetiredModelRefRepairResolver({
        cfg,
        env: state.env,
        warnings,
      });
      expect(resolve({ modelRef, agentId: "main" })).toEqual({
        kind: "unchanged",
      });
      const repaired = repairRetiredConfigModelRefs(cfg, resolve, warnings);
      expect(repaired.config.agents?.defaults?.model).toEqual({
        primary: modelRef,
        fallbacks: [modelRef, "openai/current-model"],
      });
      expect(repaired.config.agents?.defaults?.modelPolicy?.allow).toEqual([modelRef]);
      expect(warnings.join("\n")).toContain("successor");
    },
  );

  it.each([
    ["inherited", "qualified"],
    ["local", "unqualified"],
    ["explicit-successor", "unqualified"],
  ] as const)(
    "checks the runtime settings preserved by repair (%s, %s)",
    async (scope, keyForm) => {
      const { cfg, state } = await fixture("oauth");
      const openaiModelRoutes = await import("../agents/openai-model-routes.js");
      const actual = await vi.importActual<typeof import("../agents/openai-model-routes.js")>(
        "../agents/openai-model-routes.js",
      );
      vi.spyOn(openaiModelRoutes, "createOpenAIModelRoutesResolver").mockImplementation(
        actual.createOpenAIModelRoutesResolver,
      );
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
      const warnings: string[] = [];
      const resolve = createRetiredModelRefRepairResolver({ cfg, env: state.env, warnings });
      const repaired = repairRetiredConfigModelRefs(cfg, resolve, warnings);
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
    },
  );
});
