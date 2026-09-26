/**
 * Resolves whether an account-scoped action is enabled.
 */
type ActionGate<T extends Record<string, boolean | undefined>> = (
  key: keyof T,
  defaultValue?: boolean,
) => boolean;

/**
 * Creates an action gate where account-specific flags override channel-level defaults.
 */
export function createAccountActionGate<T extends Record<string, boolean | undefined>>(params: {
  baseActions?: T;
  accountActions?: T;
}): ActionGate<T> {
  return (key, defaultValue = true) =>
    params.accountActions?.[key] ?? params.baseActions?.[key] ?? defaultValue;
}
