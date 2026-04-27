let providerRuntimePromise;
async function loadProviderRuntime() {
    // Keep the heavy provider runtime behind an actual async boundary so callers
    // can import this wrapper eagerly without collapsing the lazy chunk.
    providerRuntimePromise ??= import("./provider-runtime.js");
    return providerRuntimePromise;
}
export async function augmentModelCatalogWithProviderPlugins(...args) {
    const runtime = await loadProviderRuntime();
    return runtime.augmentModelCatalogWithProviderPlugins(...args);
}
export async function buildProviderAuthDoctorHintWithPlugin(...args) {
    const runtime = await loadProviderRuntime();
    return runtime.buildProviderAuthDoctorHintWithPlugin(...args);
}
export async function buildProviderMissingAuthMessageWithPlugin(...args) {
    const runtime = await loadProviderRuntime();
    return runtime.buildProviderMissingAuthMessageWithPlugin(...args);
}
export async function formatProviderAuthProfileApiKeyWithPlugin(...args) {
    const runtime = await loadProviderRuntime();
    return runtime.formatProviderAuthProfileApiKeyWithPlugin(...args);
}
export async function prepareProviderRuntimeAuth(...args) {
    const runtime = await loadProviderRuntime();
    return runtime.prepareProviderRuntimeAuth(...args);
}
export async function refreshProviderOAuthCredentialWithPlugin(...args) {
    const runtime = await loadProviderRuntime();
    return runtime.refreshProviderOAuthCredentialWithPlugin(...args);
}
