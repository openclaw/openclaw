// Control UI view renders the gateway connection settings content.
import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { html, nothing } from "lit";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayHelloOk } from "../../api/gateway.ts";
import type { ApplicationGatewayPhase } from "../../app/gateway.ts";
import type { UiSettings } from "../../app/settings.ts";
import { renderGatewayVitals, type GatewayStatusSample } from "../../components/gateway-vitals.ts";
import {
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSecretInput,
  renderSettingsSection,
  renderSettingsStatus,
} from "../../components/settings-ui.ts";
import type { SparklineSample } from "../../components/sparkline-tile.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatGatewayHost } from "../../lib/gateway-host.ts";
import { classifyGatewaySecret } from "../../lib/gateway-secret-shape.ts";
import type { ConnectionPingSummary } from "./latency.ts";
import { renderSystemSection } from "./system-section.ts";

registerSettingsEnglish();

type GatewayAuthMode = "none" | "token" | "password" | "trusted-proxy";

type ConnectionProps = {
  phase: ApplicationGatewayPhase;
  hello: GatewayHelloOk | null;
  settings: UiSettings;
  /** URL of the live connection; the draft in `settings` may differ until Connect. */
  liveGatewayUrl: string;
  secret: string;
  lastError: string | null;
  systemInfo: SystemInfoResult | null;
  systemInfoUnavailable: boolean;
  systemInfoLoading: boolean;
  ping: ConnectionPingSummary | null;
  pingFailed: boolean;
  pingSamples: readonly SparklineSample[];
  statusHistory: readonly GatewayStatusSample[];
  statusFailed: boolean;
  /** True when the draft differs from the live connection. */
  dirty: boolean;
  sessionDirty: boolean;
  sessionSaved: boolean;
  showGatewaySecret: boolean;
  onConnectionChange: (patch: Partial<Pick<UiSettings, "gatewayUrl" | "token">>) => void;
  onSecretChange: (next: string) => void;
  onSessionKeyChange: (next: string) => void;
  onToggleGatewaySecretVisibility: () => void;
  onConnect: () => void;
  onDiscardConnection: () => void;
  onReconnect: () => void;
  onSaveSession: () => void;
  onDiscardSession: () => void;
};

const AUTH_MODE_KEYS: Record<GatewayAuthMode, string> = {
  none: "connection.access.auth.none",
  token: "connection.access.auth.token",
  password: "connection.access.auth.password",
  "trusted-proxy": "connection.access.auth.trustedProxy",
};

function formatTick(tickIntervalMs: number | undefined): string | null {
  if (!tickIntervalMs) {
    return null;
  }
  const seconds = tickIntervalMs / 1000;
  return `${seconds.toFixed(tickIntervalMs % 1000 === 0 ? 0 : 1)}s`;
}

function renderSecretRow(props: ConnectionProps, authMode: GatewayAuthMode | undefined) {
  const hintKey =
    authMode === "password"
      ? "connection.access.passwordHint"
      : authMode === "token"
        ? "connection.access.tokenHint"
        : "connection.access.secretHint";
  return renderSettingsRow({
    title: t("connection.access.secret"),
    description: t(hintKey),
    control: html`<div class="settings-input-with-hint">
      ${renderSettingsSecretInput({
        ariaLabel: t("connection.access.secret"),
        value: props.secret,
        placeholder: t("connection.access.secretPlaceholder"),
        visible: props.showGatewaySecret,
        showLabel: t("connection.access.showSecret"),
        hideLabel: t("connection.access.hideSecret"),
        toggleLabel: t("connection.access.toggleSecretVisibility"),
        onInput: props.onSecretChange,
        onToggle: props.onToggleGatewaySecretVisibility,
      })}
      ${
        classifyGatewaySecret(props.secret) === "setup-code"
          ? html`<p class="settings-row__desc" role="status">
              ${t("connection.access.setupCodeHint")}
            </p>`
          : nothing
      }
    </div>`,
    stackedOnNarrow: true,
  });
}

function formatPing(value: number): string {
  return `${value.toFixed(1)} ${t("connection.ping.unit")}`;
}

function renderPing(props: ConnectionProps) {
  const metrics = [
    { key: "average", value: props.ping?.averageMs },
    { key: "p50", value: props.ping?.p50Ms },
    { key: "p95", value: props.ping?.p95Ms },
    { key: "p99", value: props.ping?.p99Ms },
  ];
  return html`<div class="settings-row connection-ping">
    <dl class="connection-ping__stats" aria-label=${t("connection.ping.title")}>
      ${metrics.map(
        ({ key, value }) => html`<div title=${t(`connection.ping.${key}Hint`)}>
          <dt>${t(`connection.ping.${key}`)}</dt>
          <dd>
            ${
              value === undefined
                ? "—"
                : html`${value.toFixed(1)} <span>${t("connection.ping.unit")}</span>`
            }
          </dd>
        </div>`,
      )}
    </dl>
    <openclaw-sparkline
      class="gateway-vital connection-ping__trend"
      .label=${t("connection.ping.latest")}
      .samples=${props.pingSamples}
      .format=${formatPing}
      .floorMax=${100}
    ></openclaw-sparkline>
    <p class="settings-row__desc">
      ${
        props.ping
          ? t("connection.ping.samples", { count: String(props.ping.count) })
          : props.pingFailed
            ? nothing
            : t("connection.ping.measuring")
      }
      ${
        props.pingFailed
          ? html`<span class="connection-ping__error" role="status">
              ${t("connection.ping.failed")}
            </span>`
          : nothing
      }
    </p>
  </div>`;
}

export function renderConnection(props: ConnectionProps) {
  const snapshot = props.hello?.snapshot as { authMode?: GatewayAuthMode } | undefined;
  const connected = props.phase === "connected";
  const busy = ["connecting", "starting", "reconnecting"].includes(props.phase);
  const submitting = busy && !props.dirty;
  const reloadRequired = props.phase === "reload-required";
  const authMode = snapshot?.authMode;
  const draftAuthMode =
    gatewayCredentialScope(props.settings.gatewayUrl) ===
    gatewayCredentialScope(props.liveGatewayUrl)
      ? authMode
      : undefined;
  const isTrustedProxy = draftAuthMode === "trusted-proxy";
  const statusKey = connected ? "connected" : props.phase === "stopped" ? "offline" : props.phase;
  const actionLabel = submitting
    ? t(
        props.phase === "reconnecting"
          ? "connection.access.status.reconnecting"
          : "connection.access.status.connecting",
      )
    : connected || busy
      ? t("connection.access.applyReconnect")
      : t(props.lastError ? "connection.access.retry" : "common.connect");
  const tick = formatTick(props.hello?.policy?.tickIntervalMs);

  const rows = html`
    ${connected ? renderPing(props) : nothing}
    ${renderSettingsRow({
      title: t("connection.access.gatewayUrl"),
      description: t("connection.access.gatewayUrlHint"),
      control: html`
        <input
          class="settings-input"
          aria-label=${t("connection.access.gatewayUrl")}
          inputmode="url"
          autocapitalize="none"
          autocorrect="off"
          autocomplete="off"
          spellcheck="false"
          .value=${props.settings.gatewayUrl}
          @input=${(e: Event) => {
            props.onConnectionChange({ gatewayUrl: (e.target as HTMLInputElement).value });
          }}
          placeholder="wss://gateway.example:443"
        />
      `,
    })}
    ${
      isTrustedProxy
        ? renderSettingsRow({
            title: t("connection.access.secret"),
            description: t("connection.access.trustedProxy"),
            control: renderSettingsStatus({
              kind: "ok",
              label: t("connection.access.trustedProxyStatus"),
            }),
          })
        : renderSecretRow(props, draftAuthMode)
    }
    ${
      !connected && props.lastError
        ? renderSettingsRow({
            title: renderSettingsStatus({
              kind: "danger",
              label: t("connection.access.lastError"),
            }),
            description: props.lastError,
          })
        : nothing
    }
    ${
      (!connected || props.dirty) && !reloadRequired
        ? html`<div class="settings-row connection-actions">
            <div class="settings-row__text">
              <span class="settings-row__desc" role="status">
                ${props.dirty ? t("connection.access.unsavedHint") : nothing}
              </span>
            </div>
            <div class="settings-row__control connection-actions__buttons">
              ${
                props.dirty
                  ? html`<button class="btn" @click=${props.onDiscardConnection}>
                      ${t("connection.access.discard")}
                    </button>`
                  : nothing
              }
              <button class="btn primary" ?disabled=${submitting} @click=${props.onConnect}>
                ${submitting ? html`<span class="btn__spinner" aria-hidden="true"></span>` : nothing}
                ${actionLabel}
              </button>
            </div>
          </div>`
        : nothing
    }
    <details class="connection-details">
      <summary>${t("connection.access.details")}</summary>
      <div class="connection-details__body">
        ${
          connected && (authMode || tick)
            ? html`<p class="settings-row__desc">
                ${[authMode ? t(AUTH_MODE_KEYS[authMode]) : null, tick ? t("connection.access.tick", { tick }) : null].filter(Boolean).join(" · ")}
              </p>`
            : nothing
        }
        <p class="settings-row__desc">${t("connection.access.reconnectHint")}</p>
        <button class="btn" ?disabled=${!connected || props.dirty} @click=${props.onReconnect}>
          ${t("connection.access.reconnect")}
        </button>
      </div>
    </details>
  `;

  return renderSettingsPage([
    renderSettingsSection(
      {
        title: t("connection.access.title"),
        description: connected
          ? t("connection.access.connectedTo", { host: formatGatewayHost(props.liveGatewayUrl) })
          : busy || reloadRequired
            ? t(`connection.access.status.${statusKey}`)
            : t("connection.access.descriptionOffline"),
        actions: renderSettingsStatus({
          kind: connected ? "ok" : "warn",
          label: t(`connection.access.status.${statusKey}`),
        }),
      },
      rows,
    ),
    renderSettingsSection(
      {
        title: t("connection.activity.title"),
        description: t("connection.activity.description"),
      },
      html`<div class="settings-row connection-activity">
        ${renderGatewayVitals(props.statusHistory.at(-1)?.status ?? {}, props.statusHistory)}
        ${
          props.statusFailed
            ? html`<p class="settings-row__desc" role="status">
                ${t("connection.activity.failed")}
              </p>`
            : !connected
              ? html`<p class="settings-row__desc">${t("connection.activity.offline")}</p>`
              : props.statusHistory.length === 0
                ? html`<p class="settings-row__desc" role="status">${t("common.loading")}</p>`
                : nothing
        }
      </div>`,
    ),
    renderSettingsSection(
      {
        title: t("connection.access.sessionTitle"),
        description: t("connection.access.sessionDescription", {
          host: formatGatewayHost(props.liveGatewayUrl),
        }),
      },
      html`
        ${renderSettingsRow({
          title: t("connection.access.sessionKey"),
          description: t("connection.access.sessionKeyHint"),
          control: html`
            <input
              class="settings-input"
              aria-label=${t("connection.access.sessionKey")}
              .value=${props.settings.sessionKey}
              @input=${(e: Event) => props.onSessionKeyChange((e.target as HTMLInputElement).value)}
            />
          `,
        })}
        ${
          props.sessionDirty
            ? html`<div class="settings-row">
                <div class="settings-row__text"></div>
                <div class="settings-row__control connection-actions__buttons">
                  <button class="btn" @click=${props.onDiscardSession}>
                    ${t("connection.access.discard")}
                  </button>
                  <button
                    class="btn primary"
                    ?disabled=${!props.settings.sessionKey.trim()}
                    @click=${props.onSaveSession}
                  >
                    ${t("common.save")}
                  </button>
                </div>
              </div>`
            : props.sessionSaved
              ? html`<div class="settings-row" role="status">${t("connection.access.saved")}</div>`
              : nothing
        }
      `,
    ),
    renderSystemSection(props),
  ]);
}
