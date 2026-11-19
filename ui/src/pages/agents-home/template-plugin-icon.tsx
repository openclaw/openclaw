import { createMemo, createSignal, onSettled, Show } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { PluginIconOwner, pluginIconFetchContext } from "../plugins/plugin-icon-owner.ts";

export type TemplatePluginPresentation = { name: string; pluginId?: string; imageUrl?: string };

function Artwork(props: { source: string; catalog: boolean }) {
  const context = useApplication();
  const [url, setUrl] = createSignal<string>();
  let active = false;
  const owner = new PluginIconOwner({
    get kind() {
      return props.catalog ? "catalog" : "plugin";
    },
    getFetchContext: () => pluginIconFetchContext(context),
    isConnected: () => active,
    onUrlsChange: (urls) => {
      if (active) {
        setUrl(urls[props.source]);
      }
    },
  });
  onSettled(() => {
    active = true;
    owner.load(props.source);
    return () => {
      active = false;
      owner.reset();
    };
  });
  return (
    <Show when={url()} fallback={<Icon name="plug" />}>
      {(src) => <img src={src()} alt="" onError={() => owner.handleError(props.source)} />}
    </Show>
  );
}

/** Use the same authenticated icon transport as the Plugins page, never a remote image directly. */
export function TemplatePluginIcon(props: { plugin?: TemplatePluginPresentation }) {
  const gateway = projectGateway(useApplication().gateway);
  const identity = createMemo(
    () => ({
      source: props.plugin?.pluginId ?? props.plugin?.imageUrl,
      catalog: !props.plugin?.pluginId,
      connection: gateway.read().connectionRevision,
    }),
    {
      equals: (a, b) =>
        a.source === b.source && a.catalog === b.catalog && a.connection === b.connection,
    },
  );
  return (
    <Show when={identity()} keyed>
      {(scope) =>
        scope.source ? (
          <Artwork source={scope.source} catalog={scope.catalog} />
        ) : (
          <Icon name="plug" />
        )
      }
    </Show>
  );
}
