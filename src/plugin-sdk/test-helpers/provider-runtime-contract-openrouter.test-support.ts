import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import type { ProviderPlugin } from "../provider-model-shared.js";
import { withEnvAsync } from "../test-env.js";

export function registerOpenRouterProviderRuntimeTests(requireProvider: () => ProviderPlugin) {
  it("owns dynamic OpenRouter model defaults", async () => {
    await withEnvAsync(
      {
        ALL_PROXY: "",
        all_proxy: "",
        HTTP_PROXY: "",
        http_proxy: "",
        HTTPS_PROXY: "",
        https_proxy: "",
      },
      async () => {
        const provider = requireProvider();
        const prepare = expectDefined(provider.prepareDynamicModel, "OpenRouter preparation");
        const ctx = {
          provider: "openrouter",
          modelId: "x-ai/grok-4-1-fast",
          modelRegistry: { find: () => null } as never,
        };
        const response = createDeferredCore<Response>();
        const network = vi.spyOn(globalThis, "fetch").mockReturnValue(response.promise);
        try {
          try {
            // A synchronous miss returns defaults while its catalog request is pending.
            expect(provider.resolveDynamicModel?.(ctx)).toMatchObject({
              id: ctx.modelId,
              provider: "openrouter",
              api: "openai-completions",
              baseUrl: "https://openrouter.ai/api/v1",
              maxTokens: 8192,
            });
            expect(network).toHaveBeenCalledWith("https://openrouter.ai/api/v1/models", {
              signal: expect.any(AbortSignal),
            });
          } finally {
            // Join the real background cache writer even when the defaults assertion fails.
            response.resolve(
              Response.json({
                data: [{ id: ctx.modelId, name: "Fetched Grok", max_completion_tokens: 16384 }],
              }),
            );
            await prepare(ctx);
          }
          expect(provider.resolveDynamicModel?.(ctx)).toMatchObject({
            id: ctx.modelId,
            name: "Fetched Grok",
            maxTokens: 16384,
          });
          expect(network).toHaveBeenCalledTimes(1);
        } finally {
          network.mockRestore();
        }
      },
    );
  });
}
