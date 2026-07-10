/**
 * Internal proposal for explicitly forwarding a provider-owned, minimized auth
 * envelope to a CLI backend.
 *
 * Canonical auth-profile material does not cross this boundary. The resolver
 * receives only validated selection metadata and returns a closed execution
 * envelope. This module remains internal until a complete runtime consumer,
 * documentation, and Plugin SDK compatibility baseline are reviewed together.
 */

export type CliBackendForwardedCredentialKind = "api_key" | "oauth" | "token";

export type CliBackendAuthProfileCredential = {
  type: CliBackendForwardedCredentialKind;
  provider: string;
  profileId: string;
};

export type CliBackendAuthProfileForwardingPolicy = {
  supported: true;
  providers: readonly string[];
  credentialKinds: readonly CliBackendForwardedCredentialKind[];
};

export type CliBackendForwardedCredential = {
  kind: CliBackendForwardedCredentialKind;
  providerId: string;
  profileId: string;
  env?: Readonly<Record<string, string>>;
  clearEnv?: readonly string[];
};

export type CliBackendResolveForwardedCredentialContext = {
  backendId: string;
  provider: string;
  modelId: string;
  profileId: string;
  credential: CliBackendAuthProfileCredential;
};

export type CliBackendForwardedCredentialResolver = (
  context: CliBackendResolveForwardedCredentialContext,
) =>
  | CliBackendForwardedCredential
  | null
  | undefined
  | Promise<CliBackendForwardedCredential | null | undefined>;

export type CliBackendAuthForwardingDecision =
  | { status: "not-supported" }
  | { status: "provider-denied"; provider: string }
  | {
      status: "credential-provider-mismatch";
      selectedProvider: string;
      credentialProvider: string;
    }
  | {
      status: "credential-profile-mismatch";
      selectedProfileId: string;
      credentialProfileId: string;
    }
  | { status: "credential-kind-denied"; kind: CliBackendForwardedCredentialKind }
  | { status: "resolver-missing" }
  | { status: "resolver-declined" }
  | { status: "forward"; credential: CliBackendForwardedCredential };

function normalizeId(value: string): string {
  return value.trim();
}

function normalizeIds(values: readonly string[]): Set<string> {
  return new Set(values.map(normalizeId).filter(Boolean));
}

function assertResolvedCredentialMatchesSelection(params: {
  selected: CliBackendResolveForwardedCredentialContext;
  resolved: CliBackendForwardedCredential;
}): void {
  if (params.resolved.providerId !== params.selected.provider) {
    throw new Error(
      `CLI backend credential resolver returned provider ${params.resolved.providerId} for selected provider ${params.selected.provider}.`,
    );
  }
  if (params.resolved.profileId !== params.selected.profileId) {
    throw new Error(
      `CLI backend credential resolver returned profile ${params.resolved.profileId} for selected profile ${params.selected.profileId}.`,
    );
  }
  if (params.resolved.kind !== params.selected.credential.type) {
    throw new Error(
      `CLI backend credential resolver returned kind ${params.resolved.kind} for selected credential kind ${params.selected.credential.type}.`,
    );
  }
}

export async function resolveCliBackendAuthForwarding(params: {
  policy?: CliBackendAuthProfileForwardingPolicy;
  resolver?: CliBackendForwardedCredentialResolver;
  context: CliBackendResolveForwardedCredentialContext;
}): Promise<CliBackendAuthForwardingDecision> {
  if (!params.policy?.supported) {
    return { status: "not-supported" };
  }

  const selectedProvider = normalizeId(params.context.provider);
  const credentialProvider = normalizeId(params.context.credential.provider);
  if (credentialProvider !== selectedProvider) {
    return {
      status: "credential-provider-mismatch",
      selectedProvider,
      credentialProvider,
    };
  }

  const selectedProfileId = normalizeId(params.context.profileId);
  const credentialProfileId = normalizeId(params.context.credential.profileId);
  if (credentialProfileId !== selectedProfileId) {
    return {
      status: "credential-profile-mismatch",
      selectedProfileId,
      credentialProfileId,
    };
  }

  const providers = normalizeIds(params.policy.providers);
  if (!providers.has(selectedProvider)) {
    return { status: "provider-denied", provider: selectedProvider };
  }

  if (!params.policy.credentialKinds.includes(params.context.credential.type)) {
    return {
      status: "credential-kind-denied",
      kind: params.context.credential.type,
    };
  }

  if (!params.resolver) {
    return { status: "resolver-missing" };
  }

  const resolved = await params.resolver(params.context);
  if (!resolved) {
    return { status: "resolver-declined" };
  }

  assertResolvedCredentialMatchesSelection({
    selected: params.context,
    resolved,
  });
  return { status: "forward", credential: resolved };
}
