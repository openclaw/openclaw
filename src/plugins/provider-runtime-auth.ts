import type { OAuthCredential } from "../agents/auth-profiles/types.js";
import { unwrapSecretSentinelsForProviderEgress } from "../agents/provider-secret-egress.js";
import { resolveMergedModelProviderConfig } from "../config/model-provider-config.js";
import {
  assertProviderAuthAuthority,
  attachProviderAuthAuthority,
  getProviderAuthAuthority,
} from "./provider-auth-authority.js";
import { resolveProviderRuntimePlugin } from "./provider-hook-runtime.js";
import { resolveProviderRefOwnership } from "./providers.js";
import type {
  ProviderPlugin,
  ProviderPrepareRuntimeAuthContext,
  ProviderPrepareRuntimeAuthContextV2,
} from "./types.js";

type ProviderAuthRuntimeLookup = Pick<
  Parameters<typeof resolveProviderRuntimePlugin>[0],
  "provider" | "config" | "workspaceDir" | "env"
>;

export class UnsupportedProviderRuntimeAuthCapabilityError extends Error {
  constructor() {
    super("Provider credential exchange requires a full chat model; use prepareRuntimeAuthV2.");
    this.name = "UnsupportedProviderRuntimeAuthCapabilityError";
  }
}

export async function prepareProviderRuntimeAuth(
  params: ProviderAuthRuntimeLookup & {
    assertCurrent?: () => void;
    context: ProviderPrepareRuntimeAuthContext | ProviderPrepareRuntimeAuthContextV2;
  },
) {
  if (resolveMergedModelProviderConfig(params.config, params.provider)?.auth === "none") {
    return undefined;
  }
  const plugin = resolveProviderRuntimePlugin(params);
  const prepareRuntimeAuth = plugin?.prepareRuntimeAuth;
  const prepareRuntimeAuthV2 = plugin?.prepareRuntimeAuthV2;
  if (!prepareRuntimeAuth && !prepareRuntimeAuthV2) {
    return undefined;
  }
  const context = params.context;
  // A legacy exchange may require costs or context limits. Never skip it or
  // manufacture those fields when a capability provides only transport identity.
  if (!prepareRuntimeAuthV2 && "capability" in context) {
    throw new UnsupportedProviderRuntimeAuthCapabilityError();
  }
  // The lazy runtime import may outlive the caller's authority to exchange credentials.
  params.assertCurrent?.();
  assertProviderAuthAuthority(params.context.model);
  // Secret material crosses into provider code only when that provider owns an
  // auth hook. Callers can safely pass sentinels without probing plugin state.
  const preparedInput = unwrapSecretSentinelsForProviderEgress(
    params.context.apiKey,
    "provider runtime auth exchange",
  );
  const prepared = prepareRuntimeAuthV2
    ? await prepareRuntimeAuthV2({
        ...context,
        capability: "capability" in context ? context.capability : "chat",
        apiKey: preparedInput,
      })
    : !("capability" in context)
      ? await prepareRuntimeAuth!({ ...context, apiKey: preparedInput })
      : undefined;
  params.assertCurrent?.();
  assertProviderAuthAuthority(params.context.model);
  return prepared
    ? attachProviderAuthAuthority(prepared, getProviderAuthAuthority(params.context.model))
    : prepared;
}

export async function loginProviderOAuthWithPlugin(
  params: ProviderAuthRuntimeLookup & {
    context: Parameters<NonNullable<ProviderPlugin["loginOAuth"]>>[0];
  },
) {
  const ownership = resolveProviderRefOwnership(params);
  const loginOAuth = resolveProviderRuntimePlugin(params)?.loginOAuth;
  if (!loginOAuth) {
    return {
      status: ownership.status === "unowned" ? "unowned" : "configured-unavailable",
    } as const;
  }
  return {
    status: "available" as const,
    credentials: await loginOAuth(params.context),
  };
}

export async function resolveProviderOAuthCredentialWithPlugin(
  params: ProviderAuthRuntimeLookup & {
    credential: OAuthCredential;
    refresh: boolean;
  },
) {
  const ownership = resolveProviderRefOwnership(params);
  const plugin = resolveProviderRuntimePlugin(params);
  if (!plugin) {
    return {
      status: ownership.status === "unowned" ? "unowned" : "configured-unavailable",
    } as const;
  }
  let credential = params.credential;
  if (params.refresh) {
    const refreshOAuth = plugin.refreshOAuth;
    if (!refreshOAuth) {
      return { status: "unhandled" } as const;
    }
    credential = await refreshOAuth.call(plugin, params.credential, params.config);
  }
  if (!credential) {
    return { status: "unhandled" } as const;
  }
  const apiKey = plugin.formatApiKey?.(credential) ?? credential.access;
  if (typeof apiKey !== "string" || !apiKey) {
    return { status: "unhandled" } as const;
  }
  return { status: "available" as const, credential, apiKey };
}

/** Resolve whether the current provider plugin generation owns OAuth refresh. */
export function resolveProviderOAuthRefreshCapabilityWithPlugin(params: ProviderAuthRuntimeLookup) {
  const ownership = resolveProviderRefOwnership(params);
  const plugin = resolveProviderRuntimePlugin(params);
  if (!plugin) {
    return {
      status: ownership.status === "unowned" ? "unowned" : "configured-unavailable",
    } as const;
  }
  return plugin.refreshOAuth
    ? ({ status: "available" } as const)
    : ({ status: "unhandled" } as const);
}

export async function refreshProviderOAuthCredentialWithPlugin(
  params: ProviderAuthRuntimeLookup & { context: OAuthCredential },
) {
  const plugin = resolveProviderRuntimePlugin(params);
  return await plugin?.refreshOAuth?.(params.context, params.config);
}
