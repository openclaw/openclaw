import { Show } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";
import type { PortalsModel } from "./portals-state.ts";

export function PortalProbeLoading() {
  return (
    <div class="portals-empty portals-preview__state" role="status" aria-live="polite">
      <div class="portals-empty__title">{t("portalsPage.loading")}</div>
    </div>
  );
}

export function PendingEnvironment(props: {
  model: PortalsModel;
  error?: string;
  retry?: () => void;
}) {
  const environment = () => {
    const state = props.model.state();
    return state.pendingEnvironment?.id === state.pendingEnvironmentId
      ? state.pendingEnvironment
      : null;
  };
  const failed = () =>
    props.error ||
    (environment() &&
      environment()!.status !== "starting" &&
      environment()!.status !== "available");
  return (
    <section class="portals-empty" role="status" aria-live="polite">
      <div class="portals-empty__title">
        {t(
          failed()
            ? "portalsPage.environmentUnavailable"
            : environment()?.status === "available"
              ? "portalsPage.waitingForApp"
              : "portalsPage.environmentStarting",
        )}
      </div>
      <Show when={props.error || environment()?.worker?.error}>
        <p>{props.error ?? environment()?.worker?.error}</p>
      </Show>
      <Show when={failed()}>
        <button
          class="btn"
          type="button"
          onClick={() => {
            if (props.retry) {
              props.retry();
            } else {
              void props.model.loadPendingEnvironment();
            }
          }}
        >
          {t("portalsPage.retry")}
        </button>
      </Show>
    </section>
  );
}
