import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { createLazyRuntimeMethodBinder } from "../shared/lazy-runtime.js";

// Keep each execution owner behind the same deferred invocation boundary.
const bindProviderAuth = createLazyRuntimeMethodBinder(
  createLazyImportLoader(() => import("./provider-runtime-auth.js")).load,
);
const bindProviderCatalog = createLazyRuntimeMethodBinder(
  createLazyImportLoader(() => import("./provider-catalog-augment.js")).load,
);

export const augmentModelCatalogWithProviderPlugins = bindProviderCatalog(
  (runtime) => runtime.augmentModelCatalogWithProviderPlugins,
);

export const formatProviderAuthProfileApiKeyWithPlugin = bindProviderAuth(
  (runtime) => runtime.formatProviderAuthProfileApiKeyWithPlugin,
);

export const loginProviderOAuthWithPlugin = bindProviderAuth(
  (runtime) => runtime.loginProviderOAuthWithPlugin,
);

export const resolveProviderOAuthCredentialWithPlugin = bindProviderAuth(
  (runtime) => runtime.resolveProviderOAuthCredentialWithPlugin,
);

export const resolveProviderOAuthRefreshCapabilityWithPlugin = bindProviderAuth(
  (runtime) => runtime.resolveProviderOAuthRefreshCapabilityWithPlugin,
);

export const prepareProviderRuntimeAuth = bindProviderAuth(
  (runtime) => runtime.prepareProviderRuntimeAuth,
);

export const refreshProviderOAuthCredentialWithPlugin = bindProviderAuth(
  (runtime) => runtime.refreshProviderOAuthCredentialWithPlugin,
);
