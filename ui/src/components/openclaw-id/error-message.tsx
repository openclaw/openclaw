import { Show } from "solid-js";
import type { OpenClawIdUiError } from "../../lib/openclaw-id/ui-error.ts";
import { t } from "../../lib/reactive/i18n.ts";

/** Show actionable copy first and keep sanitized diagnostics behind a native disclosure. */
export function OpenClawIdErrorMessage(props: { error: OpenClawIdUiError }) {
  return (
    <>
      <div>{props.error.message}</div>
      <Show when={props.error.detail}>
        <details>
          <summary>{t("openclawId.technicalDetails")}</summary>
          <div style={{ "overflow-wrap": "anywhere" }}>{props.error.detail}</div>
        </details>
      </Show>
    </>
  );
}
