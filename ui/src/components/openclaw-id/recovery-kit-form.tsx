import type { JSX } from "@solidjs/web";
import { createSignal, onSettled } from "solid-js";
import { registerOpenClawIdDialogsEnglish } from "../../i18n/locales/en-openclaw-id-dialogs.ts";
import type { RecoveryKitDetails } from "../../lib/openclaw-id/kit-export.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { clawNameFromHostname } from "./claw-name.ts";
import { OnePasswordKitSave } from "./onepassword-kit-save.tsx";

registerEnglishCatalog(registerOpenClawIdDialogsEnglish);

/** Native credential form; submitting never substitutes for the owner's save confirmation. */
export function RecoveryKitForm(props: {
  details: RecoveryKitDetails;
  accountEmail?: string | null;
  saved: boolean;
  onContinue: () => void;
  children: JSX.Element;
}) {
  let username!: HTMLInputElement;
  let retired = false;
  // A posted task, not a timer: native submit listeners have microtask checkpoints
  // between them. Finish the whole event before the flow unmounts and scrubs fields.
  const submitTask = new MessageChannel();
  onSettled(() => {
    const stop = listen(submitTask.port1, "message", () => props.onContinue(), { once: true });
    submitTask.port1.start();
    return () => {
      stop();
      submitTask.port1.close();
      submitTask.port2.close();
    };
  });
  // Scrub detached DOM too: password managers may retain references to these fields.
  onSettled(() => () => {
    retired = true;
    username.value = "";
    username.defaultValue = "";
  });
  return (
    <>
      <OnePasswordKitSave details={props.details} accountEmail={props.accountEmail} />
      <form
        id="openclaw-recovery-kit"
        name="openclaw-recovery-kit"
        aria-label={t("openclawId.kitTitle")}
        onSubmit={(event) => {
          event.preventDefault();
          if (retired || !props.saved) {
            return;
          }
          retired = true;
          submitTask.port2.postMessage(null);
        }}
      >
        <label class="field">
          <span>{t("openclawId.kitAccount")}</span>
          <input
            ref={(element) => (username = element)}
            id="openclaw-recovery-kit-username"
            name="username"
            type="text"
            autocomplete="username"
            readonly
            value={
              props.accountEmail ||
              t("openclawId.kitAccountFallback", {
                name: clawNameFromHostname(props.details.hostname),
              })
            }
          />
        </label>
        {props.children}
      </form>
    </>
  );
}

/** The importable OCK1 code, concealed until the owner explicitly reveals it. */
export function RecoveryCodeField(props: { code: string }) {
  const [shown, setShown] = createSignal(false);
  let input!: HTMLInputElement;
  // Do not clear on submit: extension listeners must see the exact code during that event.
  onSettled(() => () => {
    input.value = "";
    input.defaultValue = "";
    input.type = "password";
  });
  return (
    <div class="field">
      <label for="openclaw-recovery-kit-password">{t("openclawId.kitRecoveryCode")}</label>
      <div class="row">
        <input
          ref={(element) => (input = element)}
          id="openclaw-recovery-kit-password"
          name="password"
          class="secret-reveal__code openclaw-id-kit__secret"
          type={shown() ? "text" : "password"}
          autocomplete="new-password"
          readonly
          spellcheck="false"
          value={props.code}
        />
        <button
          type="button"
          class="btn btn--sm"
          aria-controls="openclaw-recovery-kit-password"
          onClick={() => setShown((value) => !value)}
        >
          {t(shown() ? "openclawId.kitHideCode" : "openclawId.kitShowCode")}
        </button>
      </div>
      <p class="muted">{t("openclawId.kitPasswordManagerHint")}</p>
    </div>
  );
}
