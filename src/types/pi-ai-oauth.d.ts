declare module "@mariozechner/pi-ai/oauth" {
  import type { OAuthCredentials, OAuthProvider } from "@mariozechner/pi-ai";

  export function getOAuthApiKey(
    provider: OAuthProvider,
    credentialsByProvider: Record<string, OAuthCredentials>,
  ): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null>;

  export function getOAuthProviders(): Array<{
    id: OAuthProvider;
    envApiKey?: string;
    oauthTokenEnv?: string;
  }>;

  export function loginOpenAICodex(params: {
    onAuth?: (event: { url: string }) => Promise<void> | void;
    onPrompt?: (prompt: {
      message: string;
      placeholder?: string;
    }) => Promise<string | undefined> | string | undefined;
    onProgress?: (message: string) => void;
  }): Promise<OAuthCredentials | null>;
}
