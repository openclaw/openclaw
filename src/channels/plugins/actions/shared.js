export function listTokenSourcedAccounts(accounts) {
    return accounts.filter((account) => account.tokenSource !== "none");
}
export function createUnionActionGate(accounts, createGate) {
    const gates = accounts.map((account) => createGate(account));
    return (key, defaultValue = true) => gates.some((gate) => gate(key, defaultValue));
}
