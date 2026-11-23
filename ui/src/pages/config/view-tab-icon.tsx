import type { JSX } from "@solidjs/web";
import { createMemo, Show } from "solid-js";
import {
  agentTabIconShape,
  normalizeTabIconPreference,
  type TabIconPreference,
} from "../../../../packages/gateway-protocol/src/schema/tab-icon.ts";
import { controlUiFaviconBaseSvg } from "../../app/control-ui-environment-presentation.runtime.ts";
import { inferControlUiPublicAssetPath } from "../../app/public-assets.ts";
import {
  IdentityAvatarImage,
  createIdentityAvatarPresentation,
} from "../../components/solid/identity-avatar-image.tsx";
import { SettingsRow } from "../../components/solid/settings-ui.tsx";
import { ThemeBrandIcon } from "../../components/theme-brand-icon.tsx";
import { useOptionalApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { themeBrandingProjection } from "../../lib/reactive/theme-branding.ts";
import { PluginAccessories } from "../../plugins/control-ui-accessories.solid.tsx";
import { tabIconContributions } from "../../plugins/control-ui-tab-icons.ts";
import { APPEARANCE_SETTINGS_TARGET_IDS } from "./route-data.ts";

export type TabIconViewProps = {
  tabIcon: TabIconPreference | undefined;
  tabIconAgentAvatar?: string | null;
  setTabIconMode: (mode: TabIconPreference) => void;
};

function FallbackArtwork(props: { fallbackUrl: string }) {
  const branding = themeBrandingProjection;
  return (
    <Show
      when={branding.read().brandIcon === "claw" || branding.read().brandIcon === "mark"}
      fallback={
        <span style={{ display: "contents" }}>
          <ThemeBrandIcon branding={branding.read()} aria-hidden="true" />
        </span>
      }
    >
      <img src={props.fallbackUrl} alt="" />
    </Show>
  );
}

function TabIconAvatar(props: {
  imageUrl: string | null;
  shape?: "circle";
  fallbackUrl: string;
  fallbackOnly?: boolean;
}) {
  const view = createMemo(() => ({ imageUrl: props.imageUrl, pending: false }));
  const presentation = createIdentityAvatarPresentation(view);
  return (
    <Show when={!props.fallbackOnly} fallback={<FallbackArtwork fallbackUrl={props.fallbackUrl} />}>
      <span
        data-avatar-state={presentation.state()}
        class={["identity-avatar--agent settings-tab-icon__preview", presentation.classes()]}
        data-avatar-shape={props.shape ?? "square"}
        aria-hidden="true"
      >
        <Show when={Boolean(view().imageUrl)}>
          <IdentityAvatarImage
            view={view()}
            onStateChange={presentation.onStateChange}
            class="identity-avatar__image"
          />
        </Show>
        <span class="identity-avatar__fallback">
          <FallbackArtwork fallbackUrl={props.fallbackUrl} />
        </span>
      </span>
    </Show>
  );
}

function TabIconPick(props: {
  label: string;
  pressed: boolean;
  onSelect: () => void;
  children: JSX.Element;
}) {
  return (
    <button
      type="button"
      class="settings-tab-icon__pick"
      aria-pressed={props.pressed ? "true" : "false"}
      aria-label={props.label}
      title={props.label}
      onClick={() => props.onSelect()}
    >
      {props.children}
    </button>
  );
}

/* The stored preference is one value, so the picker is one row: every choice is
   visible and picking one never adds or removes a row below it. */
export function TabIconRow(props: TabIconViewProps) {
  const defaultSource = createMemo(
    () => controlUiFaviconBaseSvg() ?? inferControlUiPublicAssetPath("favicon.svg"),
  );
  const context = useOptionalApplication();
  const plugins = context?.plugins && projectOwner(context.plugins, (owner) => owner);
  const contributed = createMemo(() => {
    themeBrandingProjection.read();
    return tabIconContributions(plugins?.read()).map((entry) =>
      entry.value.describe(props.tabIcon ?? "default"),
    );
  });
  const selected = createMemo(() => contributed().find((entry) => entry.selected));
  const hasChoices = () => contributed().some((entry) => entry.hasChoices);
  const selectedShape = createMemo(() => agentTabIconShape(props.tabIcon));
  const selectionName = () =>
    selected()?.label ??
    t(
      selectedShape()
        ? "configView.appearance.tabIcon.agent"
        : "configView.appearance.tabIcon.default",
    );
  const description = () => {
    const detail = contributed().find((entry) => entry.detail)?.detail;
    return detail ? selectionName() + " · " + detail : selectionName();
  };
  return (
    <div id={APPEARANCE_SETTINGS_TARGET_IDS.tabIcon} class="settings-tab-icon">
      <SettingsRow
        title={t("configView.appearance.tabIcon.title")}
        description={description()}
        stacked={hasChoices()}
        stackedOnNarrow
        control={
          <div
            class="settings-tab-icon__picks"
            role="group"
            aria-label={t("configView.appearance.tabIcon.title")}
          >
            <TabIconPick
              label={t("configView.appearance.tabIcon.default")}
              pressed={!selectedShape() && !selected()}
              onSelect={() => props.setTabIconMode("default")}
            >
              <TabIconAvatar imageUrl={null} fallbackUrl={defaultSource()} />
            </TabIconPick>
            <TabIconPick
              label={t("configView.appearance.tabIcon.agent")}
              pressed={selectedShape() !== null}
              onSelect={() => props.setTabIconMode("agent")}
            >
              <TabIconAvatar
                imageUrl={props.tabIconAgentAvatar ?? null}
                shape="circle"
                fallbackUrl={defaultSource()}
              />
            </TabIconPick>
            <PluginAccessories
              placement="tab-icon"
              value={{
                value: props.tabIcon ?? "default",
                onChange: (value) => {
                  const normalized = normalizeTabIconPreference(value);
                  if (normalized) {
                    props.setTabIconMode(normalized);
                  }
                },
              }}
            />
          </div>
        }
      />
    </div>
  );
}
