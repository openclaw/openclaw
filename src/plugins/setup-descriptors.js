export function listSetupProviderIds(record) {
    return record.setup?.providers?.map((entry) => entry.id) ?? record.providers;
}
export function listSetupCliBackendIds(record) {
    return record.setup?.cliBackends ?? record.cliBackends;
}
