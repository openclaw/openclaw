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
    <span class="gateway-mascot" data-pose={props.pose} aria-hidden="true">
      <span class="gateway-mascot__ground" />
      <svg class="gateway-mascot__figure" viewBox="-2 2 124 112">
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
        <g class="gateway-mascot__claw gateway-mascot__claw--left">
          <path
            d="M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z"
            fill="url(#gateway-mascot-shell)"
          />
        </g>
        <g class="gateway-mascot__claw gateway-mascot__claw--right">
          <path
            d="M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z"
            fill="url(#gateway-mascot-shell)"
          />
        </g>
        <path
          d="M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z"
          fill="url(#gateway-mascot-shell)"
        />
        <g class="gateway-mascot__eyes">
          <g class="gateway-mascot__lids">
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

// The wordmark's letters (assets/brand/openclaw-horizontal-*-text.svg) without the lockup's mascot,
// for the phone header, which sits directly above the status view's own mascot.
const WORDMARK_LETTERS: ReadonlyArray<readonly [string, string]> = [
  [
    "M385 -10Q219 -10 122.0 84.0Q25 178 25.0 335.0Q25 492 122.0 586.0Q219 680 385 680Q554 680 651.5 586.5Q749 493 749.0 335.0Q749 177 651.5 83.5Q554 -10 385 -10ZM229.0 179.0Q274 134 385.0 134.0Q496 134 542.5 179.0Q589 224 589.0 335.0Q589 446 542.5 491.0Q496 536 385.0 536.0Q274 536 229.0 491.0Q184 446 184.0 335.0Q184 224 229.0 179.0Z",
    "translate(0.0000 0.0000) scale(0.108000 -0.108000)",
  ],
  [
    "M190 -170H40V501H179V364H189Q217 511 389 511Q503 511 566.0 441.0Q629 371 629.0 250.0Q629 129 567.5 59.5Q506 -10 394 -10Q309 -10 259.5 28.5Q210 67 197 135H190ZM190 243Q190 181 226.5 154.0Q263 127 336 127Q410 127 443.5 155.0Q477 183 477.0 250.0Q477 317 443.5 345.0Q410 373 337 373Q262 373 226.0 344.5Q190 316 190 251Z",
    "translate(85.7520 0.0000) scale(0.108000 -0.108000)",
  ],
  [
    "M306 -10Q176 -10 100.5 55.5Q25 121 25 250Q25 369 101.5 440.0Q178 511 303.0 511.0Q428 511 502.0 447.5Q576 384 576 268Q576 254 572 220H164Q167 161 198.0 135.5Q229 110 301 110Q366 110 393.5 126.5Q421 143 421 176V186H571V175Q571 93 498.0 41.5Q425 -10 306 -10ZM166 299H432Q429 349 397.5 371.5Q366 394 300.0 394.0Q234 394 202.5 371.0Q171 348 166 299Z",
    "translate(158.2200 0.0000) scale(0.108000 -0.108000)",
  ],
  [
    "M190 0H40V501H179V347H188Q199 417 249.5 464.0Q300 511 392 511Q491 511 542.5 455.5Q594 400 594 312V0H444V262Q444 323 415.5 349.5Q387 376 319 376Q249 376 219.5 347.0Q190 318 190 253Z",
    "translate(225.1800 0.0000) scale(0.108000 -0.108000)",
  ],
  [
    "M383 -10Q218 -10 121.5 84.0Q25 178 25.0 335.0Q25 492 121.5 586.0Q218 680 383 680Q540 680 632.5 606.5Q725 533 725 406V391H558V406Q558 473 517.0 504.5Q476 536 386 536Q275 536 229.5 491.0Q184 446 184.0 335.0Q184 224 229.5 179.0Q275 134 386 134Q476 134 517.0 165.5Q558 197 558 264V279H725V264Q725 137 632.5 63.5Q540 -10 383 -10Z",
    "translate(295.3800 0.0000) scale(0.108000 -0.108000)",
  ],
  ["M190 0H40V670H190Z", "translate(378.5400 0.0000) scale(0.108000 -0.108000)"],
  [
    "M194 -10Q113 -10 67.0 25.5Q21 61 21 124Q21 238 183 255L398 277V296Q398 344 374.0 361.5Q350 379 289 379Q231 379 206.5 361.5Q182 344 182 302V298H31V301Q31 395 104.0 453.0Q177 511 300 511Q422 511 484.0 453.0Q546 395 546 294V0H406V115H398Q380 56 328.0 23.0Q276 -10 194 -10ZM172 134Q172 96 237 96Q316 96 355.5 117.5Q395 139 398 191L224 171Q172 167 172 134Z",
    "translate(405.4320 0.0000) scale(0.108000 -0.108000)",
  ],
  [
    "M324 0H137L0 501H155L214 272L235 116H245L285 287L361 501H554L629 287L669 116H679L701 272L759 501H912L770 0H583L497 241L460 379H449L411 241Z",
    "translate(470.4480 0.0000) scale(0.108000 -0.108000)",
  ],
];

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
        <For each={WORDMARK_LETTERS}>
          {([d, transform]) => <path d={d} transform={transform} />}
        </For>
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
