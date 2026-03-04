import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import {
  buildVivgridProvider,
  buildVivgridProviderWithDiscovery,
  VIVGRID_BASE_URL,
} from "./vivgrid-models.js";

describe("vivgrid-models", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("buildVivgridProvider returns default completions provider", () => {
    const provider = buildVivgridProvider();
    expect(provider.baseUrl).toBe(VIVGRID_BASE_URL);
    expect(provider.api).toBe("openai-completions");
    expect(provider.models).toHaveLength(1);
    expect(provider.models[0]?.id).toBe("gpt-5-mini");
  });

  it("maps discovered model ids to model-level APIs by naming rules", async () => {
    await withEnvAsync({ VITEST: undefined, NODE_ENV: undefined }, async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: "gpt-codex-1" }, { id: "claude-sonnet-4" }, { id: "gpt-4o-mini" }],
        }),
      } as Response);

      const provider = await buildVivgridProviderWithDiscovery({ baseUrl: `${VIVGRID_BASE_URL}/` });

      expect(provider.baseUrl).toBe(VIVGRID_BASE_URL);
      expect(provider.models.map((m) => m.id)).toEqual([
        "gpt-codex-1",
        "claude-sonnet-4",
        "gpt-4o-mini",
      ]);
      expect(provider.models.find((m) => m.id === "gpt-codex-1")?.api).toBe("openai-responses");
      expect(provider.models.find((m) => m.id === "claude-sonnet-4")?.api).toBe(
        "anthropic-messages",
      );
      expect(provider.models.find((m) => m.id === "gpt-4o-mini")?.api).toBeUndefined();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledWith(
        `${VIVGRID_BASE_URL}/models`,
        expect.objectContaining({ headers: undefined }),
      );
    });
  });

  it("falls back to static model list when discovery fails", async () => {
    await withEnvAsync({ VITEST: undefined, NODE_ENV: undefined }, async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, status: 403 } as Response);

      const provider = await buildVivgridProviderWithDiscovery();

      expect(provider.models.map((m) => m.id)).toEqual(["gpt-5-mini"]);
      expect(provider.api).toBe("openai-completions");
    });
  });

  it("resolves env-var indirection for discovery api key", async () => {
    await withEnvAsync(
      { VITEST: undefined, NODE_ENV: undefined, VIVGRID_DISCOVERY_KEY: "vk-live-secret" },
      async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
          ok: true,
          json: async () => ({ data: [{ id: "model-a" }] }),
        } as Response);

        await buildVivgridProviderWithDiscovery({ apiKey: "VIVGRID_DISCOVERY_KEY" });

        const requestInit = fetchSpy.mock.calls[0]?.[1];
        expect(requestInit?.headers).toEqual({ Authorization: "Bearer vk-live-secret" });
      },
    );
  });
});
