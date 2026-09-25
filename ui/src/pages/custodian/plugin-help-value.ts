import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { isSecretRefObject } from "../../components/config-form.node.shared.ts";
import { t } from "../../i18n/index.ts";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { REDACTED_SENTINEL } from "../../lib/config-form-utils.ts";

registerPluginManagementEnglish();

/** Sensitive containers are refused whole before JSON serialization. */
export function formatPluginHelpValue(value: unknown, sensitive: boolean): string {
  if (sensitive) {
    return "<redacted>";
  }
  const pending = [value];
  let scanned = 0;
  while (pending.length) {
    const entry = pending.pop();
    if (
      ++scanned > 1000 ||
      entry === REDACTED_SENTINEL ||
      isSecretRefObject(entry) ||
      (typeof entry === "string" && redactSensitiveUrlLikeString(entry) !== entry)
    ) {
      return "<redacted>";
    }
    if (entry && typeof entry === "object") {
      const entries = Object.entries(entry);
      // Map keys are also serialized into the draft; inspect them before truncation.
      if (
        entries.length + pending.length + scanned > 1000 ||
        entries.some(([key]) => redactSensitiveUrlLikeString(key) !== key)
      ) {
        return "<redacted>";
      }
      pending.push(...entries.map(([, child]) => child));
    }
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text === undefined
    ? t("custodian.pluginHelpUnset")
    : text.length > 512
      ? `${truncateUtf16Safe(text, 512)}…`
      : text;
}
