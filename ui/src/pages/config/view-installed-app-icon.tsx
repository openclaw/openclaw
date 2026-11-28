import { action, createMemo, createOptimistic, createSignal, Show } from "solid-js";
import { inferControlUiPublicAssetPath } from "../../app/public-assets.ts";
import { resetPwaInstallIcon, savePwaInstallIcon } from "../../app/pwa-install-icon.ts";
import { installIconSelection } from "../../app/pwa-install-selection.ts";
import { SettingsRow, SettingsSectionHeader } from "../../components/solid/settings-ui.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { APPEARANCE_SETTINGS_TARGET_IDS } from "./route-data.ts";

export function InstalledAppIcon(props: { agentPicture?: string | null }) {
  const selection = projectOwner(installIconSelection, (source) => source);
  const owner = createMemo(() => selection.read().owner);
  const [saving, setSaving] = createOptimistic(false);
  type Owner = typeof installIconSelection.owner;
  const [result, setResult] = createSignal<{ owner: Owner; error?: string }>();
  const currentResult = createMemo(() => (result()?.owner === owner() ? result() : undefined));
  let input!: HTMLInputElement;
  let chooserOwner: Owner = null;

  const apply = action(function* (expected: Owner, change: () => void | Promise<void>) {
    if (!expected || expected !== installIconSelection.owner) {
      return;
    }
    setSaving(true);
    try {
      yield change();
      if (expected === installIconSelection.owner) {
        setResult({ owner: expected });
      }
    } catch (err) {
      if (expected === installIconSelection.owner) {
        setResult({
          owner: expected,
          error: formatUiError(err, t("configView.appearance.installIcon.failed")),
        });
      }
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
                src={selection.read().icon ?? inferControlUiPublicAssetPath("apple-touch-icon.png")}
                alt={t("configView.appearance.installIcon.preview")}
              />
              <button
                type="button"
                class="btn btn--sm"
                disabled={saving() || !owner()}
                onClick={() => void apply(owner(), resetPwaInstallIcon)}
              >
                {t("configView.appearance.installIcon.default")}
              </button>
              <button
                type="button"
                class="btn btn--sm"
                disabled={saving() || !owner() || !props.agentPicture}
                title={
                  !props.agentPicture ? t("configView.appearance.installIcon.noPicture") : undefined
                }
                onClick={() => {
                  const source = props.agentPicture;
                  if (source) {
                    void apply(owner(), () => savePwaInstallIcon(source));
                  }
                }}
              >
                {t("configView.appearance.installIcon.agent")}
              </button>
              <button
                type="button"
                class="btn btn--sm"
                disabled={saving() || !owner()}
                onClick={() => {
                  chooserOwner = owner();
                  input.click();
                }}
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
                  const expected = chooserOwner;
                  chooserOwner = null;
                  if (file && expected) {
                    void apply(expected, () => savePwaInstallIcon(file));
                  }
                }}
              />
            </div>
          }
        />
      </div>
      <Show when={selection.read().icon}>
        {(icon) => (
          <a href={icon().replace(/icon\.png$/u, "install")} rel="noreferrer">
            {t("configView.appearance.installIcon.openInstallPage")}
          </a>
        )}
      </Show>
      <span role="status" class="settings-section__desc">
        {!owner()
          ? t("configView.appearance.installIcon.signIn")
          : saving()
            ? t("configView.appearance.installIcon.saving")
            : currentResult() && !currentResult()?.error
              ? t("configView.appearance.installIcon.saved")
              : ""}
      </span>
      <Show when={!saving() && currentResult()?.error}>
        {(message) => <span role="alert">{message()}</span>}
      </Show>
    </section>
  );
}
