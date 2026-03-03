export function createAccountActionGate(params) {
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
