import { assert, describe, expect, it, vi } from "vitest";
import type { ImageGenerationProvider } from "../../image-generation/types.js";
import * as mediaGenerationRegistry from "../../media-generation/registry.js";
import { withEnv } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
  createOAuthRefreshCredential,
} from "../auth-profiles/credential-fixtures.test-support.js";
import {
  clearRuntimeAuthProfileStoreSnapshotCore,
  setRuntimeAuthProfileStoreSnapshot,
} from "../auth-profiles/runtime-snapshots.js";
import { hasAnyAuthProfileStoreSourceAsync } from "../auth-profiles/source-check.js";
import { createImageGenerateTool } from "./image-generate-tool.js";

describe("image generation credential availability", () => {
  it("lists newly saved credentials through the same retained tool", async () => {
    await withOpenClawTestState({ label: "image-list-auth-publication" }, async (state) => {
      const agentDir = state.agentDir();
      const provider: ImageGenerationProvider = {
        id: "fixture-image",
        defaultModel: "fixture-model",
        capabilities: {
          generate: { maxCount: 1 },
          edit: { enabled: false, maxInputImages: 0 },
        },
        generateImage: async () => {
          throw new Error("Provider listing must not generate images");
        },
      };
      const providers = vi
        .spyOn(mediaGenerationRegistry, "withImageGenerationProviders")
        .mockImplementation(async (_config, run) => await run([provider]));
      try {
        setRuntimeAuthProfileStoreSnapshot(createAuthProfileStoreFixture({}), agentDir);
        const authProfileStoreSource = await hasAnyAuthProfileStoreSourceAsync(agentDir);
        expect(authProfileStoreSource).toBe(false);
        const tool = createImageGenerateTool({
          config: {
            agents: {
              defaults: { mediaModels: { image: { primary: "fixture-image/fixture-model" } } },
            },
          },
          agentDir,
          workspaceDir: state.workspaceDir,
          authProfileStoreSource,
        });
        assert(tool);

        const before = await tool.execute("list-before-auth-save", { action: "list" });
        expect(before.details).toMatchObject({
          providers: [{ id: "fixture-image", configured: false }],
        });

        await state.writeAuthProfiles(
          createAuthProfileStoreFixture({
            "fixture-image:default": createApiKeyCredential(
              "fixture-image",
              "synthetic-image-api-key",
            ),
          }),
        );

        const after = await tool.execute("list-after-auth-save", { action: "list" });
        expect(after.details).toMatchObject({
          providers: [{ id: "fixture-image", configured: true }],
        });
      } finally {
        providers.mockRestore();
        clearRuntimeAuthProfileStoreSnapshotCore(agentDir);
      }
    });
  });

  it.each([
    {
      authFlow: "chatgpt-token-sharing",
      extraCredential: undefined,
      pinned: false,
      available: false,
    },
    { authFlow: "chatgpt-identity", extraCredential: undefined, pinned: false, available: false },
    {
      authFlow: "chatgpt-token-sharing",
      extraCredential: "api_key",
      pinned: false,
      available: true,
    },
    { authFlow: "chatgpt-token-sharing", extraCredential: "oauth", pinned: false, available: true },
    { authFlow: "chatgpt-token-sharing", extraCredential: "oauth", pinned: true, available: false },
  ] as const)(
    "exposes image generation for $authFlow only with supported auth ($extraCredential, pinned=$pinned)",
    ({ authFlow, extraCredential, pinned, available }) => {
      withEnv({ OPENAI_API_KEY: undefined, OPENAI_API_KEYS: undefined }, () => {
        const oauth = createOAuthRefreshCredential({ expires: Date.now() + 3_600_000 });
        const tool = createImageGenerateTool({
          config: {
            plugins: { allow: ["openai"] },
            ...(pinned
              ? {
                  models: {
                    providers: {
                      openai: {
                        baseUrl: "https://api.openai.com/v1",
                        apiKey: "openai:siwc",
                        models: [],
                      },
                    },
                  },
                }
              : {}),
          },
          authProfileStore: createAuthProfileStoreFixture({
            "openai:siwc": { ...oauth, authFlow },
            ...(extraCredential === "api_key"
              ? { "openai:supported": createApiKeyCredential("openai", "synthetic-key") }
              : extraCredential === "oauth"
                ? { "openai:supported": oauth }
                : {}),
          }),
        });
        expect(tool?.name ?? null).toBe(available ? "image_generate" : null);
      });
    },
  );
});
