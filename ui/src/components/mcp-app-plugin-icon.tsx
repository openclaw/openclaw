import { createMemo, createSignal, onSettled, Show } from "solid-js";
import type { McpAppIcon as AppIcon } from "../../../src/shared/mcp-app-extensions.js";
import { projectGateway } from "../lib/reactive/application.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { PluginIconOwner, pluginIconFetchContext } from "../pages/plugins/plugin-icon-owner.ts";
import { McpAppIcon } from "./mcp-app-icon.tsx";

type Props = { pluginId: string; icons: readonly AppIcon[]; class?: string };

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
    <Show when={url()} fallback={<McpAppIcon icons={props.icons} class={props.class} />}>
      {(src) => (
        <img
          src={src()}
          class={props.class ?? "mcp-app-icon"}
          alt=""
          onError={() => owner.handleError(props.pluginId)}
        />
      )}
    </Show>
  );
}

export default function PluginAppIcon(props: Props) {
  const gateway = projectGateway(useApplication().gateway);
  // Artwork belongs to one connection, just like the App that requested it.
  const identity = createMemo(
    () => ({ id: props.pluginId, connection: gateway.read().connectionRevision }),
    {
      equals: (a, b) => a.id === b.id && a.connection === b.connection,
    },
  );
  return (
    <Show when={identity()} keyed>
      {(scope) => <Artwork pluginId={scope.id} icons={props.icons} class={props.class} />}
    </Show>
  );
}
