import type { ModelAuthStatusResult } from "../../api/types.ts";

export const googleAuthProviders = [
  {
    provider: "google",
    displayName: "Google",
    status: "static",
    profiles: [{ profileId: "google:key", type: "api_key", status: "static" }],
    apiKey: { source: "env", envVar: "GEMINI_API_KEY" },
  },
  {
    provider: "google-gemini-cli",
    displayName: "Gemini CLI",
    status: "ok",
    profiles: [{ profileId: "google:oauth", type: "oauth", status: "ok" }],
    usage: {
      providerId: "google",
      authProfileId: "google:oauth",
      windows: [],
      plan: "Gemini Pro",
    },
  },
] satisfies ModelAuthStatusResult["providers"];

export const subscriptionProfiles = [
  { profileId: "openai:work", type: "oauth", status: "ok", email: "work@example.com" },
  { profileId: "openai:personal", type: "oauth", status: "ok", email: "peter@steipete.me" },
] satisfies ModelAuthStatusResult["providers"][number]["profiles"];
export const authStatus: ModelAuthStatusResult = {
  ts: 1,
  providers: [
    {
      provider: "openai-codex",
      displayName: "OpenAI",
      status: "ok",
      profiles: subscriptionProfiles,
      profileOrder: ["openai:personal", "openai:work"],
      usage: {
        providerId: "openai",
        authProfileId: "openai:personal",
        windows: [],
        plan: "ChatGPT Pro",
      },
    },
  ],
};
