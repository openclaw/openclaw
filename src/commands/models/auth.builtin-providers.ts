import { buildOauthProviderAuthResult } from "../../plugin-sdk/provider-auth-result.js";
import type { ProviderPlugin } from "../../plugins/types.js";
import { OPENAI_CODEX_DEFAULT_MODEL } from "../openai-codex-model-default.js";
import { loginOpenAICodexOAuth } from "../openai-codex-oauth.js";

/**
 * Built-in providers for `models auth login` that don't require a separate plugin.
 * These are first-party OAuth flows whose logic lives in the core package.
 */
export const BUILTIN_AUTH_PROVIDERS: ProviderPlugin[] = [
  {
    id: "openai-codex",
    label: "OpenAI Codex OAuth",
    docsPath: "/providers/openai-codex",
    aliases: ["codex"],
    auth: [
      {
        id: "oauth",
        label: "OpenAI OAuth",
        hint: "Browser-based sign-in (localhost:1455 callback)",
        kind: "oauth",
        run: async (ctx) => {
          const creds = await loginOpenAICodexOAuth({
            prompter: ctx.prompter,
            runtime: ctx.runtime,
            isRemote: ctx.isRemote,
            openUrl: ctx.openUrl,
          });

          if (!creds) {
            // User cancelled / OAuth returned no credentials
            return { profiles: [] };
          }

          return buildOauthProviderAuthResult({
            providerId: "openai-codex",
            defaultModel: OPENAI_CODEX_DEFAULT_MODEL,
            access: creds.access,
            refresh: creds.refresh,
            expires: creds.expires,
            // openai-codex tokens use accountId not email; profile id becomes "openai-codex:default"
            credentialExtra:
              typeof creds.accountId === "string" ? { accountId: creds.accountId } : undefined,
          });
        },
      },
    ],
  },
];
