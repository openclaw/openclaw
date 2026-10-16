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
