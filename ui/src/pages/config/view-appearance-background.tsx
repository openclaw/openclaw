import { createMemo, For } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import {
  SettingsRow,
  SettingsSegmented,
  SettingsToggleRow,
} from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import type { createAppearanceBackground } from "./appearance-background-state.ts";
import { APPEARANCE_SETTINGS_TARGET_IDS } from "./route-data.ts";
type BackgroundView = ReturnType<ReturnType<typeof createAppearanceBackground>["viewProps"]>;
export type AppearanceBackgroundView = Omit<BackgroundView, "onRetry"> & {
  fileRef?: (element: HTMLInputElement) => void;
  onRetry?: BackgroundView["onRetry"];
};
export function AppearanceBackground(props: AppearanceBackgroundView) {
  const preference = createMemo(() => props.preference);
  const disabled = createMemo(() => props.busy || preference().source.kind === "none");
  const presentation = createMemo(() => preference().presentation ?? "faded");
  const visibility = createMemo(() => Math.round(preference().visibility * 100));
  const placementHint = createMemo(() =>
    preference().source.kind === "none"
      ? "noneHint"
      : !preference().showOnNewSession && !preference().showInSessions
        ? "placementOffHint"
        : preference().visibility === 0
          ? "visibilityZeroHint"
          : undefined,
  );
  return (
    <section id={APPEARANCE_SETTINGS_TARGET_IDS.background} class="settings-section">
      <div class="settings-section__header">
        <h2 class="settings-section__heading">{t("configView.appearance.background.title")}</h2>
      </div>
      <div class="settings-group">
        <SettingsRow
          title={t("configView.appearance.background.source")}
          stacked={true}
          control={
            <div class="settings-background-artwork">
              <div
                class="settings-background-options"
                role="group"
                aria-label={t("configView.appearance.background.source")}
              >
                <For each={["none", "theme", "custom"] as const}>
                  {(source) => (
                    <button
                      type="button"
                      class={[
                        "settings-background-option",
                        `settings-background-option--${source}`,
                      ]}
                      data-background-source={source}
                      aria-label={t(`configView.appearance.background.${source}`)}
                      aria-pressed={preference().source.kind === source ? "true" : "false"}
                      disabled={
                        props.busy ||
                        (source === "custom" && !props.hasImage && !props.uploadAllowed)
                      }
                      onClick={() => props.onSource(source)}
                    >
                      <span class="settings-background-option__sample" aria-hidden="true">
                        {source === "custom" && props.imageUrl ? (
                          <img src={props.imageUrl} alt="" />
                        ) : source === "none" ? (
                          <Icon name="circleX" />
                        ) : source === "custom" ? (
                          <Icon name="image" />
                        ) : (
                          <Icon name="palette" />
                        )}
                      </span>
                      <span class="settings-background-option__label">
                        {t(
                          `configView.appearance.background.${source === "none" ? "none" : `${source}Choice`}`,
                        )}
                        {preference().source.kind === source ? (
                          <span aria-hidden="true">
                            <Icon name="check" />
                          </span>
                        ) : undefined}
                      </span>
                    </button>
                  )}
                </For>
              </div>
              <div class="settings-background-actions">
                {!props.hasImage ? (
                  <span class="settings-background-formats">
                    {t("configView.appearance.background.formats")}
                  </span>
                ) : undefined}
                <button
                  type="button"
                  class="btn btn--sm"
                  data-background-upload
                  title={t("configView.appearance.background.formats")}
                  disabled={props.busy || !props.uploadAllowed}
                  onClick={() => props.onChooseImage()}
                >
                  {t(
                    props.hasImage
                      ? "configView.appearance.background.replace"
                      : "configView.appearance.background.choose",
                  )}
                </button>
                {props.hasImage ? (
                  <button
                    type="button"
                    class="btn btn--sm"
                    data-background-remove
                    disabled={props.busy || !props.uploadAllowed}
                    onClick={() => props.onRemoveImage()}
                  >
                    {t("configView.appearance.background.remove")}
                  </button>
                ) : undefined}
              </div>
            </div>
          }
        />
        <SettingsRow
          title={t("configView.appearance.background.presentation")}
          description={t(`configView.appearance.background.${presentation()}Hint`)}
          stackedOnNarrow={true}
          control={
            <SettingsSegmented
              mode="buttons"
              value={presentation()}
              disabled={disabled()}
              ariaLabel={t("configView.appearance.background.presentation")}
              options={(["faded", "full-bleed"] as const).map((mode) => ({
                value: mode,
                label: t(`configView.appearance.background.${mode}`),
                testId: `background-presentation-${mode}`,
              }))}
              onChange={(nextPresentation) =>
                props.onChange({
                  presentation: nextPresentation,
                })
              }
            />
          }
        />
        <SettingsRow
          title={t("configView.appearance.background.visibility")}
          description={
            <span id="settings-background-visibility-hint">
              {t("configView.appearance.background.visibilityHint")}
            </span>
          }
          stackedOnNarrow={true}
          control={
            <div class="settings-background-visibility">
              <input
                type="range"
                min="0"
                max="100"
                step="5"
                aria-label={t("configView.appearance.background.visibility")}
                aria-describedby="settings-background-visibility-hint"
                aria-valuetext={`${visibility()}%`}
                value={String(visibility())}
                disabled={disabled()}
                onPointerDown={(event) => props.onPreviewStart(event)}
                onPointerUp={(event) => props.onPreviewEnd(event)}
                onPointerCancel={() => props.onPreviewCancel()}
                onLostPointerCapture={(event) => props.onPreviewEnd(event)}
                onKeyDown={(event) => props.onPreviewKey(event)}
                onBlur={() => props.onPreviewCancel()}
                onInput={(event) => {
                  props.onChange({
                    visibility: Number(event.currentTarget.value) / 100,
                  });
                  props.onPreviewInput();
                }}
              />
              <span class="settings-background-visibility__value" aria-hidden="true">
                {visibility()}%
              </span>
            </div>
          }
        />
        <For
          each={
            [
              ["showOnNewSession", "newSession"],
              ["showInSessions", "sessions"],
            ] as const
          }
        >
          {([key, label]) => (
            <SettingsToggleRow
              title={t(`configView.appearance.background.${label}`)}
              checked={preference()[key]}
              disabled={disabled()}
              onChange={(enabled) => props.onChange({ [key]: enabled })}
            />
          )}
        </For>
      </div>
      <input
        type="file"
        ref={(element) => props.fileRef?.(element)}
        data-background-file
        hidden
        accept="image/jpeg,image/png,image/webp"
        onChange={(event) => {
          const input = event.currentTarget;
          const file = input.files?.[0];
          input.value = "";
          if (file) {
            props.onFile(file);
          }
        }}
      />
      {placementHint() ? (
        <p class="settings-section__desc">
          {t(`configView.appearance.background.${placementHint()}`)}
        </p>
      ) : undefined}
      <p class="settings-section__desc">{props.scopeHint}</p>
      {props.message ? (
        <p
          role={props.message.kind === "error" ? "alert" : "status"}
          class={[
            "settings-status",
            {
              "settings-status--danger": props.message.kind === "error",
              "settings-status--muted": props.message.kind !== "error",
            },
          ]}
        >
          {props.message.text}{" "}
          {props.onRetry ? (
            <button
              type="button"
              class="btn btn--sm"
              data-background-retry
              onClick={() => props.onRetry?.()}
            >
              {t("common.retry")}
            </button>
          ) : undefined}
        </p>
      ) : undefined}
    </section>
  );
}
