import type { PluginCatalogEntry, PluginsListResult } from "@openclaw/gateway-protocol";
import { createMemo, createSignal, Errored, Loading, onSettled, Show } from "solid-js";
import { canCallGatewayMethod } from "../../../lib/gateway-methods.ts";
import { projectGateway } from "../../../lib/reactive/application.ts";
import { useApplication, useOptionalApplication } from "../../../lib/reactive/context.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import { PluginIconOwner, pluginIconFetchContext } from "../../plugins/plugin-icon-owner.ts";
import { PluginPromptMention } from "../../plugins/recommended-prompts.tsx";

function PluginDraftOverlay(props: { plugin: PluginCatalogEntry; text: string }) {
  const context = useApplication();
  const client = context.gateway.snapshot.client;
  const [icons, setIcons] = createSignal<Record<string, string>>({}, { ownedWrite: true });
  const owner = new PluginIconOwner({
    getFetchContext: () => pluginIconFetchContext(context),
    isConnected: () => context.gateway.snapshot.client === client,
    onUrlsChange: setIcons,
  });
  onSettled(() => {
    if (props.plugin.hasIcon) {
      owner.load(props.plugin.id);
    }
    return () => owner.reset();
  });
  return (
    <span
      class="agent-chat__composer-prediction agent-chat__plugin-draft-overlay"
      aria-hidden="true"
      dir={detectTextDirection(props.text)}
    >
      <PluginPromptMention
        id={props.plugin.id}
        name={props.plugin.id}
        iconUrl={icons()[props.plugin.id]}
        onIconError={() => owner.handleError(props.plugin.id)}
        reference
      />
      {props.text.slice(props.plugin.id.length + 1)}
    </span>
  );
}

/** Branding is advisory. The native textarea remains the sole editing and sending owner. */
export function ComposerPluginPrompt(props: { pluginId: string; text: string }) {
  const context = useOptionalApplication();
  const gateway = context && projectGateway(context.gateway);
  const client = createMemo(() => gateway?.read().snapshot.client);
  const epoch = createMemo(() => gateway?.read().connectionRevision);
  const generation = createMemo(() => gateway?.read().snapshot.pluginCapabilities?.generation);
  const allowed = createMemo(() => {
    const snapshot = gateway?.read().snapshot;
    return snapshot && canCallGatewayMethod(snapshot, "plugins.list", "operator.read");
  });
  const catalog = createMemo(() => {
    epoch();
    generation();
    return allowed()
      ? client()
          ?.request<PluginsListResult>("plugins.list", {})
          .catch(() => null)
      : null;
  });
  return (
    <Errored fallback={() => undefined}>
      <Loading on={[client(), epoch()]} fallback={undefined}>
        <Show
          when={catalog()?.plugins.find(
            (plugin) => plugin.installed && plugin.id === props.pluginId,
          )}
          keyed
        >
          {(plugin) => <PluginDraftOverlay plugin={plugin} text={props.text} />}
        </Show>
      </Loading>
    </Errored>
  );
}
