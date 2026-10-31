// The recovery kit as Make reachable and Regenerate owner key show it once: the kit
// text and its facts, save options (download, print/PDF, password manager, copy) and
// the "saved" toggle. A save action that succeeds counts as saved.
import { createSignal, Show } from "solid-js";
import { formatUiError } from "../../lib/format-error.ts";
import {
  canStoreRecoveryKit,
  downloadRecoveryKit,
  printRecoveryKit,
  storeRecoveryKit,
  type RecoveryKitDetails,
} from "../../lib/openclaw-id/kit-export.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { CopyButton } from "../solid/copy-button.tsx";
import { SettingsToggleRow } from "../solid/settings-ui.tsx";

/** The kit, its save options and the "I've saved it" toggle. */
export function RecoveryKitPanel(props: {
  details: RecoveryKitDetails;
  saved: boolean;
  onSaved: (saved: boolean) => void;
}) {
  const [note, setNote] = createSignal<string | null>(null);
  // Marks the kit saved after a save action, as ticking the box does.
  const save = async (action: () => boolean | Promise<boolean>) => {
    setNote(null);
    try {
      if (await action()) {
        props.onSaved(true);
      } else {
        setNote(t("openclawId.kitActionUnavailable"));
      }
    } catch (error) {
      setNote(t("openclawId.kitActionFailed", { error: formatUiError(error) }));
    }
  };
  return (
    <>
      <div class="stack openclaw-id-kit" aria-label={t("openclawId.kitTitle")}>
        <strong>{t("openclawId.kitHeading")}</strong>
        <code class="secret-reveal__code openclaw-id-kit__secret">{props.details.kit.text}</code>
        <div class="list openclaw-id-facts">
          <div>
            <span class="muted">{t("openclawId.kitOwnerFingerprint")}</span>{" "}
            {props.details.kit.rootFingerprint}
          </div>
          <Show when={props.details.owner}>
            {(owner) => (
              <div>
                <span class="muted">{t("openclawId.kitOwner")}</span> {owner()}
              </div>
            )}
          </Show>
          <div>
            <span class="muted">{t("openclawId.kitClaw")}</span> https://{props.details.hostname}
          </div>
          <div>
            <span class="muted">{t("openclawId.kitCreated")}</span>{" "}
            {props.details.createdAt.toLocaleDateString()}
          </div>
        </div>
      </div>
      <div class="callout info secret-reveal__callout">{t("openclawId.kitWarning")}</div>
      <div class="chip-row openclaw-id-kit__actions">
        <button
          type="button"
          class="btn btn--sm"
          onClick={() =>
            void save(() => {
              downloadRecoveryKit(props.details);
              return true;
            })
          }
        >
          {t("openclawId.downloadKit")}
        </button>
        <button
          type="button"
          class="btn btn--sm"
          onClick={() => void save(() => printRecoveryKit(props.details))}
        >
          {t("openclawId.printKit")}
        </button>
        <Show when={canStoreRecoveryKit()}>
          <button
            type="button"
            class="btn btn--sm"
            onClick={() => void save(() => storeRecoveryKit(props.details))}
          >
            {t("openclawId.storeKit")}
          </button>
        </Show>
        <CopyButton text={props.details.kit.text} idleLabel={t("common.copy")} />
      </div>
      <Show when={note()}>
        {(message) => (
          <p class="secret-reveal__note" role="status">
            {message()}
          </p>
        )}
      </Show>
      <SettingsToggleRow
        title={t("openclawId.kitSaved")}
        checked={props.saved}
        onChange={(next) => props.onSaved(next)}
      />
    </>
  );
}
