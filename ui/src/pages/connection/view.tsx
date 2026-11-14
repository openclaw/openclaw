import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import type { JSX } from "@solidjs/web";
import {
  Errored,
  For,
  Loading,
  Show,
  createMemo,
  isPending,
  latest,
  type Accessor,
} from "solid-js";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayHelloOk } from "../../api/gateway.ts";
import { isRemoteControlUiIngress } from "../../app/remote-ingress.ts";
import type { GatewayStatusSnapshot } from "../../components/gateway-vitals.ts";
import {
  GatewayCpuVital,
  GatewayDelayVital,
  GatewayMemoryVital,
} from "../../components/solid/gateway-vitals.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import {
  SettingsPage,
  SettingsRow,
  SettingsSecretInput,
  SettingsSection,
  SettingsStatus,
} from "../../components/solid/settings-ui.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatBytes } from "../../lib/agents/display.ts";
import { formatDurationHuman } from "../../lib/format-duration.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { formatGatewayHost } from "../../lib/gateway-host.ts";
import { classifyGatewaySecret } from "../../lib/gateway-secret-shape.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { CONNECTION_SETTINGS_TARGET_IDS } from "../config/settings-targets.ts";
import type { ConnectionDraft } from "./connection-draft.ts";

registerEnglishCatalog(registerSettingsEnglish);

type GatewayAuthMode = NonNullable<NonNullable<GatewayHelloOk["snapshot"]>["authMode"]>;

export type ConnectionProps = ReturnType<ConnectionDraft["viewProps"]> & {
  systemInfoReady: Accessor<boolean | null>;
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
    <div class="connection-metric connection-ping">
      <openclaw-sparkline
        class="gateway-vital connection-ping__trend"
        prop:label={t("connection.ping.latest")}
        prop:samples={props.pingSamples}
        prop:format={formatPing}
        prop:floorMax={100}
      />
      <dl class="connection-ping__stats" aria-label={t("connection.ping.title")}>
        <PingMetric name="average" value={props.ping?.averageMs} />
        <PingMetric name="p50" value={props.ping?.p50Ms} />
        <PingMetric name="p95" value={props.ping?.p95Ms} />
        <PingMetric name="p99" value={props.ping?.p99Ms} />
      </dl>
      <Show when={props.pingFailed}>
        <p class="connection-ping__error" role="status">
          {t("connection.ping.failed")}
        </p>
      </Show>
    </div>
  );
}

/** Facts on one line; a separator belongs to the fact after it and is clipped at a line start. */
function Facts(props: { children: JSX.Element }) {
  return (
    <span class="connection-facts">
      <span class="connection-facts__items">{props.children}</span>
    </span>
  );
}

function ActivitySection(props: ConnectionProps) {
  const connected = () => props.phase === "connected";
  const status = () => props.statusHistory.at(-1)?.status ?? {};
  // Rows hold their place until the first read answers; a metric the Gateway never reports has no row.
  const reported = (read: (sample: GatewayStatusSnapshot) => number | undefined) =>
    (props.statusHistory.length === 0 && !props.statusFailed) ||
    props.statusHistory.some((sample) => read(sample.status) !== undefined);
  const systemInfoFeedback = () => {
    if (latest(props.systemInfoReady)) {
      throw new Error(t("connection.activity.failed"));
    }
    return null;
  };
  return (
    <SettingsSection title={t("connection.activity.title")}>
      <div class="connection-activity">
        <Show when={connected()}>
          <Ping {...props} />
          <Show when={reported((sample) => sample.eventLoop?.cpuCoreRatio)}>
            <GatewayCpuVital status={status()} history={props.statusHistory} />
          </Show>
          <Show when={reported((sample) => sample.processMemory?.rssBytes)}>
            <GatewayMemoryVital status={status()} history={props.statusHistory} />
          </Show>
          <Show when={reported((sample) => sample.eventLoop?.delayP99Ms)}>
            <GatewayDelayVital status={status()} history={props.statusHistory} />
          </Show>
        </Show>
        <Errored
          fallback={(error) => (
            <p class="settings-row__desc connection-activity__note" role="status">
              {formatUiError(error())}
            </p>
          )}
        >
          <Loading>{systemInfoFeedback()}</Loading>
        </Errored>
        <Show when={!connected() && !props.statusFailed}>
          <p class="settings-row__desc connection-activity__note">
            {t("connection.activity.offline")}
          </p>
        </Show>
      </div>
    </SettingsSection>
  );
}

function ConnectionActions(props: ConnectionProps & { connected: boolean }) {
  const busy = () => ["connecting", "starting", "reconnecting"].includes(props.phase);
  const submitting = () => busy() && !props.dirty;
  const reloadRequired = () => props.phase === "reload-required";
  // Connected and clean, or waiting for a reload: the slot holds the plain Reconnect.
  const quiet = () => reloadRequired() || (props.connected && !props.dirty);
  const label = () =>
    quiet()
      ? t("connection.access.reconnect")
      : submitting()
        ? t(
            props.phase === "reconnecting"
              ? "connection.access.status.reconnecting"
              : "connection.access.status.connecting",
          )
        : props.connected || busy()
          ? t("connection.access.applyReconnect")
          : t(props.lastError ? "connection.access.retry" : "common.connect");
  return (
    <div class="settings-row connection-actions">
      <div class="settings-row__text">
        <span class="settings-row__desc" role="status">
          {props.dirty && !reloadRequired() ? t("connection.access.unsavedHint") : undefined}
        </span>
        <Show when={!props.dirty || reloadRequired()}>
          <span class="settings-row__desc">{t("connection.access.reconnectHint")}</span>
        </Show>
      </div>
      <div class="settings-row__control connection-actions__buttons">
        <Show when={props.dirty && !reloadRequired()}>
          <button class="btn" onClick={() => props.onDiscardConnection()}>
            {t("connection.access.discard")}
          </button>
        </Show>
        <button
          class={["btn", { primary: !quiet() && !submitting() }]}
          disabled={submitting() || reloadRequired()}
          onClick={() => (quiet() ? props.onReconnect() : props.onConnect())}
        >
          <Show when={submitting()}>
            <span class="btn__spinner" aria-hidden="true" />
          </Show>
          {label()}
        </button>
      </div>
    </div>
  );
}

function BrowserSection(props: ConnectionProps) {
  const saved = () => props.sessionSaved && !props.sessionDirty;
  return (
    <SettingsSection title={t("connection.browser.title")}>
      <SettingsRow
        title={t("connection.access.sessionKey")}
        description={t("connection.access.sessionKeyHint")}
        control={
          <div class="connection-session-field">
            <input
              class="settings-input"
              aria-label={t("connection.access.sessionKey")}
              value={props.settings.sessionKey}
              onInput={(event) => props.onSessionKeyChange(event.currentTarget.value)}
            />
            <div class="connection-session-field__actions">
              <span class="settings-row__desc" role="status">
                {saved() ? t("connection.access.saved") : undefined}
              </span>
              <Show when={props.sessionDirty}>
                <button
                  class="btn connection-session-field__discard"
                  aria-label={t("connection.access.discard")}
                  title={t("connection.access.discard")}
                  onClick={() => props.onDiscardSession()}
                >
                  <Icon name="x" />
                  <span>{t("connection.access.discard")}</span>
                </button>
                <button
                  class="btn primary"
                  disabled={!props.settings.sessionKey.trim()}
                  onClick={() => props.onSaveSession()}
                >
                  {t("common.save")}
                </button>
              </Show>
            </div>
          </div>
        }
      />
      <Show when={props.canForgetDevice}>
        <div class="settings-row connection-forget">
          <div class="settings-row__text">
            <span class="settings-row__title">{t("connection.browser.savedSignIn")}</span>
          </div>
          <div class="settings-row__control">
            <button class="btn" onClick={() => props.onForgetDevice()}>
              {t("connection.browser.forgetDevice")}
            </button>
          </div>
        </div>
      </Show>
    </SettingsSection>
  );
}

export function ConnectionView(props: ConnectionProps) {
  const remoteIngress = isRemoteControlUiIngress();
  const connected = () => props.phase === "connected";
  const busy = () => ["connecting", "starting", "reconnecting"].includes(props.phase);
  const authMode = () => props.hello?.snapshot?.authMode;
  const draftAuthMode = createMemo(() =>
    gatewayCredentialScope(props.settings.gatewayUrl) ===
    gatewayCredentialScope(props.liveGatewayUrl)
      ? authMode()
      : undefined,
  );
  const statusKey = () =>
    connected() ? "connected" : props.phase === "stopped" ? "offline" : props.phase;
  const statusKind = () => (connected() ? "ok" : props.lastError && !busy() ? "danger" : "warn");
  const statusFacts = () => {
    const tick = connected() ? formatTick(props.hello?.policy?.tickIntervalMs) : null;
    return [
      formatGatewayHost(props.liveGatewayUrl),
      connected() && authMode() ? t(AUTH_MODE_KEYS[authMode()!]) : null,
      tick ? t("connection.access.tick", { tick }) : null,
    ].filter((fact) => fact !== null);
  };

  return (
    <SettingsPage>
      <SettingsSection title={t("connection.access.title")}>
        <SettingsRow
          role="status"
          title={
            <SettingsStatus
              kind={statusKind()}
              label={t(`connection.access.status.${statusKey()}`)}
            />
          }
          description={
            <Show when={connected() || !props.lastError} fallback={props.lastError}>
              <Facts>
                <For each={statusFacts()}>{(fact) => <span>{fact}</span>}</For>
              </Facts>
            </Show>
          }
        />
        <Show when={!remoteIngress}>
          <SettingsRow
            title={t("connection.access.gatewayUrl")}
            description={t("connection.access.gatewayUrlHint")}
            control={
              <input
                class="settings-input"
                aria-label={t("connection.access.gatewayUrl")}
                title={props.settings.gatewayUrl}
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
              control={
                <SettingsStatus kind="ok" label={t("connection.access.trustedProxyStatus")} />
              }
            />
          </Show>
        </Show>
        <ConnectionActions {...props} connected={connected()} />
      </SettingsSection>
      <BrowserSection {...props} />
      <ActivitySection {...props} />
      <Loading fallback={<SystemSection {...props} pending />}>
        <SystemSection {...props} pending={isPending(props.systemInfoReady)} />
      </Loading>
    </SettingsPage>
  );
}

type SystemStat = {
  label: string;
  value: string;
  unit?: string;
  detail?: string;
  /** Used share of the resource (0..1); renders the meter bar when present. */
  usedFraction?: number;
  path?: string;
  title?: string;
};

function SystemMeter(props: { label: string; fraction: number }) {
  const clamped = () => Math.min(Math.max(props.fraction, 0), 1);
  const percent = () => Math.round(clamped() * 100);
  // Meter tones reuse the status palette: calm until 75%, warn to 92%, critical beyond.
  const tone = () => (clamped() >= 0.92 ? "critical" : clamped() >= 0.75 ? "warn" : "ok");
  return (
    <div
      class="config-host__meter"
      role="meter"
      aria-label={t("quickSettings.system.usage", { label: props.label })}
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={percent()}
    >
      <div
        class={["config-host__meter-fill", `config-host__meter-fill--${tone()}`]}
        style={{ "--config-host-meter-fill": `${percent()}%` }}
      />
    </div>
  );
}

function SystemStatView(props: { stat: SystemStat }) {
  const label = () =>
    props.stat.path ? `${props.stat.label} ${props.stat.path}` : props.stat.label;
  return (
    <div class="connection-metric config-host__stat" title={props.stat.title}>
      <div class="config-host__stat-label">
        {props.stat.label}
        <Show when={props.stat.path}>
          {" "}
          <span class="config-host__stat-path">{props.stat.path}</span>
        </Show>
      </div>
      <div class="config-host__stat-value">
        {props.stat.value}
        <Show when={props.stat.unit}>
          {" "}
          <span class="config-host__stat-unit">{props.stat.unit}</span>
        </Show>
      </div>
      <Show when={props.stat.usedFraction != null}>
        <SystemMeter label={label()} fraction={props.stat.usedFraction!} />
      </Show>
      <Show when={props.stat.detail}>
        <div class="config-host__stat-detail">{props.stat.detail}</div>
      </Show>
    </div>
  );
}

function Placeholder() {
  return <span class="skeleton config-host__placeholder" aria-hidden="true" />;
}

function resourceStat(
  kind: "memory" | "disk",
  totalBytes: number | undefined,
  freeBytes: number | undefined,
  path?: string,
): SystemStat {
  const used =
    totalBytes == null || freeBytes == null || totalBytes <= 0
      ? undefined
      : (totalBytes - freeBytes) / totalBytes;
  return {
    label: t(`quickSettings.system.${kind}`),
    value: used == null ? "—" : `${Math.round(Math.min(Math.max(used, 0), 1) * 100)}%`,
    unit: used == null ? undefined : t("quickSettings.system.used"),
    detail: t("quickSettings.system.freeOf", {
      free: formatBytes(freeBytes),
      total: formatBytes(totalBytes),
    }),
    usedFraction: used,
    path,
  };
}

function buildSystemStats(info: SystemInfoResult): SystemStat[] {
  const load = info.loadAverage?.[0];
  const loadTitle = info.loadAverage
    ? t("quickSettings.system.loadAverage", {
        values: info.loadAverage.map((value) => value.toFixed(1)).join(" · "),
      })
    : undefined;
  const cpuTitle = [info.cpuModel, loadTitle].filter(Boolean).join(" · ") || undefined;
  const coresLabel = t(
    info.cpuCount === 1 ? "quickSettings.system.core" : "quickSettings.system.cores",
    { count: String(info.cpuCount) },
  );
  const cpu: SystemStat =
    load == null
      ? {
          label: t("quickSettings.system.cpu"),
          value: coresLabel,
          detail: info.cpuModel,
        }
      : {
          label: t("quickSettings.system.cpu"),
          value: load.toFixed(1),
          unit: t("quickSettings.system.load"),
          detail: coresLabel,
          // 1-minute load over core count approximates saturation; >100% clamps full.
          usedFraction: info.cpuCount > 0 ? load / info.cpuCount : undefined,
          title: cpuTitle,
        };
  const stats = [cpu, resourceStat("memory", info.memoryTotalBytes, info.memoryFreeBytes)];
  for (const disk of info.disks ?? []) {
    const stat = resourceStat("disk", disk.totalBytes, disk.availableBytes, disk.path);
    if (stat.usedFraction != null) {
      stats.push(stat);
    }
  }
  return stats;
}

/** Gateway host section with the stable settings-search scroll target id. */
function SystemSection(props: ConnectionProps & { pending: boolean }) {
  const info = () => props.systemInfo;
  const hostTitle = () =>
    info() && info()!.hostname !== info()!.machineName ? info()!.hostname : undefined;
  const address = () =>
    info()?.lanAddress
      ? `${info()!.lanAddress}${info()!.port == null ? "" : `:${info()!.port}`}`
      : undefined;
  const stats = createMemo(() => (info() ? buildSystemStats(info()!) : []));

  // Nothing to show offline: the Activity section already says to connect.
  return (
    <Show when={!props.systemInfoUnavailable}>
      <div id={CONNECTION_SETTINGS_TARGET_IDS.host} aria-busy={props.pending ? "true" : "false"}>
        <Show when={info() || props.pending}>
          <SettingsSection title={t("quickSettings.system.gatewayHost")}>
            <SettingsRow
              title={
                <span class="config-host__name" title={hostTitle() ?? ""}>
                  <Show when={info()} fallback={<Placeholder />}>
                    {info()?.machineName}
                  </Show>
                </span>
              }
              description={
                <Show when={info()} fallback={<Placeholder />}>
                  <Facts>
                    <span class="config-host__meta">{`${info()?.osLabel} · ${info()?.arch}`}</span>
                    <span class="config-host__meta">
                      {t("quickSettings.system.runtime", {
                        version: info()?.nodeVersion ?? "",
                        pid: String(info()?.pid),
                      })}
                    </span>
                    <Show when={address()}>
                      <span class="config-host__address">{address()}</span>
                    </Show>
                  </Facts>
                </Show>
              }
              control={
                <Show when={info()}>
                  <SettingsStatus
                    kind="ok"
                    label={t("quickSettings.system.up", {
                      duration: formatDurationHuman(info()!.uptimeMs),
                    })}
                  />
                </Show>
              }
            />
            <Show
              when={info()}
              fallback={
                <For each={["cpu", "memory", "disk"]}>
                  {(kind) => (
                    <div class="connection-metric config-host__stat">
                      <div class="config-host__stat-label">{t(`quickSettings.system.${kind}`)}</div>
                      <div class="config-host__stat-value">
                        <Placeholder />
                      </div>
                    </div>
                  )}
                </For>
              }
            >
              <For each={stats()} keyed={(stat) => `${stat.label}:${stat.path ?? ""}`}>
                {(stat) => <SystemStatView stat={stat()} />}
              </For>
            </Show>
          </SettingsSection>
        </Show>
      </div>
    </Show>
  );
}
