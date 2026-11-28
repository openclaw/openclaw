import { providerDisplayLabel as defaultProviderLabel } from "../../components/provider-icon-data.ts";
import { ProviderBrandIcon } from "../../components/solid/provider-icon.tsx";
import { subscribeModelCatalogCache, type ModelCatalogClient } from "../model-catalog-cache.ts";
import { readCachedProviderPresentation } from "../provider-presentation-cache.ts";
import { projectGateway } from "./application.ts";
import { useOptionalApplication } from "./context.ts";
import { createSharedSourceProjection } from "./shared-owner-projection.ts";

type ProviderLookup = (
  provider: string,
) => import("../../components/provider-icon-data.ts").ProviderPresentation | undefined;
const emptyLookup: ProviderLookup = () => undefined;
const projectCatalog = createSharedSourceProjection<ModelCatalogClient, ModelCatalogClient>({
  read: (client) => client,
  subscribe: subscribeModelCatalogCache,
});

/** Connect the existing catalog owner only when a provider-identity surface reads it. */
export function useProviderPresentation(): ProviderLookup {
  const app = useOptionalApplication();
  if (!app) {
    return emptyLookup;
  }
  const gateway = projectGateway(app.gateway);
  return (provider) => {
    const client = gateway.read().snapshot.client;
    return readCachedProviderPresentation(
      client ? projectCatalog(client).read() : undefined,
      provider,
    );
  };
}

export function useProviderDisplayLabel(): (provider: string) => string {
  const presentation = useProviderPresentation();
  return (provider) => defaultProviderLabel(provider, presentation(provider));
}

/** Model-specific surfaces without rows consume the same admitted catalog projection. */
export function ModelProviderIcon(props: Parameters<typeof ProviderBrandIcon>[0]) {
  const presentation = useProviderPresentation();
  return (
    <ProviderBrandIcon
      provider={props.provider}
      presentation={props.presentation ?? presentation(props.provider)}
      class={props.class}
    />
  );
}
