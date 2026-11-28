/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import { capability, loginOption } from "../../test-helpers/model-providers.ts";
import { buildLoginProviders } from "./login-providers.ts";

it("lists browser sign-in providers before key-only and token-only providers", () => {
  const providers = buildLoginProviders({
    allowQuickApiKey: true,
    authStatus: {
      ts: 1,
      providers: [],
      providerCapabilities: [
        capability("anthropic", {
          featured: true,
          quickApiKeySetup: true,
          quickApiKeyGroupLabel: "Anthropic",
        }),
        capability("gemini", {
          loginOptions: [
            loginOption("gemini-token", "gemini", "Paste token", "secret", {
              groupLabel: "Gemini",
            }),
          ],
        }),
        capability("xai", {
          loginOptions: [
            loginOption("xai-oauth", "xai", "Sign in", "oauth", { groupLabel: "xAI" }),
          ],
        }),
        capability("openai", {
          featured: true,
          quickApiKeySetup: true,
          loginOptions: [
            loginOption("openai-oauth", "openai", "Sign in", "oauth", { groupLabel: "OpenAI" }),
          ],
        }),
        capability("copilot", {
          loginOptions: [
            loginOption("copilot-device", "copilot", "Device code", "device-code", {
              groupLabel: "Copilot",
            }),
          ],
        }),
      ],
    },
  });

  expect(providers.map((provider) => provider.label)).toEqual([
    "Copilot",
    "OpenAI",
    "xAI",
    "Anthropic",
    "Gemini",
  ]);
  expect(providers.filter((provider) => provider.featured).map((provider) => provider.id)).toEqual([
    "openai",
    "anthropic",
  ]);
});
