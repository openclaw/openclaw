import { action, createMemo, createOptimistic, createSignal, refresh, Show } from "solid-js";
import { inferControlUiPublicAssetPath } from "../../app/public-assets.ts";
import {
  currentPwaInstallIcon,
  resetPwaInstallIcon,
  savePwaInstallIcon,
} from "../../app/pwa-install-icon.ts";
import { SettingsRow, SettingsSectionHeader } from "../../components/solid/settings-ui.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { APPEARANCE_SETTINGS_TARGET_IDS } from "./route-data.ts";

export function InstalledAppIcon(props: { agentPicture?: string | null }) {
  const current = createMemo(currentPwaInstallIcon);
  const [saving, setSaving] = createOptimistic(false);
  const [error, setError] = createSignal("");
  const [saved, setSaved] = createSignal(false);
  let input!: HTMLInputElement;

  const apply = action(function* (change: () => void | Promise<void>) {
    setSaving(true);
    try {
      yield change();
      refresh(current);
      setSaved(true);
      setError("");
    } catch (err) {
      setSaved(false);
      setError(formatUiError(err, t("configView.appearance.installIcon.failed")));
    }
  });

  return (
    <section class="settings-section" id={APPEARANCE_SETTINGS_TARGET_IDS.installIcon}>
      <SettingsSectionHeader
        title={t("configView.appearance.installIcon.title")}
        description={t("configView.appearance.installIcon.install")}
      />
      <div class="settings-group">
        <SettingsRow
          stacked
          title={t("configView.appearance.installIcon.picture")}
          description={t("configView.appearance.installIcon.privacy")}
          control={
            <div class="filters">
              <img
                width="40"
                height="40"
                src={current() ?? inferControlUiPublicAssetPath("apple-touch-icon.png")}
                alt={t("configView.appearance.installIcon.preview")}
              />
              <button
                type="button"
                class="btn btn--sm"
                disabled={saving() || !current()}
                onClick={() => void apply(resetPwaInstallIcon)}
              >
                {t("configView.appearance.installIcon.default")}
              </button>
              <button
                type="button"
                class="btn btn--sm"
                disabled={saving() || !props.agentPicture}
                title={
                  !props.agentPicture ? t("configView.appearance.installIcon.noPicture") : undefined
                }
                onClick={() => {
                  const source = props.agentPicture;
                  if (source) {
                    void apply(() => savePwaInstallIcon(source));
                  }
                }}
              >
                {t("configView.appearance.installIcon.agent")}
              </button>
              <button
                type="button"
                class="btn btn--sm"
                disabled={saving()}
                onClick={() => input.click()}
              >
                {t("configView.appearance.installIcon.custom")}
              </button>
              <input
                ref={(element) => (input = element)}
                hidden
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file) {
                    void apply(() => savePwaInstallIcon(file));
                  }
                }}
              />
            </div>
          }
        />
      </div>
      <span role="status" class="settings-section__desc">
        {saving()
          ? t("configView.appearance.installIcon.saving")
          : saved()
            ? t("configView.appearance.installIcon.saved")
            : ""}
      </span>
      <Show when={!saving() && error()}>{(message) => <span role="alert">{message()}</span>}</Show>
    </section>
  );
}
