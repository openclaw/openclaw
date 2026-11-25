import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, onSettled, Show } from "solid-js";
import { projectGateway } from "../lib/reactive/application.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { PluginIconOwner, pluginIconFetchContext } from "../pages/plugins/plugin-icon-owner.ts";

type Props = { pluginId: string; fallback: JSX.Element; class?: string };

function Artwork(props: Props) {
  const context = useApplication();
  const [url, setUrl] = createSignal<string>();
  let active = false;
  const owner = new PluginIconOwner({
    getFetchContext: () => pluginIconFetchContext(context),
    isConnected: () => active,
    onUrlsChange: (urls) => {
      if (active) {
        setUrl(urls[props.pluginId]);
      }
    },
  });
  onSettled(() => {
    active = true;
    owner.load(props.pluginId);
    return () => {
      active = false;
      owner.reset();
    };
  });
  return (
    <Show when={url()} fallback={props.fallback}>
      {(src) => (
        <img
          src={src()}
          class={props.class}
          alt=""
          onError={() => owner.handleError(props.pluginId)}
        />
      )}
    </Show>
  );
}

export default function PluginArtwork(props: Props) {
  const gateway = projectGateway(useApplication().gateway);
  // The same plugin ID can have different artwork on a different Gateway.
  const identity = createMemo(
    () => ({ id: props.pluginId, connection: gateway.read().connectionRevision }),
    {
      equals: (a, b) => a.id === b.id && a.connection === b.connection,
    },
  );
  return (
    <Show when={identity()} keyed>
      {(scope) => <Artwork pluginId={scope.id} fallback={props.fallback} class={props.class} />}
    </Show>
  );
}
