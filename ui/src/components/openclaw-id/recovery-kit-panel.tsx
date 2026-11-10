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
import { OpenClawIdErrorMessage } from "./error-message.tsx";
import { RecoveryCodeField } from "./recovery-kit-form.tsx";

/** The kit, its save options and the "I've saved it" checkbox. */
export function RecoveryKitPanel(props: {
  details: RecoveryKitDetails;
  saved: boolean;
  onSaved: (saved: boolean) => void;
}) {
  let copyLabel!: HTMLSpanElement;
  const [note, setNote] = createSignal<OpenClawIdUiError | null>(null);
  // Marks the kit saved after a save action, as ticking the box does.
  const save = async (action: () => boolean | Promise<boolean>) => {
    setNote(null);
    try {
      if (await action()) {
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
      <p class="openclaw-id-kit__warning">{t("openclawId.kitWarning")}</p>
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
      <Show when={note()}>
        {(message) => (
          <div class="secret-reveal__note" role="status">
            <OpenClawIdErrorMessage error={message()} />
          </div>
        )}
      </Show>
      <label class="openclaw-id-kit__saved">
        <Checkbox
          checked={props.saved}
          onChange={(event) => props.onSaved(event.currentTarget.checked)}
        />
        <span>{t("openclawId.kitSaved")}</span>
      </label>
    </>
  );
}
