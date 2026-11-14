// The recovery kit as Make reachable shows it once: the kit
// code and its facts, save options (download, print/PDF, copy) and
// the "saved" checkbox. A save action that succeeds counts as saved.
import { createSignal, Show } from "solid-js";
import {
  downloadRecoveryKit,
  printRecoveryKit,
  type RecoveryKitDetails,
} from "../../lib/openclaw-id/kit-export.ts";
import { openClawIdUiError, type OpenClawIdUiError } from "../../lib/openclaw-id/ui-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { handleCopyButton } from "../copy-button-state.ts";
import { Checkbox } from "../solid/checkbox.tsx";
import { Icon } from "../solid/icon.tsx";
import { OpenClawIdErrorMessage } from "./error-message.tsx";
import { RecoveryAccountField, RecoveryCodeField } from "./recovery-kit-form.tsx";

/** The kit, its save options and the "I've saved it" checkbox. */
export function RecoveryKitPanel(props: {
  details: RecoveryKitDetails;
  accountEmail?: string | null;
  saved: boolean;
  onSaved: (saved: boolean) => void;
  statusRef?: (element: HTMLDivElement) => void;
}) {
  let copyLabel!: HTMLSpanElement;
  const [note, setNote] = createSignal<OpenClawIdUiError | null>(null);
  const [downloaded, setDownloaded] = createSignal(false);
  const [printed, setPrinted] = createSignal(false);
  // Marks the kit saved after a save action, as ticking the box does.
  const save = async (action: () => boolean | Promise<boolean>, onSuccess?: () => void) => {
    setNote(null);
    try {
      if (await action()) {
        onSuccess?.();
        props.onSaved(true);
      } else {
        setNote({ message: t("openclawId.kitActionUnavailable"), detail: "" });
      }
    } catch (error) {
      setNote(openClawIdUiError(error, "saveKit"));
    }
  };
  return (
    <>
      <div class="openclaw-id-kit">
        <RecoveryCodeField code={props.details.kit.text} />
        <div class="oc-dialog__rows">
          <RecoveryAccountField
            accountEmail={props.accountEmail}
            hostname={props.details.hostname}
          />
          <div class="oc-dialog__row">
            <span class="oc-dialog__row-label">{t("openclawId.kitOwnerFingerprint")}</span>
            <span>{props.details.kit.rootFingerprint}</span>
          </div>
          <div class="oc-dialog__row">
            <span class="oc-dialog__row-label">{t("openclawId.kitClaw")}</span>
            <span>https://{props.details.hostname}</span>
          </div>
          <div class="oc-dialog__row">
            <span class="oc-dialog__row-label">{t("openclawId.kitCreated")}</span>
            <span>{props.details.createdAt.toLocaleDateString()}</span>
          </div>
        </div>
      </div>
      <p class="openclaw-id-kit__warning">{t("openclawId.kitWarning")}</p>
      <div class="openclaw-id-kit__actions">
        <button
          type="button"
          class="btn btn--sm"
          onClick={() =>
            void save(
              () => {
                downloadRecoveryKit(props.details);
                return true;
              },
              () => setDownloaded(true),
            )
          }
        >
          <Show when={downloaded()}>
            <span class="openclaw-id-kit__exported">
              <Icon name="check" />
            </span>
          </Show>
          {t("openclawId.downloadKit")}
        </button>
        <button
          type="button"
          class="btn btn--sm"
          onClick={() =>
            void save(
              () => printRecoveryKit(props.details),
              () => setPrinted(true),
            )
          }
        >
          <Show when={printed()}>
            <span class="openclaw-id-kit__exported">
              <Icon name="check" />
            </span>
          </Show>
          {t("openclawId.printKit")}
        </button>
        <button
          type="button"
          class="btn btn--sm"
          onClick={(event) =>
            void save(() =>
              handleCopyButton(event, props.details.kit.text, t("common.copy"), {
                label: copyLabel,
              }),
            )
          }
        >
          <span ref={(element) => (copyLabel = element)}>{t("common.copy")}</span>
        </button>
      </div>
      <div class="openclaw-id-setup__status" ref={props.statusRef} role="status">
        <Show when={note()}>{(message) => <OpenClawIdErrorMessage error={message()} />}</Show>
      </div>
      <label class="field checkbox openclaw-id-kit__saved">
        <Checkbox
          checked={props.saved}
          onChange={(event) => props.onSaved(event.currentTarget.checked)}
        />
        <span>{t("openclawId.kitSaved")}</span>
      </label>
    </>
  );
}
