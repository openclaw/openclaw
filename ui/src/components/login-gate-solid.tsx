import {
  action,
  createMemo,
  createOptimistic,
  createSignal,
  Errored,
  For,
  onSettled,
  Show,
} from "solid-js";
import type { ThemeBranding, ThemeMascot } from "../../../packages/gateway-protocol/src/theme.ts";
import { normalizeBasePath } from "../app-route-paths.ts";
import { canReloadControlUiDocument } from "../app/document-reload-guard.ts";
import { beginNativeWindowDrag } from "../app/native-window-drag.ts";
import { controlUiPublicAssetPath } from "../app/public-assets.ts";
import { retryStaleChunkReloadWhenReachable } from "../app/stale-chunk-reload.ts";
import { currentThemeBranding } from "../app/theme-branding.ts";
import { registerLoginEnglish } from "../i18n/locales/en-login.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../lib/external-link.ts";
import "../lib/toast-host.tsx";
import { formatGatewayHost } from "../lib/gateway-host.ts";
import { classifyGatewaySecret } from "../lib/gateway-secret-shape.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { listen } from "../lib/reactive/listener.ts";
import { useVisiblePoll } from "../lib/reactive/visible-poll.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import type { JSX as SolidJSX } from "../types/solid-elements.d.ts";
import {
  type LoginFailureFeedback,
  type LoginFailureFeedbackParams,
  type LoginFailureStep,
  resolveLoginFailureFeedback,
} from "./login-gate-feedback.ts";
import { ConnectCommand } from "./solid/connect-command.tsx";
import { Icon, type IconName } from "./solid/icon.tsx";
import { ThemeBrandIcon } from "./theme-brand-icon.tsx";
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
type ViewProps = { model: LoginGateProps; cancelRefresh: () => void };
const STATUS_ICONS: Record<LoginFailureFeedback["tone"], IconName> = {
  pending: "shieldEllipsis",
  warn: "clock",
  danger: "shieldAlert",
};

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
    refreshing: boolean;
    readRefreshOutcome: () => null | undefined;
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
          {(refreshAction) => (
            <button
              type="button"
              class="btn primary login-gate__failure-refresh"
              disabled={props.refreshing}
              onClick={() => props.onRefresh()}
            >
              <Show when={!props.refreshing} fallback={t("common.refreshing")}>
                <Errored fallback={t("common.retry")}>
                  {props.readRefreshOutcome() ?? refreshAction().label}
                </Errored>
              </Show>
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

function LoginGateContent(
  props: {
    model: LoginGateProps;
  },
  host: LoginGateElement,
): SolidJSX.Element {
  host.style.display = "contents";
  const refreshIdentity = createMemo(
    () =>
      [
        props.model.lastError,
        props.model.lastErrorCode,
        props.model.lastErrorAuthReason,
        props.model.gatewayUrl,
        props.model.resourceBasePath,
        props.model.secret,
        props.model.connected,
        Boolean(props.model.reconnectPending),
      ] as const,
    { equals: (previous, next) => previous.every((value, index) => value === next[index]) },
  );
  // A committed identity change retires feedback; unrelated renders preserve a pending attempt.
  const [refreshCompletion, setRefreshCompletion] = createSignal<
    { result: Promise<void> } | undefined
  >(() => {
    refreshIdentity();
    return undefined;
  });
  const refreshOutcome = createMemo(() => refreshCompletion()?.result.then(() => null), {
    loadingValue: undefined,
  });
  const [refreshing, setRefreshing] = createOptimistic(false);
  const [now, setNow] = createSignal(Date.now());
  useVisiblePoll(1_000, () => setNow(Date.now()), {
    enabled: () =>
      Boolean(props.model.reconnectPending) &&
      props.model.lastErrorCode === "GATEWAY_BUSY" &&
      (props.model.reconnectAt ?? 0) > now(),
    immediate: true,
  });
  type RefreshAttempt = {
    props: LoginGateProps;
    retired: ReturnType<typeof Promise.withResolvers<void>>;
  };
  let refreshAttempt: RefreshAttempt | undefined;
  const retireRefresh = () => {
    refreshAttempt?.retired.resolve();
    refreshAttempt = undefined;
  };
  const cancelRefresh = () => {
    retireRefresh();
    setRefreshCompletion(undefined);
  };
  const ownsRefresh = (attempt: RefreshAttempt) => {
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
  onSettled(() => {
    const stopDisconnect = listen(host, "login-gate-disconnect", cancelRefresh);
    const stopChange = listen(host, "login-gate-props-change", () => {
      // Release the action before Solid commits the replacement connection props.
      if (refreshAttempt && !ownsRefresh(refreshAttempt)) {
        retireRefresh();
      }
    });
    return () => {
      retireRefresh();
      stopDisconnect();
      stopChange();
    };
  });
  const presentRefresh = action(function* (
    attempt: RefreshAttempt,
    pending: Promise<boolean>,
  ): Generator<Promise<boolean | void>, void, boolean | void> {
    try {
      if (ownsRefresh(attempt)) {
        setRefreshing(true);
      }
      const reloaded = yield Promise.race([pending, attempt.retired.promise]);
      if (ownsRefresh(attempt) && !reloaded) {
        throw new Error("Control UI refresh did not reload the document");
      }
    } catch (error) {
      if (ownsRefresh(attempt)) {
        throw error;
      }
    } finally {
      if (refreshAttempt === attempt) {
        retireRefresh();
      }
    }
  });
  const refreshPage = async () => {
    if (refreshAttempt && !ownsRefresh(refreshAttempt)) {
      retireRefresh();
    }
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
    const attempt = {
      props: current,
      retired: Promise.withResolvers<void>(),
    };
    refreshAttempt = attempt;
    const pending = retryStaleChunkReloadWhenReachable({
      canReload: () => ownsRefresh(attempt),
    });
    const completion = presentRefresh(attempt, pending);
    setRefreshCompletion({ result: completion });
    // Retired views still consume their admitted operation's rejection.
    await completion.catch(() => undefined);
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
                <ThemeBrandIcon branding={branding()} aria-hidden="true" />
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
              refreshing={refreshing()}
              readRefreshOutcome={refreshOutcome}
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
    <Show when={props.props}>
      {(model) =>
        LoginGateContent(
          {
            get model() {
              return model();
            },
          },
          host,
        )
      }
    </Show>
  ),
  {
    properties: { props: { default: undefined, attribute: false } },
    disconnected: (host) => host.dispatchEvent(new Event("login-gate-disconnect")),
    propertyChanged: (host) => host.dispatchEvent(new Event("login-gate-props-change")),
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
