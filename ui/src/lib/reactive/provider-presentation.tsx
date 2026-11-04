import type { JSX } from "@solidjs/web";
import { createContext, createEffect, createSignal, useContext } from "solid-js";
import type { ApplicationGateway } from "../../app/context.ts";
import {
  providerDisplayLabel as defaultProviderLabel,
  type ProviderPresentation,
} from "../../components/provider-icon-data.ts";
import {
  readCachedProviderPresentation,
  subscribeModelCatalogCache,
} from "../model-catalog-cache.ts";

type ProviderLookup = (provider: string) => ProviderPresentation | undefined;
const ProviderPresentationContext = createContext<ProviderLookup>(() => undefined);

export function ProviderPresentationProvider(props: {
  gateway: ApplicationGateway;
  children?: JSX.Element;
}) {
  const [revision, setRevision] = createSignal(0);
  createEffect(
    () => props.gateway.snapshot.client,
    (client) => {
      setRevision((value) => value + 1);
      if (client) {
        return subscribeModelCatalogCache(client, () => setRevision((value) => value + 1));
      }
      return undefined;
    },
  );
  const lookup: ProviderLookup = (provider) => {
    revision();
    return readCachedProviderPresentation(props.gateway.snapshot.client, provider);
  };
  return <ProviderPresentationContext value={lookup}>{props.children}</ProviderPresentationContext>;
}

export function useProviderPresentation(): ProviderLookup {
  return useContext(ProviderPresentationContext);
}

export function useProviderDisplayLabel(): (provider: string) => string {
  const presentation = useProviderPresentation();
  return (provider) => defaultProviderLabel(provider, presentation(provider));
}

/** Chat startup owns its catalog separately from settings reads. */
export function ProviderPresentationScope(props: {
  models: readonly (ProviderPresentation & { provider: string })[];
  children?: JSX.Element;
}) {
  const inherited = useProviderPresentation();
  const lookup: ProviderLookup = (provider) =>
    props.models.find(
      (model) => model.provider === provider && (model.providerName || model.providerIcon),
    ) ?? inherited(provider);
  return <ProviderPresentationContext value={lookup}>{props.children}</ProviderPresentationContext>;
}
