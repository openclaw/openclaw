// Control UI component renders the login gate.
import { html, nothing, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import type { ThemeMascot } from "../../../packages/gateway-protocol/src/theme.ts";
import { normalizeBasePath } from "../app-route-paths.ts";
import { canReloadControlUiDocument } from "../app/document-reload-guard.ts";
import { beginNativeWindowDrag } from "../app/native-window-drag.ts";
import { controlUiPublicAssetPath } from "../app/public-assets.ts";
import { retryStaleChunkReloadWhenReachable } from "../app/stale-chunk-reload.ts";
import { t } from "../i18n/index.ts";
import "../lib/toast.ts";
import { registerLoginEnglish } from "../i18n/locales/en-login.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../lib/external-link.ts";
import { formatGatewayHost } from "../lib/gateway-host.ts";
import { classifyGatewaySecret } from "../lib/gateway-secret-shape.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { renderConnectCommand } from "./connect-command.ts";
import { icons } from "./icons.ts";
import {
  type LoginFailureFeedback,
  type LoginFailureFeedbackParams,
  type LoginFailureStep,
  type LoginFailureTone,
  resolveLoginFailureFeedback,
} from "./login-gate-feedback.ts";

registerLoginEnglish();

type LoginGateProps = LoginFailureFeedbackParams & {
  mascot?: ThemeMascot;
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

const TONE_ICONS: Record<LoginFailureTone, TemplateResult> = {
  pending: icons.shieldEllipsis,
  warn: icons.clock,
  danger: icons.shieldAlert,
};

type RefreshAction = {
  state: "idle" | "pending" | "failed";
  onRefresh: () => void;
};

function renderLoginFailureStep({ text, commands }: LoginFailureStep) {
  const unmatchedCommands = new Set(commands);
  const matches = [...unmatchedCommands]
    .map((command) => [command, text.indexOf(command)] as const)
    .toSorted(
      ([left, leftIndex], [right, rightIndex]) =>
        leftIndex - rightIndex || right.length - left.length,
    );
  const segments: (string | ReturnType<typeof renderConnectCommand>)[] = [];
  let cursor = 0;

  for (const [command, index] of matches) {
    if (index < cursor) {
      continue;
    }
    segments.push(text.slice(cursor, index), renderConnectCommand(command));
    unmatchedCommands.delete(command);
    cursor = index + command.length;
  }

  segments.push(text.slice(cursor));
  for (const command of unmatchedCommands) {
    segments.push(" ", renderConnectCommand(command));
  }
  return segments;
}

function renderSteps(feedback: LoginFailureFeedback) {
  if (feedback.steps.length === 0) {
    return nothing;
  }
  return html`
    <ol class="login-gate__failure-steps">
      ${feedback.steps.map((step) => html`<li>${renderLoginFailureStep(step)}</li>`)}
    </ol>
  `;
}

function renderFailureFooter(feedback: LoginFailureFeedback) {
  return html`
    <footer class="login-gate__foot">
      <details class="login-gate__failure-detail">
        <summary>${t("login.failure.rawError")}</summary>
        <div class="login-gate__failure-raw mono">${feedback.rawError}</div>
      </details>
      <a
        class="session-link login-gate__failure-docs"
        href=${feedback.docsHref}
        target=${EXTERNAL_LINK_TARGET}
        rel=${buildExternalLinkRel()}
        >${t("common.learnMore")}</a
      >
    </footer>
  `;
}

function renderRefreshAction(feedback: LoginFailureFeedback, action: RefreshAction) {
  if (!feedback.refreshAction) {
    return nothing;
  }
  return html`
    <button
      type="button"
      class="btn primary login-gate__failure-refresh"
      ?disabled=${action.state === "pending"}
      @click=${action.onRefresh}
    >
      ${
        action.state === "pending"
          ? t("common.refreshing")
          : action.state === "failed"
            ? t("common.retry")
            : feedback.refreshAction.label
      }
    </button>
  `;
}

function renderSecretToggle(
  revealed: boolean,
  labels: [string, string, string],
  onToggle: () => void,
) {
  const [show, hide, toggle] = labels;
  return html`
    <openclaw-tooltip .content=${revealed ? hide : show}>
      <button
        type="button"
        class="settings-secret__toggle"
        aria-label=${toggle}
        aria-pressed=${revealed}
        @click=${onToggle}
      >
        ${revealed ? icons.eye : icons.eyeOff}
      </button>
    </openclaw-tooltip>
  `;
}

function renderForm(params: {
  props: LoginGateProps;
  feedback: LoginFailureFeedback | null;
  withSubmit: boolean;
}) {
  const { props, feedback } = params;
  const isSetupCode = classifyGatewaySecret(props.secret) === "setup-code";
  const invalidField = feedback?.placement === "form" ? feedback.field : undefined;
  const submitOnEnter = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      props.onConnect();
    }
  };

  return html`
    <div class="login-gate__form">
      <div class="field">
        <label for="login-gate-url">${t("login.gatewayUrl")}</label>
        <input
          id="login-gate-url"
          inputmode="url"
          autocapitalize="none"
          autocorrect="off"
          autocomplete="off"
          spellcheck="false"
          enterkeyhint="go"
          aria-invalid=${invalidField === "url" ? "true" : nothing}
          .value=${props.gatewayUrl}
          @input=${(e: Event) => {
            props.onGatewayUrlChange((e.target as HTMLInputElement).value);
          }}
          @keydown=${submitOnEnter}
          placeholder="wss://gateway.example:443"
        />
      </div>
      <div class="field">
        <label for="login-gate-credential">${t("login.secret")}</label>
        <span class="settings-secret">
          <input
            id="login-gate-credential"
            type=${props.showGatewaySecret ? "text" : "password"}
            autocomplete="off"
            spellcheck="false"
            enterkeyhint="go"
            aria-invalid=${invalidField === "credential" ? "true" : nothing}
            aria-describedby=${isSetupCode ? "login-gate-secret-hint" : nothing}
            .value=${props.secret}
            @input=${(e: Event) => {
              props.onSecretChange((e.target as HTMLInputElement).value);
            }}
            @keydown=${submitOnEnter}
            placeholder=${t("login.secretPlaceholder")}
          />
          ${renderSecretToggle(
            props.showGatewaySecret,
            [t("login.showSecret"), t("login.hideSecret"), t("login.toggleSecretVisibility")],
            props.onToggleGatewaySecret,
          )}
        </span>
        ${isSetupCode ? html`<p id="login-gate-secret-hint" class="muted" role="status">${t("login.setupCodeHint")}</p>` : nothing}
      </div>
      ${
        params.withSubmit
          ? html`
              <button class="btn primary login-gate__connect" @click=${props.onConnect}>
                ${t("common.connect")}
              </button>
            `
          : nothing
      }
    </div>
  `;
}

function renderConnectionSummary(props: LoginGateProps) {
  const host = formatGatewayHost(props.gatewayUrl);
  const credential = props.secret.trim()
    ? t("login.connection.secretEntered")
    : t("login.connection.noSecret");
  return html`
    <summary>
      <span class="login-gate__connection-target">
        ${icons.server}
        <span>${t("login.connection.target", { host })}</span>
      </span>
      <span class="login-gate__connection-cred">· ${credential}</span>
      <span class="login-gate__connection-change">${t("login.connection.change")}</span>
    </summary>
  `;
}

function renderStatusBody(params: {
  props: LoginGateProps;
  feedback: LoginFailureFeedback;
  refreshAction: RefreshAction;
}) {
  const { props, feedback } = params;
  const waitingForPairing = feedback.kind === "pairing-required" && props.reconnectPending;
  return html`
    <section
      class="login-gate__body login-gate__failure"
      role="status"
      aria-live="polite"
      data-kind=${feedback.kind}
      data-tone=${feedback.tone}
    >
      <div class="login-gate__status-head">
        <span class="login-gate__status-icon" aria-hidden="true">${TONE_ICONS[feedback.tone]}</span>
        <div class="login-gate__status-text">
          <h1 class="login-gate__failure-title">${feedback.title}</h1>
          <p class="login-gate__failure-summary">${feedback.summary}</p>
        </div>
      </div>
      ${
        feedback.primaryCommand
          ? html`
              <div class="login-gate__hero">
                <span class="login-gate__hero-label">${t("login.runOnHost")}</span>
                ${renderConnectCommand(feedback.primaryCommand, "hero")}
              </div>
            `
          : nothing
      }
      ${renderSteps(feedback)}
      ${
        waitingForPairing
          ? html`<p class="login-gate__failure-summary">
              <span class="session-run-spinner" aria-hidden="true"></span>
              ${t("login.failure.pairing.waiting")}
            </p>`
          : nothing
      }
      <div class="login-gate__actions">
        ${renderRefreshAction(feedback, params.refreshAction)}
        <button class="btn login-gate__connect" @click=${props.onConnect}>
          ${waitingForPairing ? t("login.failure.pairing.checkNow") : t("common.connect")}
        </button>
      </div>
      <details class="login-gate__connection">
        ${renderConnectionSummary(props)} ${renderForm({ ...params, withSubmit: false })}
      </details>
      ${renderFailureFooter(feedback)}
    </section>
  `;
}

function renderFormBody(params: { props: LoginGateProps; feedback: LoginFailureFeedback | null }) {
  const { feedback } = params;
  return html`
    <section
      class=${feedback ? "login-gate__body login-gate__failure" : "login-gate__body"}
      role=${feedback ? "status" : nothing}
      aria-live=${feedback ? "polite" : nothing}
      data-kind=${feedback?.kind ?? nothing}
      data-tone=${feedback?.tone ?? nothing}
    >
      <div class="login-gate__status-text">
        <h1 class=${feedback ? "login-gate__failure-title" : "login-gate__heading"}>
          ${feedback?.title ?? t("login.heading")}
        </h1>
        <p class=${feedback ? "login-gate__failure-summary" : "login-gate__lede"}>
          ${feedback?.summary ?? t("login.lede")}
        </p>
      </div>
      ${renderForm({ ...params, withSubmit: true })}
      ${
        feedback
          ? html`${renderSteps(feedback)} ${renderFailureFooter(feedback)}`
          : html`
              <details class="login-gate__help">
                <summary class="login-gate__help-title">${t("connection.help.title")}</summary>
                <ol class="login-gate__steps">
                  <li>
                    ${t("connection.help.step1")}${renderConnectCommand("openclaw gateway run")}
                  </li>
                  <li>
                    ${t("connection.help.step2")} ${renderConnectCommand("openclaw dashboard")}
                  </li>
                  <li>${t("connection.help.step3")}</li>
                </ol>
                <div class="login-gate__docs">
                  <a
                    class="session-link"
                    href="https://docs.openclaw.ai/web/dashboard"
                    target=${EXTERNAL_LINK_TARGET}
                    rel=${buildExternalLinkRel()}
                    >${t("connection.help.docsLink")}</a
                  >
                </div>
              </details>
            `
      }
    </section>
  `;
}

function renderLoginGate(props: LoginGateProps, refreshAction: RefreshAction) {
  const resourceBasePath = normalizeBasePath(props.resourceBasePath);
  const faviconSrc = controlUiPublicAssetPath("favicon.svg", resourceBasePath);
  const feedback = resolveLoginFailureFeedback(props);
  const body =
    feedback?.placement === "status"
      ? renderStatusBody({ props, feedback, refreshAction })
      : renderFormBody({ props, feedback });

  return html`
    <div
      class="login-gate"
      @mousedown=${(event: MouseEvent) => {
        if (event.target === event.currentTarget) {
          beginNativeWindowDrag(event);
        }
      }}
    >
      <openclaw-toast-host></openclaw-toast-host>
      <div class="login-gate__card" data-mode=${feedback?.placement ?? "form"}>
        <header class="login-gate__brand">
          ${
            props.mascot === "none"
              ? html`<span class="login-gate__logo login-gate__logo--neutral" aria-hidden="true"
                  >${icons.mark}</span
                >`
              : html`<img class="login-gate__logo" src=${faviconSrc} alt="" />`
          }
          <span class="login-gate__brand-name">OpenClaw</span>
        </header>
        ${body}
        ${
          props.onOpenGatewaySettings
            ? html`<footer class="login-gate__recovery">
                <button type="button" class="btn btn--ghost" @click=${props.onOpenGatewaySettings}>
                  ${t("login.gatewaySettings")}
                </button>
              </footer>`
            : nothing
        }
      </div>
    </div>
  `;
}

class LoginGate extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) props?: LoginGateProps;
  @state() private refreshState: RefreshAction["state"] = "idle";
  private refreshAttempt?: { props: LoginGateProps };

  private ownsRefresh(attempt: { props: LoginGateProps }): boolean {
    const current = this.props;
    return (
      this.refreshAttempt === attempt &&
      this.isConnected &&
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
  }

  private cancelRefresh() {
    this.refreshAttempt = undefined;
    this.refreshState = "idle";
  }

  override willUpdate() {
    if (this.refreshAttempt && !this.ownsRefresh(this.refreshAttempt)) {
      this.cancelRefresh();
    }
  }

  override disconnectedCallback() {
    this.cancelRefresh();
    super.disconnectedCallback();
  }

  private async refreshPage() {
    const props = this.props;
    if (
      !props ||
      this.refreshAttempt ||
      this.refreshState === "pending" ||
      !this.isConnected ||
      props.connected ||
      props.reconnectPending ||
      !resolveLoginFailureFeedback(props)?.refreshAction ||
      !canReloadControlUiDocument(true)
    ) {
      return;
    }
    const attempt = { props };
    this.refreshAttempt = attempt;
    this.refreshState = "pending";
    try {
      const reloaded = await retryStaleChunkReloadWhenReachable({
        canReload: () => this.ownsRefresh(attempt),
      });
      if (this.ownsRefresh(attempt) && !reloaded) {
        this.refreshState = "failed";
      }
    } catch {
      // A rejected probe must not escape the click handler or strand its pending state.
      if (this.ownsRefresh(attempt)) {
        this.refreshState = "failed";
      }
    } finally {
      if (this.refreshAttempt === attempt) {
        if (!this.ownsRefresh(attempt)) {
          this.cancelRefresh();
        } else {
          this.refreshAttempt = undefined;
        }
      }
    }
  }

  override render() {
    const props = this.props;
    if (!props) {
      return nothing;
    }
    return renderLoginGate(
      {
        ...props,
        // Retire refresh before forwarding new intent, even if the host has not rendered yet.
        onConnect: () => {
          this.cancelRefresh();
          props.onConnect();
        },
        onGatewayUrlChange: (value) => {
          this.cancelRefresh();
          props.onGatewayUrlChange(value);
        },
        onSecretChange: (value) => {
          this.cancelRefresh();
          props.onSecretChange(value);
        },
      },
      { state: this.refreshState, onRefresh: () => void this.refreshPage() },
    );
  }
}

if (!customElements.get("openclaw-login-gate")) {
  customElements.define("openclaw-login-gate", LoginGate);
}
