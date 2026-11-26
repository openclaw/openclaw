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
  // The mascot is the busy indicator; settled, it looks toward the button or up at the news.
  const pose = () =>
    busy() ? "busy" : state() === "offline" ? "error" : state() === "reload" ? "updated" : "rest";
  return (
    <section
      class="gateway-connection-view"
      aria-labelledby="gateway-connection-title"
      data-connection-state={state()}
    >
      <div class="gateway-connection-view__body">
        <GatewayMascot pose={pose()} />
        <h1 id="gateway-connection-title">{t("connection.workspace." + state() + ".title")}</h1>
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

/** The OpenClaw mascot from the brand wordmark, split so its claws, eyes and lids can move. */
function GatewayMascot(props: { pose: "busy" | "error" | "updated" | "rest" }): JSX.Element {
  return (
    <span class="gateway-mascot mount-fallback__mascot" data-pose={props.pose} aria-hidden="true">
      <span class="gateway-mascot__ground mount-fallback__mascot-ground" />
      <svg class="gateway-mascot__figure mount-fallback__mascot-figure" viewBox="-2 2 124 112">
        <defs>
          <linearGradient id="gateway-mascot-shell" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#ff4d4d" />
            <stop offset="100%" stop-color="#991b1b" />
          </linearGradient>
        </defs>
        <g fill="none" stroke="#ff4d4d" stroke-width="3" stroke-linecap="round">
          <path d="M45 15 Q35 5 30 8" />
          <path d="M75 15 Q85 5 90 8" />
        </g>
        <g class="gateway-mascot__claw gateway-mascot__claw--left mount-fallback__mascot-claw-left">
          <path
            d="M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z"
            fill="url(#gateway-mascot-shell)"
          />
        </g>
        <g class="gateway-mascot__claw gateway-mascot__claw--right mount-fallback__mascot-claw-right">
          <path
            d="M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z"
            fill="url(#gateway-mascot-shell)"
          />
        </g>
        <path
          d="M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z"
          fill="url(#gateway-mascot-shell)"
        />
        <g class="gateway-mascot__eyes mount-fallback__mascot-eyes">
          <g class="gateway-mascot__lids mount-fallback__mascot-lids">
            <circle cx="45" cy="35" r="6" fill="#181A1F" />
            <circle cx="75" cy="35" r="6" fill="#181A1F" />
            <circle cx="46" cy="34" r="2.5" fill="#DDE2E9" opacity="0.82" />
            <circle cx="76" cy="34" r="2.5" fill="#DDE2E9" opacity="0.82" />
          </g>
        </g>
      </svg>
    </span>
  );
}

export function GatewayWordmarkText(props: {
  class: string;
  fill: string;
  label: string;
}): JSX.Element {
  return (
    <svg
      class={props.class}
      viewBox="203 0 567 180"
      fill="none"
      role="img"
      aria-label={props.label}
    >
      <g fill={props.fill} transform="translate(200.5 116.564)">
        <use href="#openclaw-wordmark-letters" />
      </g>
    </svg>
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
