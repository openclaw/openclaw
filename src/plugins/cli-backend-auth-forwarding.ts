/**
 * Proposed public contract for explicitly forwarding selected auth-profile
 * material from a provider to a CLI backend.
 *
 * This module contains no runtime wiring. It defines and validates the boundary
 * so maintainers can review the API independently before integrating it into the
 * CLI runner.
 */

export type CliBackendForwardedCredentialKind = "api_key" | "oauth" | "token";

export type CliBackendAuthProfileCredential = {
  type: CliBackendForwardedCredentialKind;
  provider: string;
} & Record<string, unknown>;

export type CliBackendAuthProfileForwardingPolicy = {
  supported: true;
  providers: readonly string[];
  credentialKinds: readonly CliBackendForwardedCredentialKind[];
};

export type CliBackendForwardedCredential = {
  kind: CliBackendForwardedCredentialKind;
  providerId: string;
  profileId: string;
} & Record<string, unknown>;

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
  | { status: "credential-kind-denied"; kind: CliBackendForwardedCredentialKind }
  | { status: "resolver-missing" }
  | { status: "resolver-declined" }
  | { status: "forward"; credential: CliBackendForwardedCredential };

function normalizeIds(values: readonly string[]): Set<string> {
  return new Set(values.map((value) => value.trim()).filter(Boolean));
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

  const providers = normalizeIds(params.policy.providers);
  if (!providers.has(params.context.provider)) {
    return { status: "provider-denied", provider: params.context.provider };
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
