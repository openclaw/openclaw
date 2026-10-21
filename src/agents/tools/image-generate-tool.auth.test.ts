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
import { prepareSharedAuthStoreOwnershipForNative } from "../auth-profiles/path-resolve.native.js";
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
        prepareSharedAuthStoreOwnershipForNative(state.env);
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

        expect(
          (await tool.execute("list-before-auth-save", { action: "list" })).details,
        ).toMatchObject({
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

        expect(
          (await tool.execute("list-after-auth-save", { action: "list" })).details,
        ).toMatchObject({
          providers: [{ id: "fixture-image", configured: true }],
        });
      } finally {
        providers.mockRestore();
        clearRuntimeAuthProfileStoreSnapshotCore(agentDir);
      }
    });
  });

  it.each([
    ["chatgpt-token-sharing", undefined, false, false],
    ["chatgpt-identity", undefined, false, false],
    ["chatgpt-token-sharing", "api_key", false, true],
    ["chatgpt-token-sharing", "oauth", false, true],
    ["chatgpt-token-sharing", "oauth", true, false],
  ] as const)(
    "exposes image generation for %s with credential %s, pinned=%s: %s",
    (authFlow, extraCredential, pinned, available) => {
      withEnv({ OPENAI_API_KEY: undefined, OPENAI_API_KEYS: undefined }, () => {
        const oauth = createOAuthRefreshCredential({ expires: Date.now() + 3_600_000 });
        const openai = { baseUrl: "https://api.openai.com/v1", apiKey: "openai:siwc", models: [] };
        const tool = createImageGenerateTool({
          config: {
            plugins: { allow: ["openai"] },
            models: pinned ? { providers: { openai } } : undefined,
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
