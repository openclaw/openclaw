import { createMemo, For } from "solid-js";
import type { BackgroundPreference } from "../../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import { Icon } from "../../components/solid/icon.tsx";
import {
  SettingsRow,
  SettingsSegmented,
  SettingsToggleRow,
} from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { APPEARANCE_SETTINGS_TARGET_IDS } from "./route-data.ts";
export type AppearanceBackgroundView = {
  preference: BackgroundPreference;
  imageUrl: string | null;
  hasImage: boolean;
  busy: boolean;
  uploadAllowed: boolean;
  scopeHint: string;
  message: {
    kind: "error" | "status";
    text: string;
  } | null;
  onSource: (source: BackgroundPreference["source"]["kind"]) => void;
  onChange: (patch: Partial<BackgroundPreference>) => void;
  onChooseImage: () => void;
  onRemoveImage: () => void;
  onFile: (file: File) => void;
  onPreviewStart: (event: PointerEvent) => void;
  onPreviewInput: () => void;
  onPreviewEnd: (event: PointerEvent) => void;
  onPreviewKey: (event: KeyboardEvent) => void;
  onPreviewCancel: () => void;
  onRetry?: () => void;
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
    <>
      <section id={APPEARANCE_SETTINGS_TARGET_IDS.background} class="settings-section">
        <div class="settings-section__header">
          <h2 class="settings-section__heading">{t("configView.appearance.background.title")}</h2>
        </div>
        <div class="settings-group">
          {
            <SettingsRow
              title={t("configView.appearance.background.source")}
              stacked={true}
              control={
                <>
                  <div class="settings-background-artwork">
                    <div
                      class="settings-background-options"
                      role="group"
                      aria-label={t("configView.appearance.background.source")}
                    >
                      {
                        <For each={["none", "theme", "custom"] as const}>
                          {(source) => (
                            <>
                              <button
                                type="button"
                                class={[
                                  "settings-background-option",
                                  `settings-background-option--${source}`,
                                ]}
                                data-background-source={source}
                                aria-label={t(`configView.appearance.background.${source}`)}
                                aria-pressed={
                                  preference().source.kind === source ? "true" : "false"
                                }
                                disabled={
                                  props.busy ||
                                  (source === "custom" && !props.hasImage && !props.uploadAllowed)
                                }
                                onClick={() => props.onSource(source)}
                              >
                                <span class="settings-background-option__sample" aria-hidden="true">
                                  {source === "custom" && props.imageUrl ? (
                                    <>
                                      <img src={props.imageUrl} alt="" />
                                    </>
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
                                    <>
                                      <span aria-hidden="true">{<Icon name="check" />}</span>
                                    </>
                                  ) : undefined}
                                </span>
                              </button>
                            </>
                          )}
                        </For>
                      }
                    </div>
                    <div class="settings-background-actions">
                      {!props.hasImage ? (
                        <>
                          <span class="settings-background-formats">
                            {t("configView.appearance.background.formats")}
                          </span>
                        </>
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
                        <>
                          <button
                            type="button"
                            class="btn btn--sm"
                            data-background-remove
                            disabled={props.busy || !props.uploadAllowed}
                            onClick={() => props.onRemoveImage()}
                          >
                            {t("configView.appearance.background.remove")}
                          </button>
                        </>
                      ) : undefined}
                    </div>
                  </div>
                </>
              }
            />
          }
          {
            <SettingsRow
              title={t("configView.appearance.background.presentation")}
              description={t(`configView.appearance.background.${presentation()}Hint`)}
              stackedOnNarrow={true}
              control={
                <SettingsSegmented
                  mode={"buttons"}
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
          }
          {
            <SettingsRow
              title={t("configView.appearance.background.visibility")}
              description={
                <>
                  <span id="settings-background-visibility-hint">
                    {t("configView.appearance.background.visibilityHint")}
                  </span>
                </>
              }
              stackedOnNarrow={true}
              control={
                <>
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
                      onInput={(event: Event) => {
                        props.onChange({
                          // SAFETY: This listener is attached directly to the range input above.
                          visibility: Number((event.currentTarget as HTMLInputElement).value) / 100,
                        });
                        props.onPreviewInput();
                      }}
                    />
                    <span class="settings-background-visibility__value" aria-hidden="true">
                      {visibility()}%
                    </span>
                  </div>
                </>
              }
            />
          }
          {
            <SettingsToggleRow
              title={t("configView.appearance.background.newSession")}
              checked={preference().showOnNewSession}
              disabled={disabled()}
              onChange={(showOnNewSession) =>
                props.onChange({
                  showOnNewSession,
                })
              }
            />
          }
          {
            <SettingsToggleRow
              title={t("configView.appearance.background.sessions")}
              checked={preference().showInSessions}
              disabled={disabled()}
              onChange={(showInSessions) =>
                props.onChange({
                  showInSessions,
                })
              }
            />
          }
        </div>
        <input
          type="file"
          data-background-file
          hidden
          accept="image/jpeg,image/png,image/webp"
          onChange={(event: Event) => {
            // SAFETY: This listener is attached directly to the file input above.
            const input = event.currentTarget as HTMLInputElement;
            const file = input.files?.[0];
            input.value = "";
            if (file) {
              props.onFile(file);
            }
          }}
        />
        {placementHint() ? (
          <>
            <p class="settings-section__desc">
              {t(`configView.appearance.background.${placementHint()}`)}
            </p>
          </>
        ) : undefined}
        <p class="settings-section__desc">{props.scopeHint}</p>
        {props.message ? (
          <>
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
                <>
                  <button
                    type="button"
                    class="btn btn--sm"
                    data-background-retry
                    onClick={() => props.onRetry?.()}
                  >
                    {t("common.retry")}
                  </button>
                </>
              ) : undefined}
            </p>
          </>
        ) : undefined}
      </section>
    </>
  );
}
