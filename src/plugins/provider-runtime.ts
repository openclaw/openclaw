import { getOAuthApiKey } from "@mariozechner/pi-ai/oauth";
import type { AuthProfileCredential, OAuthCredential } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/config.js";

type CommonParams = {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
};

function isOpenAICodexProvider(provider: string): boolean {
  return provider === "openai-codex";
}

export function formatProviderAuthProfileApiKeyWithPlugin(
  params: CommonParams & { context: AuthProfileCredential },
): string | undefined {
  if (
    params.provider === "google-gemini-cli" &&
    params.context.type === "oauth" &&
    typeof params.context.projectId === "string" &&
    params.context.projectId.length > 0
  ) {
    return JSON.stringify({
      token: params.context.access,
      projectId: params.context.projectId,
    });
  }
  return undefined;
}

export async function refreshProviderOAuthCredentialWithPlugin(
  params: CommonParams & { context: OAuthCredential },
): Promise<OAuthCredential | undefined> {
  if (!isOpenAICodexProvider(params.provider)) {
    return undefined;
  }
  try {
    const refreshed = await getOAuthApiKey("openai-codex", {
      "openai-codex": params.context,
    });
    if (!refreshed) {
      return undefined;
    }
    return {
      ...params.context,
      ...refreshed.newCredentials,
      type: "oauth",
      provider: params.provider,
      email: params.context.email,
      clientId: params.context.clientId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      /extract\s+accountid\s+from\s+token/i.test(message) &&
      typeof params.context.access === "string" &&
      params.context.access.trim().length > 0
    ) {
      return params.context;
    }
    throw error;
  }
}

export async function prepareProviderRuntimeAuth(
  _params: CommonParams & {
    context: {
      apiKey: string;
      authMode?: string;
      profileId?: string;
      provider: string;
      modelId: string;
      model: unknown;
      agentDir?: string;
      workspaceDir?: string;
      config?: OpenClawConfig;
      env?: NodeJS.ProcessEnv;
    };
  },
): Promise<{ apiKey?: string; baseUrl?: string; expiresAt?: number } | undefined> {
  return undefined;
}
