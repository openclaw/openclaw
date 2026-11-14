import type { JSX } from "@solidjs/web";
import { t } from "../../lib/reactive/i18n.ts";

export function PluginRetryError(props: { error: string; onRetry: () => void }): JSX.Element {
  return (
    <div class="callout danger plugins-settings-error oc-banner oc-banner-error" role="alert">
      <span>{props.error}</span>
      <button
        type="button"
        class="btn btn--sm oc-action oc-action-secondary"
        onClick={() => props.onRetry()}
      >
        {t("pluginsPage.tryAgain")}
      </button>
    </div>
  );
}
