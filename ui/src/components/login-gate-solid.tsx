import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import type { ThemeBranding, ThemeMascot } from "../../../packages/gateway-protocol/src/theme.ts";
import { normalizeBasePath } from "../app-route-paths.ts";
import { canReloadControlUiDocument } from "../app/document-reload-guard.ts";
import { beginNativeWindowDrag } from "../app/native-window-drag.ts";
import { controlUiPublicAssetPath } from "../app/public-assets.ts";
import { retryStaleChunkReloadWhenReachable } from "../app/stale-chunk-reload.ts";
import { currentThemeBranding } from "../app/theme-branding.ts";
import { registerLoginEnglish } from "../i18n/locales/en-login.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../lib/external-link.ts";
import "../lib/toast.ts";
import { formatGatewayHost } from "../lib/gateway-host.ts";
import { classifyGatewaySecret } from "../lib/gateway-secret-shape.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import type { JSX as SolidJSX } from "../types/solid-elements.d.ts";
import {
  type LoginFailureFeedback,
  type LoginFailureFeedbackParams,
  type LoginFailureStep,
  resolveLoginFailureFeedback,
} from "./login-gate-feedback.ts";
import { CopyButton } from "./solid/copy-button.tsx";
import { Icon, type IconName } from "./solid/icon.tsx";
import "./theme-brand-icon.ts";
import "./tooltip.ts";

registerEnglishCatalog(registerLoginEnglish);

export type LoginGateProps = LoginFailureFeedbackParams & {
  mascot?: ThemeMascot;
  branding?: ThemeBranding;
  resourceBasePath: string;
  gatewayUrl: string;
  secret: string;
  showGatewaySecret: boolean;
  onGatewayUrlChange: (value: string) => void;
  onSecretChange: (value: string) => void;
  onToggleGatewaySecret: () => void;
  onConnect: () => void;
  onOpenGatewaySettings?: () => void;
};

type BridgeProps = { props?: LoginGateProps };
export type LoginGateElement = SolidBridgeElement<BridgeProps>;
type RefreshState = "idle" | "pending" | "failed";
type ViewProps = { model: LoginGateProps; cancelRefresh: () => void };
const STATUS_ICONS: Record<LoginFailureFeedback["tone"], IconName> = {
  pending: "shieldEllipsis",
  warn: "clock",
  danger: "shieldAlert",
};

function ConnectCommand(props: { command: string; variant?: "hero" }) {
  const copyCommand = (event: { currentTarget: HTMLElement }) => {
    event.currentTarget.querySelector<HTMLButtonElement>(".chat-copy-btn")?.click();
  };
  return (
    <openclaw-tooltip prop:content={t("connection.help.copyCommand")}>
      <div
        class={["login-gate__command", { "login-gate__command--hero": props.variant === "hero" }]}
        role="button"
        tabindex={0}
        aria-label={t("connection.help.copyCommandAria", { command: props.command })}
        onClick={(event) => {
          if (!(event.target instanceof Element && event.target.closest(".chat-copy-btn"))) {
            copyCommand(event);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            copyCommand(event);
          }
        }}
      >
        <code translate="no">{props.command}</code>
        {props.command && (
          <CopyButton text={props.command} idleLabel={t("connection.help.copyCommand")} />
        )}
      </div>
    </openclaw-tooltip>
  );
}

function FailureStep(props: { step: LoginFailureStep }) {
  const segments = createMemo(() => {
    const unmatched = new Set(props.step.commands);
    const matches = [...unmatched]
      .map((command) => [command, props.step.text.indexOf(command)] as const)
      .toSorted(([left, li], [right, ri]) => li - ri || right.length - left.length);
    const result: { text?: string; command?: string }[] = [];
    let cursor = 0;
    for (const [command, index] of matches) {
      if (index < cursor) {
        continue;
      }
      result.push({ text: props.step.text.slice(cursor, index) }, { command });
      unmatched.delete(command);
      cursor = index + command.length;
    }
    result.push({ text: props.step.text.slice(cursor) });
    for (const command of unmatched) {
      result.push({ text: " " }, { command });
    }
    return result;
  });
  return (
    <For each={segments()} keyed={false}>
      {(segment) => (
        <Show when={segment().command} fallback={segment().text}>
          {(command) => <ConnectCommand command={command()} />}
        </Show>
      )}
    </For>
  );
}

function Steps(props: { feedback: LoginFailureFeedback }) {
  return (
    <Show when={props.feedback.steps.length > 0}>
      <ol class="login-gate__failure-steps">
        <For each={props.feedback.steps} keyed={false}>
          {(step) => (
            <li>
              <FailureStep step={step()} />
            </li>
          )}
        </For>
      </ol>
    </Show>
  );
}

function FailureFooter(props: { feedback: LoginFailureFeedback }) {
  return (
    <footer class="login-gate__foot">
      <details class="login-gate__failure-detail">
        <summary>{t("login.failure.rawError")}</summary>
        <div class="login-gate__failure-raw mono">{props.feedback.rawError}</div>
      </details>
      <a
        class="session-link login-gate__failure-docs"
        href={props.feedback.docsHref}
        target={EXTERNAL_LINK_TARGET}
        rel={buildExternalLinkRel()}
      >
        {t("common.learnMore")}
      </a>
    </footer>
  );
}

function LoginForm(
  props: ViewProps & { feedback: LoginFailureFeedback | null; withSubmit: boolean },
) {
  const setupCode = () => classifyGatewaySecret(props.model.secret) === "setup-code";
  const invalidField = () =>
    props.feedback?.placement === "form" ? props.feedback.field : undefined;
  const connect = () => {
    props.cancelRefresh();
    props.model.onConnect();
  };
  const submitOnEnter = (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      connect();
    }
  };
  return (
    <div class="login-gate__form">
      <div class="field">
        <label for="login-gate-url">{t("login.gatewayUrl")}</label>
        <input
          id="login-gate-url"
          inputmode="url"
          autocapitalize="none"
          autocorrect="off"
          autocomplete="off"
          spellcheck="false"
          enterkeyhint="go"
          aria-invalid={invalidField() === "url" ? "true" : undefined}
          value={props.model.gatewayUrl}
          onInput={(event) => {
            props.cancelRefresh();
            props.model.onGatewayUrlChange(event.currentTarget.value);
          }}
          onKeyDown={submitOnEnter}
          placeholder="wss://gateway.example:443"
        />
      </div>
      <div class="field">
        <label for="login-gate-credential">{t("login.secret")}</label>
        <span class="settings-secret">
          <input
            id="login-gate-credential"
            type={props.model.showGatewaySecret ? "text" : "password"}
            autocomplete="off"
            spellcheck="false"
            enterkeyhint="go"
            aria-invalid={invalidField() === "credential" ? "true" : undefined}
            aria-describedby={setupCode() ? "login-gate-secret-hint" : undefined}
            value={props.model.secret}
            onInput={(event) => {
              props.cancelRefresh();
              props.model.onSecretChange(event.currentTarget.value);
            }}
            onKeyDown={submitOnEnter}
            placeholder={t("login.secretPlaceholder")}
          />
          <openclaw-tooltip
            prop:content={t(
              props.model.showGatewaySecret ? "login.hideSecret" : "login.showSecret",
            )}
          >
            <button
              type="button"
              class="settings-secret__toggle"
              aria-label={t("login.toggleSecretVisibility")}
              aria-pressed={props.model.showGatewaySecret ? "true" : "false"}
              onClick={() => props.model.onToggleGatewaySecret()}
            >
              <Icon name={props.model.showGatewaySecret ? "eye" : "eyeOff"} />
            </button>
          </openclaw-tooltip>
        </span>
        {setupCode() && (
          <p id="login-gate-secret-hint" class="muted" role="status">
            {t("login.setupCodeHint")}
          </p>
        )}
      </div>
      {props.withSubmit && (
        <button class="btn primary login-gate__connect" onClick={connect}>
          {t("common.connect")}
        </button>
      )}
    </div>
  );
}

function ConnectionSummary(props: { model: LoginGateProps }) {
  const credential = () =>
    t(props.model.secret.trim() ? "login.connection.secretEntered" : "login.connection.noSecret");
  return (
    <summary>
      <span class="login-gate__connection-target">
        <Icon name="server" />
        <span>
          {t("login.connection.target", { host: formatGatewayHost(props.model.gatewayUrl) })}
        </span>
      </span>{" "}
      <span class="login-gate__connection-cred">· {credential()}</span>{" "}
      <span class="login-gate__connection-change">{t("login.connection.change")}</span>
    </summary>
  );
}

function StatusBody(
  props: ViewProps & {
    feedback: LoginFailureFeedback;
    refreshState: RefreshState;
    onRefresh: () => void;
    now: number;
  },
) {
  const waiting = () => props.feedback.kind === "pairing-required" && props.model.reconnectPending;
  const retrySeconds = () =>
    Math.max(0, Math.ceil(((props.model.reconnectAt ?? 0) - props.now) / 1000));
  const connectLabel = () => {
    if (props.feedback.kind === "pairing-rejected" || props.feedback.kind === "pairing-expired") {
      return t("login.failure.pairing.requestAgain");
    }
    return t(waiting() ? "login.failure.pairing.checkNow" : "common.connect");
  };
  return (
    <section
      class="login-gate__body login-gate__failure"
      role="status"
      aria-live="polite"
      data-kind={props.feedback.kind}
      data-tone={props.feedback.tone}
    >
      <div class="login-gate__status-head">
        <span class="login-gate__status-icon" aria-hidden="true">
          <Icon name={STATUS_ICONS[props.feedback.tone]} />
        </span>
        <div class="login-gate__status-text">
          <h1 class="login-gate__failure-title">{props.feedback.title}</h1>
          <p class="login-gate__failure-summary">{props.feedback.summary}</p>
        </div>
      </div>
      <Show when={props.feedback.primaryCommand}>
        {(command) => (
          <div class="login-gate__hero">
            <span class="login-gate__hero-label">{t("login.runOnHost")}</span>
            <ConnectCommand command={command()} variant="hero" />
          </div>
        )}
      </Show>
      <Steps feedback={props.feedback} />
      {props.feedback.kind === "busy" && (
        <p class="login-gate__retry" aria-live="off">
          {retrySeconds() > 0
            ? t("login.failure.busy.countdown", { seconds: String(retrySeconds()) })
            : t("login.failure.busy.retrying")}
        </p>
      )}
      {waiting() && (
        <p class="login-gate__failure-summary">
          <span class="session-run-spinner" aria-hidden="true" />
          {t("login.failure.pairing.waiting")}
        </p>
      )}
      <div class="login-gate__actions">
        <Show when={props.feedback.refreshAction}>
          {(action) => (
            <button
              type="button"
              class="btn primary login-gate__failure-refresh"
              disabled={props.refreshState === "pending"}
              onClick={props.onRefresh}
            >
              {props.refreshState === "pending"
                ? t("common.refreshing")
                : props.refreshState === "failed"
                  ? t("common.retry")
                  : action().label}
            </button>
          )}
        </Show>
        <button
          class="btn login-gate__connect"
          onClick={() => {
            props.cancelRefresh();
            props.model.onConnect();
          }}
        >
          {connectLabel()}
        </button>
      </div>
      <details class="login-gate__connection">
        <ConnectionSummary model={props.model} />
        <LoginForm {...props} withSubmit={false} />
      </details>
      <FailureFooter feedback={props.feedback} />
    </section>
  );
}

function FormBody(props: ViewProps & { feedback: LoginFailureFeedback | null }) {
  return (
    <section
      class={props.feedback ? "login-gate__body login-gate__failure" : "login-gate__body"}
      role={props.feedback ? "status" : undefined}
      aria-live={props.feedback ? "polite" : undefined}
      data-kind={props.feedback?.kind}
      data-tone={props.feedback?.tone}
    >
      <div class="login-gate__status-text">
        <h1 class={props.feedback ? "login-gate__failure-title" : "login-gate__heading"}>
          {props.feedback?.title ?? t("login.heading")}
        </h1>
        <p class={props.feedback ? "login-gate__failure-summary" : "login-gate__lede"}>
          {props.feedback?.summary ?? t("login.lede")}
        </p>
      </div>
      <LoginForm {...props} withSubmit />
      {props.feedback ? (
        <>
          <Steps feedback={props.feedback} />
          <FailureFooter feedback={props.feedback} />
        </>
      ) : (
        <details class="login-gate__help">
          <summary class="login-gate__help-title">{t("connection.help.title")}</summary>
          <ol class="login-gate__steps">
            <li>
              {t("connection.help.step1")}
              <ConnectCommand command="openclaw gateway run" />
            </li>
            <li>
              {t("connection.help.step2")} <ConnectCommand command="openclaw dashboard" />
            </li>
            <li>{t("connection.help.step3")}</li>
          </ol>
          <div class="login-gate__docs">
            <a
              class="session-link"
              href="https://docs.openclaw.ai/web/dashboard"
              target={EXTERNAL_LINK_TARGET}
              rel={buildExternalLinkRel()}
            >
              {t("connection.help.docsLink")}
            </a>
          </div>
        </details>
      )}
    </section>
  );
}

function LoginGateContent(props: {
  model: LoginGateProps;
  host: LoginGateElement;
}): SolidJSX.Element {
  const host = untrack(() => props.host);
  host.style.display = "contents";
  const [refreshState, setRefreshState] = createSignal<RefreshState>("idle");
  const [now, setNow] = createSignal(Date.now());
  let refreshAttempt: { props: LoginGateProps } | undefined;
  const cancelRefresh = () => {
    refreshAttempt = undefined;
    setRefreshState("idle");
  };
  const ownsRefresh = (attempt: { props: LoginGateProps }) => {
    const current = host.props;
    return (
      refreshAttempt === attempt &&
      host.isConnected &&
      current !== undefined &&
      !current.connected &&
      !current.reconnectPending &&
      (
        [
          "lastError",
          "lastErrorCode",
          "lastErrorAuthReason",
          "gatewayUrl",
          "resourceBasePath",
          "secret",
        ] as const
      ).every((key) => current[key] === attempt.props[key])
    );
  };
  const feedback = createMemo(() => resolveLoginFailureFeedback(props.model));
  createEffect(
    () => props.model,
    () => {
      if (refreshAttempt && !ownsRefresh(refreshAttempt)) {
        cancelRefresh();
      }
    },
  );
  createEffect(
    () =>
      props.model.reconnectPending &&
      props.model.lastErrorCode === "GATEWAY_BUSY" &&
      (props.model.reconnectAt ?? 0) > now(),
    (running) => {
      if (!running) {
        return undefined;
      }
      let timer: ReturnType<typeof setInterval> | undefined;
      const update = () => {
        if (timer !== undefined) {
          clearInterval(timer);
        }
        timer = undefined;
        if (document.visibilityState !== "hidden") {
          setNow(Date.now());
          timer = setInterval(() => setNow(Date.now()), 1000);
        }
      };
      update();
      document.addEventListener("visibilitychange", update);
      return () => {
        if (timer !== undefined) {
          clearInterval(timer);
        }
        document.removeEventListener("visibilitychange", update);
      };
    },
  );
  host.addEventListener("login-gate-disconnect", cancelRefresh);
  onCleanup(() => {
    cancelRefresh();
    host.removeEventListener("login-gate-disconnect", cancelRefresh);
  });
  const refreshPage = async () => {
    const current = host.props;
    if (
      !current ||
      refreshAttempt ||
      !host.isConnected ||
      current.connected ||
      current.reconnectPending ||
      !resolveLoginFailureFeedback(current)?.refreshAction ||
      !canReloadControlUiDocument(true)
    ) {
      return;
    }
    const attempt = { props: current };
    refreshAttempt = attempt;
    setRefreshState("pending");
    try {
      const reloaded = await retryStaleChunkReloadWhenReachable({
        canReload: () => ownsRefresh(attempt),
      });
      if (ownsRefresh(attempt) && !reloaded) {
        setRefreshState("failed");
      }
    } catch {
      if (ownsRefresh(attempt)) {
        setRefreshState("failed");
      }
    } finally {
      if (refreshAttempt === attempt) {
        if (!ownsRefresh(attempt)) {
          cancelRefresh();
        } else {
          refreshAttempt = undefined;
        }
      }
    }
  };
  const branding = () => props.model.branding ?? currentThemeBranding();
  const brandIcon = () =>
    props.model.branding?.brandIcon ?? (props.model.mascot === "none" ? "mark" : "claw");
  return (
    <div
      class="login-gate"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          beginNativeWindowDrag(event);
        }
      }}
    >
      <openclaw-toast-host />
      <div class="login-gate__card" data-mode={feedback()?.placement ?? "form"}>
        <header class="login-gate__brand">
          {brandIcon() === "claw" ? (
            <img
              class="login-gate__logo"
              src={controlUiPublicAssetPath(
                "favicon.svg",
                normalizeBasePath(props.model.resourceBasePath),
              )}
              alt=""
            />
          ) : (
            <span class="login-gate__logo login-gate__logo--neutral" aria-hidden="true">
              {branding().brandIcon !== "claw" && branding().brandIcon !== "mark" ? (
                <openclaw-theme-brand-icon prop:branding={branding()} aria-hidden="true" />
              ) : (
                <Icon name="mark" />
              )}
            </span>
          )}
          <span class="login-gate__brand-name">{branding().brandName}</span>
        </header>
        <Show
          when={feedback()?.placement === "status" ? feedback() : null}
          fallback={
            <FormBody model={props.model} feedback={feedback()} cancelRefresh={cancelRefresh} />
          }
        >
          {(value) => (
            <StatusBody
              model={props.model}
              feedback={value()}
              cancelRefresh={cancelRefresh}
              refreshState={refreshState()}
              onRefresh={() => void refreshPage()}
              now={now()}
            />
          )}
        </Show>
        {props.model.onOpenGatewaySettings && (
          <footer class="login-gate__recovery">
            <button
              type="button"
              class="btn btn--ghost"
              onClick={() => props.model.onOpenGatewaySettings?.()}
            >
              {t("login.gatewaySettings")}
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}

export const LoginGate = defineSolidBridge<BridgeProps>(
  "openclaw-login-gate",
  (props, host) => (
    <Show when={props.props}>{(model) => <LoginGateContent model={model()} host={host} />}</Show>
  ),
  {
    properties: { props: { default: undefined, attribute: false } },
    disconnected: (host) => host.dispatchEvent(new Event("login-gate-disconnect")),
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-login-gate": LoginGateElement;
  }
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-toast-host": HTMLAttributes<HTMLElementTagNameMap["openclaw-toast-host"]> &
        Properties<HTMLElementTagNameMap["openclaw-toast-host"]>;
    }
  }
}
