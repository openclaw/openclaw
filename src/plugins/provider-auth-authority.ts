import type { ProviderCreateStreamFnContext } from "./provider-transport.types.js";

const PROVIDER_AUTH_AUTHORITY = Symbol.for("openclaw.providerAuthAuthority");

type ProviderAuthAuthority = { [PROVIDER_AUTH_AUTHORITY]?: () => void };

/** Keep physical credential ownership across auth/model spreads, without retaining secret bytes. */
export function attachProviderAuthAuthority<T extends object>(
  value: T,
  assertCurrent: (() => void) | undefined,
): T {
  return assertCurrent && getProviderAuthAuthority(value) !== assertCurrent
    ? { ...value, [PROVIDER_AUTH_AUTHORITY]: assertCurrent }
    : value;
}

export function getProviderAuthAuthority(
  value: object | null | undefined,
): (() => void) | undefined {
  // SAFETY: The credential owner writes this private process-local symbol.
  return (value as ProviderAuthAuthority | null | undefined)?.[PROVIDER_AUTH_AUTHORITY];
}

export function assertProviderAuthAuthority(value: object | null | undefined): void {
  getProviderAuthAuthority(value)?.();
}

const PROVIDER_REQUEST_AUTH = Symbol.for("openclaw.providerRequestAuth");
type ProviderRequestAuth = {
  [PROVIDER_REQUEST_AUTH]?: ProviderCreateStreamFnContext["requestAuth"];
};

/** The auth owner binds this capability; model copies retain the same lifetime. */
export function attachProviderRequestAuth<T extends object>(
  value: T,
  requestAuth: ProviderCreateStreamFnContext["requestAuth"],
): T {
  return getProviderRequestAuth(value) === requestAuth
    ? value
    : { ...value, [PROVIDER_REQUEST_AUTH]: requestAuth };
}

export function getProviderRequestAuth(
  value: object,
): ProviderCreateStreamFnContext["requestAuth"] {
  // SAFETY: Only the credential owner writes this private process-local symbol.
  return (value as ProviderRequestAuth)[PROVIDER_REQUEST_AUTH];
}
