import { createSignal, onSettled } from "solid-js";
import type { RecoveryKitDetails } from "../../lib/openclaw-id/kit-export.ts";
import { mountOnePasswordKit } from "../../lib/openclaw-id/onepassword-save.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { clawNameFromHostname } from "./claw-name.ts";

/** The official branded save action, visible only when the 1Password extension enables it. */
export function OnePasswordKitSave(props: {
  details: RecoveryKitDetails;
  accountEmail?: string | null;
}) {
  const [enabled, setEnabled] = createSignal(false);
  let host!: HTMLDivElement;
  // A kit is immutable during this step; mount once, scrub and dispose on departure.
  onSettled(() => {
    const name = clawNameFromHostname(props.details.hostname);
    const url = `https://${props.details.hostname}`;
    return mountOnePasswordKit(
      host,
      {
        title: t("openclawId.kitAccountFallback", { name }),
        username: props.accountEmail || t("openclawId.kitAccountFallback", { name }),
        code: props.details.kit.text,
        url,
        notes: t("openclawId.kitOnePasswordNotes", {
          url,
          id: props.details.kit.rootFingerprint,
        }),
      },
      setEnabled,
    );
  });
  return (
    <div class="secret-reveal__body" hidden={!enabled()}>
      <div ref={(element) => (host = element)} />
      <p class="secret-reveal__note">{t("openclawId.kitOtherPasswordManagers")}</p>
    </div>
  );
}
