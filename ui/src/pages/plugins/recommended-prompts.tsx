import { For, Show } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import type { PluginCatalogItem } from "../../lib/plugins/index.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { PluginArtTile } from "./consent-dialog.tsx";
import { pluginRowKey } from "./plugin-row-message.tsx";
import type { DetailProps } from "./settings-view.tsx";
import "../../styles/plugins.css";

registerEnglishCatalog(registerPluginManagementEnglish);

/** Shared identity treatment for recommendations and their editable composer reference. */
export function PluginPromptMention(props: {
  id: string;
  name: string;
  iconUrl?: string;
  registerIcon?: (readId: () => string) => () => void;
  onIconError?: () => void;
  reference?: boolean;
}) {
  return (
    <span
      class={["plugin-prompt-mention", { "plugin-prompt-mention--reference": props.reference }]}
    >
      <span class="plugin-prompt-mention__mark">
        {props.reference ? <span class="plugin-prompt-mention__at">@</span> : undefined}
        <PluginArtTile
          slug={props.id}
          name=""
          iconUrl={props.iconUrl}
          registerIcon={props.registerIcon}
          onIconError={props.onIconError}
          class="plugin-prompt-mention__icon"
        />
      </span>
      <span>{props.name}</span>
    </span>
  );
}

export function PluginRecommendedPrompts(props: {
  id: string;
  name: string;
  prompts?: readonly string[];
  iconUrl?: string;
  registerIcon?: (readId: () => string) => () => void;
  onIconError?: () => void;
  busy?: boolean;
  disabled?: boolean;
  disabledReason?: string | null;
  onSelect?: (prompt: string) => void;
}) {
  return (
    <Show when={props.prompts?.length}>
      <section
        class="plugin-recommended-prompts"
        aria-label={t("pluginsPage.recommendedPrompts.label")}
      >
        <div class="plugin-recommended-prompts__art" aria-hidden="true">
          <span data-channel="r" />
          <span data-channel="g" />
          <span data-channel="b" />
        </div>
        <div class="plugin-recommended-prompts__list" aria-busy={props.busy ? "true" : "false"}>
          <For each={props.prompts}>
            {(prompt) => (
              <button
                type="button"
                class="btn plugin-recommended-prompts__prompt"
                disabled={props.disabled || props.busy || !props.onSelect}
                title={props.disabledReason ?? undefined}
                onClick={() => props.onSelect?.(prompt)}
              >
                <span class="plugin-recommended-prompts__text">
                  <PluginPromptMention
                    id={props.id}
                    name={props.name}
                    iconUrl={props.iconUrl}
                    registerIcon={props.registerIcon}
                    onIconError={props.onIconError}
                  />{" "}
                  <span>{prompt}</span>
                </span>
                <span class="plugin-recommended-prompts__action" aria-hidden="true">
                  <Show when={props.busy} fallback={<Icon name="arrowRight" />}>
                    <span class="btn__spinner" />
                  </Show>
                </span>
              </button>
            )}
          </For>
        </div>
      </section>
    </Show>
  );
}

/** Prefer the installed release's author metadata over the registry's latest release. */
export function InstalledPluginRecommendedPrompts(props: {
  plugin: PluginCatalogItem;
  state: Pick<
    DetailProps,
    | "inspection"
    | "catalog"
    | "iconUrls"
    | "catalogIconUrls"
    | "registerIcon"
    | "onIconError"
    | "busy"
    | "promptBusy"
    | "promptBlockedReason"
    | "onSelectPrompt"
  >;
}) {
  const catalog = () => props.state.catalog ?? props.state.inspection?.catalog;
  const icon = () => {
    const url = catalog()?.plugin.catalog.imageUrl;
    return (
      props.state.iconUrls[props.plugin.id] ??
      (url ? props.state.catalogIconUrls?.[url] : undefined)
    );
  };
  return (
    <PluginRecommendedPrompts
      id={props.plugin.id}
      name={props.plugin.name}
      prompts={
        props.plugin.recommendedPrompts ??
        props.state.inspection?.overview?.recommendedPrompts ??
        catalog()?.detail.recommendedPrompts
      }
      iconUrl={icon()}
      registerIcon={props.state.registerIcon}
      onIconError={() => props.state.onIconError(props.plugin.id)}
      busy={Boolean(props.state.busy[pluginRowKey(props.plugin.id)]) || props.state.promptBusy}
      disabled={Boolean(props.state.promptBlockedReason)}
      disabledReason={props.state.promptBlockedReason}
      onSelect={props.state.onSelectPrompt}
    />
  );
}
