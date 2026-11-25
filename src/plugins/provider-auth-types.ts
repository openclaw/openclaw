/** Provider secret input modes: inline plaintext or external secret reference. */
export type SecretInputMode = "plaintext" | "ref"; // pragma: allowlist secret

export type ProviderAuthOptionBag = {
  token?: string;
  tokenProvider?: string;
  secretInputMode?: SecretInputMode;
  [key: string]: unknown;
};

export type ProviderNonInteractiveApiKeyResult = {
  key: string;
  source: "profile" | "env" | "flag";
  envVarName?: string;
};

export type ProviderResolveNonInteractiveApiKeyParams = {
  provider: string;
  flagValue?: string;
  flagName: `--${string}`;
  envVar: string;
  envVarName?: string;
  allowProfile?: boolean;
  required?: boolean;
};

export type ProviderNonInteractiveApiKeyCredentialParams = {
  provider: string;
  resolved: ProviderNonInteractiveApiKeyResult;
  email?: string;
  metadata?: Record<string, string>;
};
