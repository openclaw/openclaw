/** Config document that owns a registered secret-bearing target. */
export type SecretTargetConfigFile = "openclaw.json" | "auth-profiles.json"; // pragma: allowlist secret
/** Storage shape used by a target: inline SecretInput or a sibling `*Ref` field. */
export type SecretTargetShape = "secret_input" | "sibling_ref"; // pragma: allowlist secret
/** Resolved value shape accepted by runtime and apply validation. */
export type SecretTargetExpected = "string" | "string-or-object"; // pragma: allowlist secret
/** Auth profile families that have separate secret target coverage. */
export type AuthProfileType = "api_key" | "token";

/**
 * Registry metadata for one configurable secret-bearing value.
 */
export type SecretTargetRegistryEntry = {
  id: string;
  targetType: string;
  targetTypeAliases?: string[];
  configFile: SecretTargetConfigFile;
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

/**
 * Concrete plan/config target after registry pattern matching and capture resolution.
 */
export type ResolvedPlanTarget = {
  entry: SecretTargetRegistryEntry;
  pathSegments: string[];
  refPathSegments?: string[];
  providerId?: string;
  accountId?: string;
};

/**
 * A configured secret target discovered during audit/config scanning.
 */
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
