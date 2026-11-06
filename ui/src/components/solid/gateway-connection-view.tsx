import type { JSX } from "@solidjs/web";
import { createUniqueId, For, Show } from "solid-js";
import type { GatewayStatus } from "../../lib/gateway-status.ts";
import { t } from "../../lib/reactive/i18n.ts";

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
        <div class="gateway-connection-view__mark" aria-hidden="true">
          <Show when={busy()} fallback={<span class="gateway-connection-view__dot" />}>
            <span class="session-run-spinner" />
          </Show>
        </div>
        <h1 id="gateway-connection-title">{t("connection.workspace." + state() + ".title")}</h1>
        <p class="gateway-connection-view__description" role="status" aria-live="polite">
          {t("connection.workspace." + state() + ".description")}
        </p>
        <div class="gateway-connection-view__actions">
          <Show when={canRetry()}>
            <button class="btn" type="button" onClick={() => props.onRetry()}>
              {t("connection.workspace.tryAgain")}
            </button>
          </Show>
          <Show when={state() === "reload"}>
            <button class="btn" type="button" onClick={() => void props.onReload()}>
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
      <span class="sidebar-connection-skeleton__heading" />
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
  // Inline, so the mark renders while the Gateway and its assets are unreachable.
  const gradient = createUniqueId();
  return (
    <span class="gateway-identity-placeholder" data-kind={props.kind} aria-hidden="true">
      <Show when={props.kind === "agent"}>
        <svg viewBox="0 0 120 120" fill="none">
          <defs>
            <linearGradient id={gradient} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#ff4d4d" />
              <stop offset="100%" stop-color="#991b1b" />
            </linearGradient>
          </defs>
          <path
            d="M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z"
            fill={"url(#" + gradient + ")"}
          />
          <path
            d="M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z"
            fill={"url(#" + gradient + ")"}
          />
          <path
            d="M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z"
            fill={"url(#" + gradient + ")"}
          />
          <path d="M45 15 Q35 5 30 8" stroke="#ff4d4d" stroke-width="3" stroke-linecap="round" />
          <path d="M75 15 Q85 5 90 8" stroke="#ff4d4d" stroke-width="3" stroke-linecap="round" />
          <circle cx="45" cy="35" r="6" fill="#181A1F" />
          <circle cx="75" cy="35" r="6" fill="#181A1F" />
          <circle cx="46" cy="34" r="2.5" fill="#DDE2E9" opacity="0.82" />
          <circle cx="76" cy="34" r="2.5" fill="#DDE2E9" opacity="0.82" />
        </svg>
      </Show>
    </span>
  );
}
