/** Predicate for channel actions that can be disabled at base or account scope. */
export type ActionGate<T extends Record<string, boolean | undefined>> = (
  key: keyof T,
  defaultValue?: boolean,
) => boolean;

/** Creates an action gate where account settings override base channel defaults. */
export function createAccountActionGate<T extends Record<string, boolean | undefined>>(params: {
  baseActions?: T;
  accountActions?: T;
}): ActionGate<T> {
  return (key, defaultValue = true) => {
    const accountValue = params.accountActions?.[key];
    if (accountValue !== undefined) {
      // Explicit false is meaningful; only undefined falls through to the broader scope.
      return accountValue;
    }
    const baseValue = params.baseActions?.[key];
    if (baseValue !== undefined) {
      return baseValue;
    }
    return defaultValue;
  };
}
