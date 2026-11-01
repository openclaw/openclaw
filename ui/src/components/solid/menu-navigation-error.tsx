import { Show } from "solid-js";
import { isStaleChunkImportError } from "../../app/stale-chunk-reload.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { MenuBinding } from "./menu-machine.ts";

/** Keep native controls usable when the optional navigation chunk cannot load. */
export function MenuNavigationError(props: { binding: MenuBinding }) {
  return (
    <Show when={props.binding.error()}>
      <p role="alert">
        {t("lazyView.errorTitle")}{" "}
        <button type="button" ref={props.binding.itemRef()} onClick={() => props.binding.retry()}>
          {t(isStaleChunkImportError(props.binding.error()) ? "common.reload" : "common.retry")}
        </button>
      </p>
    </Show>
  );
}
