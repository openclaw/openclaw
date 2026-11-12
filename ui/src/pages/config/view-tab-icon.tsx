import type { JSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import {
  agentTabIconShape,
  type TabIconPreference,
  type AgentTabIconShape,
} from "../../../../packages/gateway-protocol/src/schema/tab-icon.ts";
import { controlUiFaviconBaseSvg } from "../../app/control-ui-environment-presentation.runtime.ts";
import { inferControlUiPublicAssetPath } from "../../app/public-assets.ts";
import { LobsterSvg } from "../../components/lobster-pet-artwork.tsx";
import type { LobsterPetPalette } from "../../components/lobster-pet-contract.ts";
import { canonicalLobsterLook, lobsterLookStyle } from "../../components/lobster-pet-identity.ts";
import { lobsterPaletteName } from "../../components/lobster-pet-lore.ts";
import {
  IdentityAvatarImage,
  createIdentityAvatarPresentation,
} from "../../components/solid/identity-avatar-image.tsx";
import { SettingsRow } from "../../components/solid/settings-ui.tsx";
import { ThemeBrandIcon } from "../../components/theme-brand-icon.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { themeBrandingProjection } from "../../lib/reactive/theme-branding.ts";
import { APPEARANCE_SETTINGS_TARGET_IDS } from "./route-data.ts";

export type TabIconViewProps = {
  tabIcon: TabIconPreference | undefined;
  lobsterdexEnabled?: boolean;
  tabIconAgentAvatar?: string | null;
  tabIconLobsters?: readonly LobsterPetPalette[];
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
  shape?: AgentTabIconShape;
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

const SHAPE_CHOICES = [
  ["square", "agent"],
  ["rounded", "agent:rounded"],
  ["circle", "agent:circle"],
] as const;

function LobsterPreview(props: { palette: LobsterPetPalette }) {
  const look = createMemo(() => canonicalLobsterLook(props.palette));
  return (
    <span
      class={["lobster-pet settings-tab-icon__lobster", `lobster-pet--palette-${props.palette.id}`]}
      style={lobsterLookStyle(look())}
      aria-hidden="true"
    >
      <LobsterSvg look={look()} standalone />
    </span>
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
  const lobsterdexEnabled = () => props.lobsterdexEnabled !== false;
  const lobsters = createMemo(() => (lobsterdexEnabled() ? (props.tabIconLobsters ?? []) : []));
  const lobsterMode = () => lobsterdexEnabled() && (props.tabIcon?.startsWith("lobster:") ?? false);
  const selectedShape = createMemo(() => agentTabIconShape(props.tabIcon));
  const selected = createMemo(() =>
    lobsters().find((palette) => props.tabIcon === `lobster:${palette.id}`),
  );
  const agentLabel = (shape: AgentTabIconShape) =>
    `${t("configView.appearance.tabIcon.agent")} · ${t(`configView.appearance.tabIcon.${shape}`)}`;
  const selectionName = () => {
    const palette = selected();
    const shape = selectedShape();
    return palette
      ? lobsterPaletteName(palette.id)
      : shape
        ? agentLabel(shape)
        : t("configView.appearance.tabIcon.default");
  };
  const description = () => {
    if (lobsterMode() && !selected()) {
      return t("configView.appearance.tabIcon.unavailable");
    }
    if (selected()) {
      return `${selectionName()} · ${t("configView.appearance.tabIcon.localCollection")}`;
    }
    return lobsterdexEnabled() && lobsters().length === 0
      ? `${selectionName()} · ${t("configView.appearance.tabIcon.empty")}`
      : selectionName();
  };
  return (
    <div id={APPEARANCE_SETTINGS_TARGET_IDS.tabIcon} class="settings-tab-icon">
      <SettingsRow
        title={t("configView.appearance.tabIcon.title")}
        description={description()}
        stacked={lobsters().length > 0}
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
            <For each={SHAPE_CHOICES}>
              {([choice, preference]) => (
                <TabIconPick
                  label={agentLabel(choice)}
                  pressed={selectedShape() === choice}
                  onSelect={() => props.setTabIconMode(preference)}
                >
                  <TabIconAvatar
                    imageUrl={props.tabIconAgentAvatar ?? null}
                    shape={choice}
                    fallbackUrl={defaultSource()}
                  />
                </TabIconPick>
              )}
            </For>
            <For each={lobsters()} keyed={(entry) => entry.id}>
              {(palette) => (
                <TabIconPick
                  label={lobsterPaletteName(palette().id)}
                  pressed={selected()?.id === palette().id}
                  onSelect={() => props.setTabIconMode(`lobster:${palette().id}`)}
                >
                  <LobsterPreview palette={palette()} />
                </TabIconPick>
              )}
            </For>
          </div>
        }
      />
    </div>
  );
}
