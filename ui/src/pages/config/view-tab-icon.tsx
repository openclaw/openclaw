import type { JSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import {
  agentTabIconShape,
  type TabIconPreference,
} from "../../../../packages/gateway-protocol/src/schema/tab-icon.ts";
import { controlUiFaviconBaseSvg } from "../../app/control-ui-environment-presentation.runtime.ts";
import { inferControlUiPublicAssetPath } from "../../app/public-assets.ts";
import { LobsterSvg } from "../../components/lobster-pet-artwork.tsx";
import type { LobsterPetPalette } from "../../components/lobster-pet-contract.ts";
import { canonicalLobsterLook, lobsterLookStyle } from "../../components/lobster-pet-identity.ts";
import { lobsterPaletteName } from "../../components/lobster-pet-lore.ts";
import { Icon } from "../../components/solid/icon.tsx";
import {
  IdentityAvatarImage,
  createIdentityAvatarPresentation,
} from "../../components/solid/identity-avatar-image.tsx";
import { SettingsRow, SettingsSegmented } from "../../components/solid/settings-ui.tsx";
import { Tooltip } from "../../components/solid/tooltip.tsx";
import { ThemeBrandIcon } from "../../components/theme-brand-icon.tsx";
import { controlUiIconPreviewsProjection } from "../../lib/reactive/control-ui-icon-previews.ts";
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
  const selectionName = () => {
    const palette = selected();
    const shape = selectedShape();
    return palette
      ? lobsterPaletteName(palette.id)
      : shape
        ? t("configView.appearance.tabIcon.agent")
        : t("configView.appearance.tabIcon.default");
  };
  const description = () => {
    if (lobsterMode() && !selected()) {
      return t("configView.appearance.tabIcon.unavailable");
    }
    if (selected()) {
      return `${selectionName()} · ${t("configView.appearance.tabIcon.localCollection")}`;
    }
    return !selectedShape() && lobsterdexEnabled() && lobsters().length === 0
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
            <TabIconPick
              label={t("configView.appearance.tabIcon.agent")}
              pressed={selectedShape() !== null}
              onSelect={() => {
                if (!selectedShape()) {
                  props.setTabIconMode("agent:circle");
                }
              }}
            >
              <TabIconAvatar
                imageUrl={props.tabIconAgentAvatar ?? null}
                shape="circle"
                fallbackUrl={defaultSource()}
              />
            </TabIconPick>
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
      <Show when={selectedShape()}>
        {(shape) => (
          <SettingsRow
            title={t("configView.appearance.tabIcon.shape")}
            stackedOnNarrow
            control={
              <SettingsSegmented
                ariaLabel={t("configView.appearance.tabIcon.shape")}
                value={shape()}
                options={[
                  { value: "square", label: t("configView.appearance.tabIcon.square") },
                  { value: "rounded", label: t("configView.appearance.tabIcon.rounded") },
                  { value: "circle", label: t("configView.appearance.tabIcon.circle") },
                ]}
                onChange={(value) =>
                  props.setTabIconMode(value === "square" ? "agent" : `agent:${value}`)
                }
              />
            }
          />
        )}
      </Show>
      <IconPreviews />
    </div>
  );
}

function IconPreviews() {
  const previews = controlUiIconPreviewsProjection;
  const homeArtwork = () =>
    previews().appleTouch ?? inferControlUiPublicAssetPath("apple-touch-icon.png");
  let tab: HTMLDivElement | undefined;
  let shake: Animation | undefined;
  const closePreview = () => {
    shake?.cancel();
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      shake = tab?.animate(
        {
          transform: [
            "none",
            "translateX(-4px)",
            "translateX(4px)",
            "translateX(-2px)",
            "translateX(2px)",
            "none",
          ],
        },
        300,
      );
    }
  };
  return (
    <div class="settings-tab-icon__previews">
      <SettingsRow
        title={t("configView.appearance.tabIcon.previews")}
        stackedOnNarrow
        control={
          <dl class="settings-tab-icon__preview-list">
            <div class="settings-tab-icon__preview-item">
              <dt>{t("configView.appearance.tabIcon.browserTabPreview")}</dt>
              <dd class="settings-tab-icon__browser-edge">
                <div class="settings-tab-icon__browser-tab" ref={(element) => (tab = element)}>
                  <PreviewIcon
                    src={previews().favicon ?? inferControlUiPublicAssetPath("favicon-32.png")}
                    label={t("configView.appearance.tabIcon.faviconPreview")}
                  />
                  <span>OpenClaw</span>
                  <button
                    type="button"
                    class="settings-tab-icon__browser-close"
                    aria-label={t("configView.appearance.tabIcon.closePreviewTab")}
                    onClick={closePreview}
                  >
                    <Icon name="x" />
                  </button>
                </div>
              </dd>
            </div>
            <div class="settings-tab-icon__preview-item">
              <dt class="settings-tab-icon__home-screen-title">
                <span>{t("configView.appearance.tabIcon.homeScreenPreview")}</span>
                <Tooltip content={t("configView.appearance.tabIcon.homeScreenHint")} openOnClick>
                  <button
                    class="settings-section__help-button settings-tab-icon__home-screen-info"
                    type="button"
                    aria-label={t("common.helpFor", {
                      section: t("configView.appearance.tabIcon.homeScreenPreview"),
                    })}
                  >
                    <Icon name="info" />
                  </button>
                </Tooltip>
              </dt>
              <dd class="settings-tab-icon__home-screen-masks">
                <PreviewIcon
                  class="settings-tab-icon__home-screen"
                  src={homeArtwork()}
                  label={t("configView.appearance.tabIcon.applePreview")}
                />
                <PreviewIcon
                  class="settings-tab-icon__android-round"
                  src={homeArtwork()}
                  label={t("configView.appearance.tabIcon.androidRoundPreview")}
                />
                <PreviewIcon
                  class="settings-tab-icon__android-rounded"
                  src={homeArtwork()}
                  label={t("configView.appearance.tabIcon.androidRoundedPreview")}
                />
              </dd>
            </div>
          </dl>
        }
      />
    </div>
  );
}

function PreviewIcon(props: { src: string; label: string; class?: string }) {
  return (
    <Tooltip content={props.label} describe={false}>
      <img class={props.class} src={props.src} alt={props.label} />
    </Tooltip>
  );
}
