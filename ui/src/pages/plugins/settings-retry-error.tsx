import type { JSX } from "@solidjs/web";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { t } from "../../lib/reactive/i18n.ts";

export function PluginRetryError(props: { error: string; onRetry: () => void }): JSX.Element {
  return (
    <InlineAlert
      tone="danger"
      action={
        <button type="button" class="btn btn--sm" onClick={() => props.onRetry()}>
          {t("pluginsPage.tryAgain")}
        </button>
      }
    >
      {props.error}
    </InlineAlert>
  );
}
