export const OPENCLAW_CONFIG_TARGET_STORE = "openclaw.json" as const;
export const AUTH_PROFILE_TARGET_STORE = "auth-profile-store" as const; // pragma: allowlist secret
export type SecretTargetStore =
  | typeof OPENCLAW_CONFIG_TARGET_STORE
  | typeof AUTH_PROFILE_TARGET_STORE;
export type SecretTargetShape = "secret_input" | "sibling_ref"; // pragma: allowlist secret
export type SecretTargetExpected = "string" | "string-or-object"; // pragma: allowlist secret
export type AuthProfileType = "api_key" | "token";

export type SecretTargetRegistryEntry = {
  id: string;
  targetType: string;
  targetTypeAliases?: string[];
  store: SecretTargetStore;
  pathPattern: string;
  refPathPattern?: string;
  secretShape: SecretTargetShape;
  expectedResolvedValue: SecretTargetExpected;
  includeInPlan: boolean;
  includeInConfigure: boolean;
  includeInAudit: boolean;
  providerIdPathSegmentIndex?: number;
  accountIdPathSegmentIndex?: number;
  authProfileType?: AuthProfileType;
  trackProviderShadowing?: boolean;
};

export type ResolvedPlanTarget = {
  entry: SecretTargetRegistryEntry;
  pathSegments: string[];
  refPathSegments?: string[];
  providerId?: string;
  accountId?: string;
};

export type DiscoveredConfigSecretTarget = {
  entry: SecretTargetRegistryEntry;
  path: string;
  pathSegments: string[];
  refPath?: string;
  refPathSegments?: string[];
  value: unknown;
  refValue?: unknown;
  providerId?: string;
  accountId?: string;
};
