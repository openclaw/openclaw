export type SecretTargetConfigFile = "openclaw.json" | "auth-profiles.json";
export type SecretTargetShape = "secret_input" | "sibling_ref";
export type SecretTargetExpected = "string" | "string-or-object";
export type AuthProfileType = "api_key" | "token";

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
