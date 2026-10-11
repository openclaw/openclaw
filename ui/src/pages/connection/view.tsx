import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { Show, createMemo } from "solid-js";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayHelloOk } from "../../api/gateway.ts";
import type { ApplicationGatewayPhase } from "../../app/gateway.ts";
import type { UiSettings } from "../../app/settings.ts";
import type { GatewayStatusSample } from "../../components/gateway-vitals.ts";
import { GatewayVitals } from "../../components/solid/gateway-vitals.tsx";
import {
  SettingsPage,
  SettingsRow,
  SettingsSecretInput,
  SettingsSection,
  SettingsStatus,
} from "../../components/solid/settings-ui.tsx";
import type { SparklineSample } from "../../components/sparkline-tile.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatGatewayHost } from "../../lib/gateway-host.ts";
import { classifyGatewaySecret } from "../../lib/gateway-secret-shape.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import type { ConnectionPingSummary } from "./latency.ts";
import { SystemSection } from "./system-section.tsx";

registerEnglishCatalog(registerSettingsEnglish);

type GatewayAuthMode = "none" | "token" | "password" | "trusted-proxy";

export type ConnectionProps = {
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
  canForgetDevice: boolean;
  onForgetDevice: () => void;
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

function SecretRow(props: ConnectionProps & { authMode: GatewayAuthMode | undefined }) {
  const hintKey = () =>
    props.authMode === "password"
      ? "connection.access.passwordHint"
      : props.authMode === "token"
        ? "connection.access.tokenHint"
        : "connection.access.secretHint";
  return (
    <SettingsRow
      title={t("connection.access.secret")}
      description={t(hintKey())}
      stackedOnNarrow
      control={
        <div class="settings-input-with-hint">
          <SettingsSecretInput
            ariaLabel={t("connection.access.secret")}
            value={props.secret}
            placeholder={t("connection.access.secretPlaceholder")}
            visible={props.showGatewaySecret}
            showLabel={t("connection.access.showSecret")}
            hideLabel={t("connection.access.hideSecret")}
            toggleLabel={t("connection.access.toggleSecretVisibility")}
            onInput={(next) => props.onSecretChange(next)}
            onToggle={() => props.onToggleGatewaySecretVisibility()}
          />
          <Show when={classifyGatewaySecret(props.secret) === "setup-code"}>
            <p class="settings-row__desc" role="status">
              {t("connection.access.setupCodeHint")}
            </p>
          </Show>
        </div>
      }
    />
  );
}

function formatPing(value: number): string {
  return `${value.toFixed(1)} ${t("connection.ping.unit")}`;
}

function PingMetric(props: { name: string; value: number | undefined }) {
  return (
    <div title={t(`connection.ping.${props.name}Hint`)}>
      <dt>{t(`connection.ping.${props.name}`)}</dt>
      <dd>
        <Show when={props.value !== undefined} fallback="—">
          {props.value?.toFixed(1)} <span>{t("connection.ping.unit")}</span>
        </Show>
      </dd>
    </div>
  );
}

function Ping(props: ConnectionProps) {
  return (
    <div class="settings-row connection-ping">
      <dl class="connection-ping__stats" aria-label={t("connection.ping.title")}>
        <PingMetric name="average" value={props.ping?.averageMs} />
        <PingMetric name="p50" value={props.ping?.p50Ms} />
        <PingMetric name="p95" value={props.ping?.p95Ms} />
        <PingMetric name="p99" value={props.ping?.p99Ms} />
      </dl>
      <openclaw-sparkline
        class="gateway-vital connection-ping__trend"
        prop:label={t("connection.ping.latest")}
        prop:samples={props.pingSamples}
        prop:format={formatPing}
        prop:floorMax={100}
      />
      <p class="settings-row__desc">
        {props.ping
          ? t("connection.ping.samples", { count: String(props.ping.count) })
          : props.pingFailed
            ? undefined
            : t("connection.ping.measuring")}
        <Show when={props.pingFailed}>
          <span class="connection-ping__error" role="status">
            {t("connection.ping.failed")}
          </span>
        </Show>
      </p>
    </div>
  );
}

export function ConnectionView(props: ConnectionProps) {
  const connected = () => props.phase === "connected";
  const busy = () => ["connecting", "starting", "reconnecting"].includes(props.phase);
  const submitting = () => busy() && !props.dirty;
  const reloadRequired = () => props.phase === "reload-required";
  const authMode = () => {
    const mode = asOptionalRecord(props.hello?.snapshot)?.authMode;
    return mode === "none" || mode === "token" || mode === "password" || mode === "trusted-proxy"
      ? mode
      : undefined;
  };
  const draftAuthMode = createMemo(() =>
    gatewayCredentialScope(props.settings.gatewayUrl) ===
    gatewayCredentialScope(props.liveGatewayUrl)
      ? authMode()
      : undefined,
  );
  const statusKey = () =>
    connected() ? "connected" : props.phase === "stopped" ? "offline" : props.phase;
  const actionLabel = () =>
    submitting()
      ? t(
          props.phase === "reconnecting"
            ? "connection.access.status.reconnecting"
            : "connection.access.status.connecting",
        )
      : connected() || busy()
        ? t("connection.access.applyReconnect")
        : t(props.lastError ? "connection.access.retry" : "common.connect");
  const tick = () => formatTick(props.hello?.policy?.tickIntervalMs);

  return (
    <SettingsPage>
      <SettingsSection
        title={t("connection.access.title")}
        description={
          connected()
            ? t("connection.access.connectedTo", { host: formatGatewayHost(props.liveGatewayUrl) })
            : busy() || reloadRequired()
              ? t(`connection.access.status.${statusKey()}`)
              : t("connection.access.descriptionOffline")
        }
        actions={
          <SettingsStatus
            kind={connected() ? "ok" : "warn"}
            label={t(`connection.access.status.${statusKey()}`)}
          />
        }
      >
        <Show when={connected()}>
          <Ping {...props} />
        </Show>
        <SettingsRow
          title={t("connection.access.gatewayUrl")}
          description={t("connection.access.gatewayUrlHint")}
          control={
            <input
              class="settings-input"
              aria-label={t("connection.access.gatewayUrl")}
              inputmode="url"
              autocapitalize="none"
              autocorrect="off"
              autocomplete="off"
              spellcheck="false"
              value={props.settings.gatewayUrl}
              onInput={(event) =>
                props.onConnectionChange({ gatewayUrl: event.currentTarget.value })
              }
              placeholder="wss://gateway.example:443"
            />
          }
        />
        <Show
          when={draftAuthMode() === "trusted-proxy"}
          fallback={<SecretRow {...props} authMode={draftAuthMode()} />}
        >
          <SettingsRow
            title={t("connection.access.secret")}
            description={t("connection.access.trustedProxy")}
            control={<SettingsStatus kind="ok" label={t("connection.access.trustedProxyStatus")} />}
          />
        </Show>
        <Show when={!connected() && props.lastError}>
          <SettingsRow
            title={<SettingsStatus kind="danger" label={t("connection.access.lastError")} />}
            description={props.lastError}
          />
        </Show>
        <Show when={(!connected() || props.dirty) && !reloadRequired()}>
          <div class="settings-row connection-actions">
            <div class="settings-row__text">
              <span class="settings-row__desc" role="status">
                {props.dirty ? t("connection.access.unsavedHint") : undefined}
              </span>
            </div>
            <div class="settings-row__control connection-actions__buttons">
              <Show when={props.dirty}>
                <button class="btn" onClick={() => props.onDiscardConnection()}>
                  {t("connection.access.discard")}
                </button>
              </Show>
              <button class="btn primary" disabled={submitting()} onClick={() => props.onConnect()}>
                <Show when={submitting()}>
                  <span class="btn__spinner" aria-hidden="true" />
                </Show>
                {actionLabel()}
              </button>
            </div>
          </div>
        </Show>
        <details class="connection-details">
          <summary>{t("connection.access.details")}</summary>
          <div class="connection-details__body">
            <Show when={connected() && (authMode() || tick())}>
              <p class="settings-row__desc">
                {[
                  authMode() ? t(AUTH_MODE_KEYS[authMode()!]) : null,
                  tick() ? t("connection.access.tick", { tick: tick()! }) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </Show>
            <p class="settings-row__desc">{t("connection.access.reconnectHint")}</p>
            <button
              class="btn"
              disabled={!connected() || props.dirty}
              onClick={() => props.onReconnect()}
            >
              {t("connection.access.reconnect")}
            </button>
          </div>
        </details>
      </SettingsSection>
      <SettingsSection
        title={t("connection.activity.title")}
        description={t("connection.activity.description")}
      >
        <div class="settings-row connection-activity">
          <GatewayVitals
            status={props.statusHistory.at(-1)?.status ?? {}}
            history={props.statusHistory}
          />
          <Show
            when={props.statusFailed}
            fallback={
              <Show
                when={!connected()}
                fallback={
                  <Show when={props.statusHistory.length === 0}>
                    <p class="settings-row__desc" role="status">
                      {t("common.loading")}
                    </p>
                  </Show>
                }
              >
                <p class="settings-row__desc">{t("connection.activity.offline")}</p>
              </Show>
            }
          >
            <p class="settings-row__desc" role="status">
              {t("connection.activity.failed")}
            </p>
          </Show>
        </div>
      </SettingsSection>
      <SettingsSection
        title={t("connection.access.sessionTitle")}
        description={t("connection.access.sessionDescription", {
          host: formatGatewayHost(props.liveGatewayUrl),
        })}
      >
        <SettingsRow
          title={t("connection.access.sessionKey")}
          description={t("connection.access.sessionKeyHint")}
          control={
            <input
              class="settings-input"
              aria-label={t("connection.access.sessionKey")}
              value={props.settings.sessionKey}
              onInput={(event) => props.onSessionKeyChange(event.currentTarget.value)}
            />
          }
        />
        <Show
          when={props.sessionDirty}
          fallback={
            <Show when={props.sessionSaved}>
              <div class="settings-row" role="status">
                {t("connection.access.saved")}
              </div>
            </Show>
          }
        >
          <div class="settings-row">
            <div class="settings-row__text" />
            <div class="settings-row__control connection-actions__buttons">
              <button class="btn" onClick={() => props.onDiscardSession()}>
                {t("connection.access.discard")}
              </button>
              <button
                class="btn primary"
                disabled={!props.settings.sessionKey.trim()}
                onClick={() => props.onSaveSession()}
              >
                {t("common.save")}
              </button>
            </div>
          </div>
        </Show>
      </SettingsSection>
      <SystemSection
        systemInfo={props.systemInfo}
        systemInfoUnavailable={props.systemInfoUnavailable}
        systemInfoLoading={props.systemInfoLoading}
      />
      <Show when={props.canForgetDevice}>
        <SettingsSection title={t("connection.browser.title")}>
          <SettingsRow
            title={t("connection.browser.savedSignIn")}
            control={
              <button class="btn" onClick={() => props.onForgetDevice()}>
                {t("connection.browser.forgetDevice")}
              </button>
            }
          />
        </SettingsSection>
      </Show>
    </SettingsPage>
  );
}
