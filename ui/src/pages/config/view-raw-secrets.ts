import { REDACTED_SENTINEL } from "../../lib/config-form-utils.ts";
import { t } from "../../lib/reactive/i18n.ts";

/** Counts the secrets in the raw editor; says "visible" only when the text holds no sentinel. */
export function rawSecretsLabel(count: number, revealed: boolean, raw: string): string {
  const shown = revealed && !raw.includes(REDACTED_SENTINEL);
  return `${t(count === 1 ? "configView.secretCount" : "configView.secretCountPlural", {
    count: String(count),
  })} ${t(shown ? "configView.visible" : "configView.redacted")}`;
}
