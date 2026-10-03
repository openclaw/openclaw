import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  readPreparedCatalog,
  registerGatewayModelCatalogPrivateAccess,
} from "../server-model-catalog-auth.js";
import { buildModelsListResult } from "./models-list-result.js";
import {
  createModelsListTestContext,
  providerCatalogEntry,
} from "./models-list-result.openai-routes.test-support.js";

async function withPublishedCatalog(
  run: (context: ReturnType<typeof createModelsListTestContext>) => Promise<void>,
) {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "published-catalog-read-" },
    async (state) => {
      await run(
        createModelsListTestContext({
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          catalog: [providerCatalogEntry("ollama", "published-model")],
          cfg: {
            agents: {
              defaults: {
                model: { primary: "ollama/published-model" },
                modelPolicy: { allow: ["ollama/*"] },
              },
            },
          },
        }),
      );
    },
  );
}

describe("models.list published inventory", () => {
  it("refuses a retired generation and permits a later current read without discovery", async () => {
    await withPublishedCatalog(async (context) => {
      const first = expectDefined(
        await readPreparedCatalog(context, "main"),
        "Published catalog fixture must supply its owner",
      );
      let published = { ...first, isCurrent: () => false };
      const loadDeferred = vi.fn(async () => published);
      registerGatewayModelCatalogPrivateAccess(context.loadGatewayModelCatalogSnapshot, {
        loadDeferred,
        readPrepared: async () => published,
      });
      await expect(
        buildModelsListResult({
          source: { kind: "gateway", context },
          agentId: "main",
          params: { view: "all" },
        }),
      ).rejects.toThrow("Model catalog changed");
      published = { ...first, isCurrent: () => true };
      const current = await buildModelsListResult({
        source: { kind: "gateway", context },
        agentId: "main",
        params: { view: "all" },
      });
      expect(current.models.some((model) => model.id === "published-model")).toBe(true);
      expect(loadDeferred).not.toHaveBeenCalled();
    });
  });

  it.each(["default", "configured", "provider-config", "all"] as const)(
    "reads the %s view without discovery",
    async (view) => {
      await withPublishedCatalog(async (context) => {
        const published = expectDefined(
          await readPreparedCatalog(context, "main"),
          "Published catalog fixture must supply its owner",
        );
        const loadDeferred = vi.fn(async () => {
          throw new Error("Ordinary inventory attempted discovery");
        });
        registerGatewayModelCatalogPrivateAccess(context.loadGatewayModelCatalogSnapshot, {
          loadDeferred,
          readPrepared: async () => published,
        });
        await buildModelsListResult({
          source: { kind: "gateway", context },
          agentId: "main",
          params: { view },
        });
        expect(loadDeferred).not.toHaveBeenCalled();
      });
    },
  );

  it("reports a missing published owner without starting acquisition", async () => {
    await withPublishedCatalog(async (context) => {
      const published = expectDefined(
        await readPreparedCatalog(context, "main"),
        "Published catalog fixture must supply its owner",
      );
      const loadDeferred = vi.fn(async () => published);
      registerGatewayModelCatalogPrivateAccess(context.loadGatewayModelCatalogSnapshot, {
        loadDeferred,
        readPrepared: async () => undefined,
      });
      await expect(
        buildModelsListResult({
          source: { kind: "gateway", context },
          agentId: "main",
          params: {},
        }),
      ).rejects.toThrow("Model catalog is not ready");
      expect(loadDeferred).not.toHaveBeenCalled();
    });
  });

  it("returns the generation published by an explicit refresh", async () => {
    await withPublishedCatalog(async (context) => {
      let published = expectDefined(
        await readPreparedCatalog(context, "main"),
        "Published catalog fixture must supply its owner",
      );
      const refreshed = providerCatalogEntry("ollama", "refreshed-model");
      const loadDeferred = vi.fn(async () => {
        published = { ...published, entries: [refreshed], routeVariants: [refreshed] };
        return published;
      });
      registerGatewayModelCatalogPrivateAccess(context.loadGatewayModelCatalogSnapshot, {
        loadDeferred,
        readPrepared: async () => published,
      });
      const result = await buildModelsListResult({
        source: { kind: "gateway", context },
        agentId: "main",
        params: { view: "all", refresh: true },
      });
      expect(result.models.some((model) => model.id === "refreshed-model")).toBe(true);
      expect(loadDeferred).toHaveBeenCalledExactlyOnceWith({
        agentId: "main",
        readOnly: false,
        refreshFullCatalog: true,
      });
    });
  });
});
