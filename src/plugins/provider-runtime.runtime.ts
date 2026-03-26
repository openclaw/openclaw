type ProviderRuntimeModule = typeof import("./provider-runtime.js");

type FormatProviderAuthProfileApiKeyWithPlugin =
  ProviderRuntimeModule["formatProviderAuthProfileApiKeyWithPlugin"];
type RefreshProviderOAuthCredentialWithPlugin =
  ProviderRuntimeModule["refreshProviderOAuthCredentialWithPlugin"];
type PrepareProviderRuntimeAuth = ProviderRuntimeModule["prepareProviderRuntimeAuth"];

let providerRuntimePromise: Promise<ProviderRuntimeModule> | undefined;

async function loadProviderRuntime(): Promise<ProviderRuntimeModule> {
  providerRuntimePromise ??= import("./provider-runtime.js");
  return providerRuntimePromise;
}

export async function formatProviderAuthProfileApiKeyWithPlugin(
  ...args: Parameters<FormatProviderAuthProfileApiKeyWithPlugin>
): Promise<Awaited<ReturnType<FormatProviderAuthProfileApiKeyWithPlugin>>> {
  const runtime = await loadProviderRuntime();
  return runtime.formatProviderAuthProfileApiKeyWithPlugin(...args);
}

export async function refreshProviderOAuthCredentialWithPlugin(
  ...args: Parameters<RefreshProviderOAuthCredentialWithPlugin>
): Promise<Awaited<ReturnType<RefreshProviderOAuthCredentialWithPlugin>>> {
  const runtime = await loadProviderRuntime();
  return await runtime.refreshProviderOAuthCredentialWithPlugin(...args);
}

export async function prepareProviderRuntimeAuth(
  ...args: Parameters<PrepareProviderRuntimeAuth>
): Promise<Awaited<ReturnType<PrepareProviderRuntimeAuth>>> {
  const runtime = await loadProviderRuntime();
  return await runtime.prepareProviderRuntimeAuth(...args);
}
