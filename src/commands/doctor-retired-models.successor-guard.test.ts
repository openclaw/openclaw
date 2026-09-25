import { describe, expect, it, vi } from "vitest";
import type { ModelAuthAvailabilityEvaluation } from "../agents/model-auth-availability.js";
import { createRetiredModelFixture as fixture } from "./doctor-retired-models.test-support.js";
import {
  createRetiredModelRefRepairResolver,
  repairRetiredConfigModelRefs,
} from "./doctor/shared/retired-model-ref-repair.js";

// Regression coverage for openclaw/openclaw#156155: Doctor must not migrate a
// retired reference onto a successor that the owner cannot support. A successor
// that is itself retired is definitionally unsupported: writing it into
// selectors, fallbacks, and modelPolicy.allow converts a visible retirement
// warning into a latent unusable reference.
describe("doctor retired successor guard", () => {
  it("retains a reference whose successor is itself retired", async () => {
    const { cfg, state } = await fixture("oauth");
    const warnings: string[] = [];
    const resolve = createRetiredModelRefRepairResolver({
      cfg,
      env: state.env,
      warnings,
    });
    expect(resolve({ modelRef: "openai/retired-chain-to-retired", agentId: "main" })).toEqual({
      kind: "unchanged",
    });
    expect(warnings.join("\n")).toContain("successor");
  });

  it("migrates a supported successor absent from manifest and configured catalogs", async () => {
    const { cfg, state } = await fixture("oauth");
    const { loadManifestMetadataSnapshot } =
      await import("../plugins/manifest-contract-eligibility.js");
    const metadataSnapshot = loadManifestMetadataSnapshot({ config: cfg, env: state.env });
    const catalog = metadataSnapshot.plugins.find((plugin) => plugin.id === "openai")?.modelCatalog
      ?.providers?.openai?.models;
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
  });

  it("retains a reference whose successor is route-incompatible", async () => {
    const { cfg, state } = await fixture("oauth");
    const openaiModelRoutes = await import("../agents/openai-model-routes.js");
    const actual = await vi.importActual<typeof import("../agents/openai-model-routes.js")>(
      "../agents/openai-model-routes.js",
    );
    vi.spyOn(openaiModelRoutes, "createOpenAIModelRoutesResolver").mockImplementation(
      actual.createOpenAIModelRoutesResolver,
    );
    cfg.models!.providers!.openai!.api = "openai-chatgpt-responses";
    cfg.models!.providers!.openai!.baseUrl = "https://chatgpt.com/backend-api/codex";
    const warnings: string[] = [];
    const resolve = createRetiredModelRefRepairResolver({
      cfg,
      env: state.env,
      warnings,
    });
    // CHAT-LATEST is platform-only; on the subscription route the provider
    // returns an explicit incompatible route decision without an
    // authoritative flag, which must still block the migration.
    expect(resolve({ modelRef: "openai/retired-incompat-chain", agentId: "main" })).toEqual({
      kind: "unchanged",
    });
    expect(warnings.join("\n")).toContain("successor");
  });

  it("retains a provider-wide retirement whose successor is retired on this route", async () => {
    const { cfg, state } = await fixture("oauth");
    const warnings: string[] = [];
    const resolve = createRetiredModelRefRepairResolver({
      cfg,
      env: state.env,
      warnings,
    });
    // retired-global-parent retires provider-wide (no route condition), while
    // retired-route-child is retired only on the subscription route. An
    // unconditional-only lookup would miss it and migrate onto a retired model.
    expect(resolve({ modelRef: "openai/retired-global-parent", agentId: "main" })).toEqual({
      kind: "unchanged",
    });
    expect(warnings.join("\n")).toContain("successor");
  });

  it.each([
    ["inherited", "qualified"],
    ["local", "qualified"],
    ["explicit-successor", "qualified"],
    ["inherited", "unqualified"],
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

  it("does not write an unsupported successor into fallbacks and policy allow", async () => {
    const { cfg, state } = await fixture("oauth");
    cfg.agents!.defaults!.model = {
      primary: "openai/retired-chain-to-retired",
      fallbacks: ["openai/retired-chain-to-retired", "openai/current-model"],
    };
    cfg.agents!.defaults!.modelPolicy = { allow: ["openai/retired-chain-to-retired"] };
    const warnings: string[] = [];
    const resolve = createRetiredModelRefRepairResolver({
      cfg,
      env: state.env,
      warnings,
    });
    const repaired = repairRetiredConfigModelRefs(cfg, resolve, warnings);
    expect(repaired.config.agents?.defaults?.model).toEqual({
      primary: "openai/retired-chain-to-retired",
      fallbacks: ["openai/retired-chain-to-retired", "openai/current-model"],
    });
    expect(repaired.config.agents?.defaults?.modelPolicy?.allow).toEqual([
      "openai/retired-chain-to-retired",
    ]);
    expect(warnings.join("\n")).toContain("successor");
  });

  it.each([false, true])(
    "still migrates during cooldown (authoritative: %s)",
    async (authoritative) => {
      const { cfg, state } = await fixture("oauth");
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
      if (authoritative) {
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
      const warnings: string[] = [];
      const resolve = createRetiredModelRefRepairResolver({
        cfg,
        env: state.env,
        warnings,
      });
      // A transient cooldown is not proof the successor is unsupported.
      expect(resolve({ modelRef: "openai/retired-with-successor", agentId: "main" })).toEqual({
        kind: "replace",
        modelRef: "openai/current-model",
        reason: "retirement",
        retirementScope: "route",
      });
    },
  );
});
