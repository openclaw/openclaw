import { describe, expect, it } from "vitest";
import { withEnv } from "../../test-utils/env.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
  createOAuthRefreshCredential,
} from "../auth-profiles/credential-fixtures.test-support.js";
import { createImageGenerateTool } from "./image-generate-tool.js";

describe("image generation credential availability", () => {
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
