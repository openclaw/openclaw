/* @vitest-environment jsdom */

import { expect, it } from "vitest";
import type { ModelAuthStatusResult } from "../../api/types.ts";
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

const geminiApiKey = capability("google", {
  apiKeySupported: true,
  quickApiKeySetup: true,
  quickApiKeyGroupLabel: "Gemini API key",
  groupId: "google",
});
const geminiOAuth = capability("gemini", {
  groupId: "google",
  loginOptions: [
    loginOption("gemini-oauth/gemini-oauth", "gemini", "Sign in with Google (AI Ultra)", "oauth", {
      groupLabel: "Google AI Ultra plan",
      featured: true,
    }),
  ],
});

function build(providerCapabilities: ModelAuthStatusResult["providerCapabilities"]) {
  return buildLoginProviders({
    authStatus: { ts: 1, providers: [], providerCapabilities },
    allowQuickApiKey: true,
  });
}

it("shows providers sharing a manifest group as one card that keeps each auth owner", () => {
  expect(build([geminiOAuth, geminiApiKey])).toEqual([
    {
      id: "google",
      label: "Google",
      authProviders: ["gemini", "google"],
      apiKeyProviders: ["google"],
      choices: [
        expect.objectContaining({ id: "gemini-oauth/gemini-oauth", authProvider: "gemini" }),
      ],
      featured: true,
    },
  ]);
});

it("keeps a lone group member's own name", () => {
  expect(build([geminiApiKey])).toMatchObject([{ id: "google", label: "Gemini API key" }]);
});

it("keeps a key form for every key owner a combined card holds", () => {
  const opencode = (provider: string) =>
    capability(provider, {
      apiKeySupported: true,
      quickApiKeySetup: true,
      quickApiKeyGroupLabel: "OpenCode",
      groupId: "opencode",
    });

  expect(build([opencode("opencode"), opencode("opencode-go")])).toMatchObject([
    { id: "opencode", label: "OpenCode", apiKeyProviders: ["opencode", "opencode-go"] },
  ]);
});
