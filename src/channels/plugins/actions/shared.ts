type OptionalDefaultGate<TKey extends string> = (key: TKey, defaultValue?: boolean) => boolean;

type TokenSourcedAccount = {
  tokenSource?: string | null;
};

export function listTokenSourcedAccounts<TAccount extends TokenSourcedAccount>(
  accounts: readonly TAccount[],
): TAccount[] {
  return accounts.filter((account) => account.tokenSource !== "none");
}

export function createUnionActionGate<TAccount, TKey extends string>(
  accounts: readonly TAccount[],
  createGate: (account: TAccount) => OptionalDefaultGate<TKey>,
): OptionalDefaultGate<TKey> {
  const gates = accounts.map((account) => createGate(account));
  return (key, defaultValue = true) => gates.some((gate) => gate(key, defaultValue));
}
