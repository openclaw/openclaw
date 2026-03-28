type ProviderRuntimeModule = typeof import("./provider-runtime.js");

type AugmentModelCatalogWithProviderPlugins =
  ProviderRuntimeModule["augmentModelCatalogWithProviderPlugins"];
type BuildProviderAuthDoctorHintWithPlugin =
  ProviderRuntimeModule["buildProviderAuthDoctorHintWithPlugin"];
type BuildProviderMissingAuthMessageWithPlugin =
  ProviderRuntimeModule["buildProviderMissingAuthMessageWithPlugin"];
type FormatProviderAuthProfileApiKeyWithPlugin =
  ProviderRuntimeModule["formatProviderAuthProfileApiKeyWithPlugin"];
type PrepareProviderRuntimeAuth = ProviderRuntimeModule["prepareProviderRuntimeAuth"];
type RefreshProviderOAuthCredentialWithPlugin =
  ProviderRuntimeModule["refreshProviderOAuthCredentialWithPlugin"];

let providerRuntimePromise: Promise<ProviderRuntimeModule> | undefined;

async function loadProviderRuntime(): Promise<ProviderRuntimeModule> {
  // Keep the heavy provider runtime behind an actual async boundary so callers
  // can import this wrapper eagerly without collapsing the lazy chunk.
  providerRuntimePromise ??= import("./provider-runtime.js");
  return providerRuntimePromise;
}

export async function augmentModelCatalogWithProviderPlugins(
  ...args: Parameters<AugmentModelCatalogWithProviderPlugins>
): Promise<Awaited<ReturnType<AugmentModelCatalogWithProviderPlugins>>> {
  const runtime = await loadProviderRuntime();
  return runtime.augmentModelCatalogWithProviderPlugins(...args);
}

export async function buildProviderAuthDoctorHintWithPlugin(
  ...args: Parameters<BuildProviderAuthDoctorHintWithPlugin>
): Promise<Awaited<ReturnType<BuildProviderAuthDoctorHintWithPlugin>>> {
  const runtime = await loadProviderRuntime();
  return runtime.buildProviderAuthDoctorHintWithPlugin(...args);
}

export async function buildProviderMissingAuthMessageWithPlugin(
  ...args: Parameters<BuildProviderMissingAuthMessageWithPlugin>
): Promise<Awaited<ReturnType<BuildProviderMissingAuthMessageWithPlugin>>> {
  const runtime = await loadProviderRuntime();
  return runtime.buildProviderMissingAuthMessageWithPlugin(...args);
}

export async function formatProviderAuthProfileApiKeyWithPlugin(
  ...args: Parameters<FormatProviderAuthProfileApiKeyWithPlugin>
): Promise<Awaited<ReturnType<FormatProviderAuthProfileApiKeyWithPlugin>>> {
  const runtime = await loadProviderRuntime();
  return runtime.formatProviderAuthProfileApiKeyWithPlugin(...args);
}

export async function prepareProviderRuntimeAuth(
  ...args: Parameters<PrepareProviderRuntimeAuth>
): Promise<Awaited<ReturnType<PrepareProviderRuntimeAuth>>> {
  const runtime = await loadProviderRuntime();
  return runtime.prepareProviderRuntimeAuth(...args);
}

export async function refreshProviderOAuthCredentialWithPlugin(
  ...args: Parameters<RefreshProviderOAuthCredentialWithPlugin>
): Promise<Awaited<ReturnType<RefreshProviderOAuthCredentialWithPlugin>>> {
  const runtime = await loadProviderRuntime();
  return runtime.refreshProviderOAuthCredentialWithPlugin(...args);
}
