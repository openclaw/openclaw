import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { createLazyRuntimeMethodBinder } from "../shared/lazy-runtime.js";

const providerRuntimeLoader = createLazyImportLoader(() => import("./provider-runtime.js"));
// Keep the heavy provider runtime behind an actual async boundary so callers
// can import this wrapper eagerly without collapsing the lazy chunk.
const bindProviderRuntime = createLazyRuntimeMethodBinder(providerRuntimeLoader.load);

export const augmentModelCatalogWithProviderPlugins = bindProviderRuntime(
  (runtime) => runtime.augmentModelCatalogWithProviderPlugins,
);

export const buildProviderAuthDoctorHintWithPlugin = bindProviderRuntime(
  (runtime) => runtime.buildProviderAuthDoctorHintWithPlugin,
);

export const formatProviderAuthProfileApiKeyWithPlugin = bindProviderRuntime(
  (runtime) => runtime.formatProviderAuthProfileApiKeyWithPlugin,
);

export const loginProviderOAuthWithPlugin = bindProviderRuntime(
  (runtime) => runtime.loginProviderOAuthWithPlugin,
);

export const resolveProviderOAuthCredentialWithPlugin = bindProviderRuntime(
  (runtime) => runtime.resolveProviderOAuthCredentialWithPlugin,
);

export const resolveProviderOAuthRefreshCapabilityWithPlugin = bindProviderRuntime(
  (runtime) => runtime.resolveProviderOAuthRefreshCapabilityWithPlugin,
);

export const prepareProviderRuntimeAuth = bindProviderRuntime(
  (runtime) => runtime.prepareProviderRuntimeAuth,
);

export const refreshProviderOAuthCredentialWithPlugin = bindProviderRuntime(
  (runtime) => runtime.refreshProviderOAuthCredentialWithPlugin,
);
