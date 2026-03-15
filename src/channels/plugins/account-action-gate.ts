export type ActionGate<T extends Record<string, boolean | undefined>> = (
  key: keyof T,
  defaultValue?: boolean,
) => boolean;

export function createAccountActionGate<T extends Record<string, boolean | undefined>>(params: {
  baseActions?: T;
  accountActions?: T;
}): ActionGate<T> {
  return (key, defaultValue = true) => {
    const accountValue = params.accountActions?.[key];
    if (accountValue !== undefined) {
      return accountValue;
    }
    const baseValue = params.baseActions?.[key];
    if (baseValue !== undefined) {
      return baseValue;
    }
    return defaultValue;
  };
}
