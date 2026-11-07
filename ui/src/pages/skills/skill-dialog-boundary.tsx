import type { JSX } from "@solidjs/web";
import { Errored, Loading } from "solid-js";
import {
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
} from "../../app/stale-chunk-reload.ts";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";

export function SkillDialogBoundary(props: {
  onClose: () => void;
  closeDisabled?: boolean;
  children: JSX.Element;
}) {
  return (
    <Errored
      fallback={(error, reset) => (
        <InlineAlert tone="danger" role="alert">
          {formatUiError(error())}{" "}
          <button class="btn" disabled={props.closeDisabled} onClick={() => props.onClose()}>
            {t("common.close")}
          </button>{" "}
          <button
            class="btn"
            onClick={() =>
              isStaleChunkImportError(error()) ? void retryStaleChunkReloadWhenReachable() : reset()
            }
          >
            {t("common.retry")}
          </button>
        </InlineAlert>
      )}
    >
      <Loading
        fallback={
          <p class="muted" role="status">
            {t("common.loading")}{" "}
            <button class="btn" disabled={props.closeDisabled} onClick={() => props.onClose()}>
              {t("common.close")}
            </button>
          </p>
        }
      >
        {props.children}
      </Loading>
    </Errored>
  );
}
