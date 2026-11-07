import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import type { GatewayStatus } from "../../lib/gateway-status.ts";
import { t } from "../../lib/reactive/i18n.ts";

const wordmarkDarkText = new URL(
  "../../assets/brand/openclaw-horizontal-dark-text.svg",
  import.meta.url,
).href;
const wordmarkLightText = new URL(
  "../../assets/brand/openclaw-horizontal-light-text.svg",
  import.meta.url,
).href;

/** Cold connections use the real shell; presented conversations retain their own feedback. */
export function GatewayConnectionView(props: {
  kind: GatewayStatus;
  retryPending: boolean;
  hasFailedAttempt?: boolean;
  reconnectAt?: number;
  onRetry: () => void;
  onReload: () => Promise<boolean>;
}): JSX.Element {
  const state = () => {
    if (props.kind === "connecting" && props.hasFailedAttempt) {
      return "reconnecting";
    }
    if (props.kind === "offline" && props.reconnectAt !== undefined) {
      return "reconnecting";
    }
    if (props.kind === "offline" && props.retryPending) {
      return "connecting";
    }
    if (props.kind === "suspending") {
      return "pausing";
    }
    if (props.kind === "suspended") {
      return "paused";
    }
    if (props.kind === "reload-required") {
      return "reload";
    }
    return props.kind;
  };
  const busy = () => !["offline", "paused", "reload"].includes(state());
  const canRetry = () => state() === "offline" && !props.retryPending;
  return (
    <section
      class="gateway-connection-view"
      aria-labelledby="gateway-connection-title"
      data-connection-state={state()}
    >
      <div class="gateway-connection-view__body">
        <h1 id="gateway-connection-title">
          <Show when={busy()}>
            <span class="gateway-connection-view__spin session-run-spinner" aria-hidden="true" />
          </Show>
          {t("connection.workspace." + state() + ".title")}
        </h1>
        <p class="gateway-connection-view__description" role="status" aria-live="polite">
          {t("connection.workspace." + state() + ".description")}
        </p>
        <div class="gateway-connection-view__actions">
          <Show when={canRetry()}>
            <button class="btn primary" type="button" onClick={() => props.onRetry()}>
              {t("connection.workspace.tryAgain")}
            </button>
          </Show>
          <Show when={state() === "reload"}>
            <button class="btn primary" type="button" onClick={() => void props.onReload()}>
              {t("connection.workspace.reloadAction")}
            </button>
          </Show>
        </div>
      </div>
    </section>
  );
}

export function GatewaySidebarSkeleton(): JSX.Element {
  return (
    <div class="sidebar-connection-skeleton" aria-hidden="true">
      <span class="sidebar-connection-skeleton__brand">
        <img class="sidebar-connection-skeleton__brand-light" src={wordmarkDarkText} alt="" />
        <img class="sidebar-connection-skeleton__brand-dark" src={wordmarkLightText} alt="" />
      </span>
      <div class="sidebar-connection-skeleton__rows">
        <For each={[0, 1, 2, 3]}>
          {() => (
            <span class="sidebar-connection-skeleton__row">
              <span />
              <span />
            </span>
          )}
        </For>
      </div>
    </div>
  );
}

export function GatewayIdentityPlaceholder(props: { kind: "agent" | "user" }): JSX.Element {
  return <span class="gateway-identity-placeholder" data-kind={props.kind} aria-hidden="true" />;
}
