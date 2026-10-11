import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { For, Show, createEffect, createMemo, onSettled } from "solid-js";
import { DESKTOP_PANEL_TOGGLE_EVENT } from "../../components/panel-toggle-contract.ts";
import "../../components/sparkline-tile.ts";
import { Icon } from "../../components/solid/icon.tsx";
import "../../components/desktop/desktop-panel.ts";
import type { SparklineSample } from "../../components/sparkline-tile.ts";
import { registerSystemsEnglish } from "../../i18n/locales/en-systems.ts";
import { formatByteSize, formatTimeAgo } from "../../lib/format.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import {
  resolveSessionPreferredFace,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lit/solid-bridge.ts";
import { SystemsBackups } from "./systems-backups.tsx";
import type { SystemsController, SystemsRouteData } from "./systems-controller.ts";
import type { SystemsInventoryRow } from "./systems-data.ts";
import { systemKind, systemName, systemPlatform, systemStatus } from "./systems-sidebar.tsx";
import {
  SYSTEMS_GATEWAY_STALE_MS,
  SYSTEMS_NODE_STALE_MS,
  systemMeasurements,
  type HostMeasurements,
  type SystemsTelemetrySample,
} from "./systems-telemetry.ts";
import "../../styles/systems.css";

registerEnglishCatalog(registerSystemsEnglish);

function bytes(value: number): string {
  return formatByteSize(value, {
    style: "legacy-binary",
    separator: " ",
    maxUnit: "tera",
    fractionDigits: (size, unit) => (unit === "tera" || size < 10 ? 1 : 0),
  });
}

function metricSamples(
  history: readonly SystemsTelemetrySample[],
  read: (stats: HostMeasurements) => number | undefined,
): SparklineSample[] {
  const samples: SparklineSample[] = [];
  for (const { at, stats } of history) {
    const value = read(stats);
    if (value === undefined || !Number.isFinite(value)) {
      samples.length = 0;
    } else {
      samples.push({ at, value });
    }
  }
  return samples;
}

function SystemMeasurements(props: { row: SystemsInventoryRow; controller: SystemsController }) {
  const row = () => props.row;
  const controller = () => props.controller;
  const stats = () => systemMeasurements(row());

  const observedAt = () => row().node?.hostStats?.updatedAtMs ?? controller().sampledAtMs;
  const gatewayHost = () => row()!.environment.id === "gateway";
  const lastKnown = () =>
    !controller().connected ||
    row()!.environment.status !== "available" ||
    Boolean(controller().inventory?.errors[gatewayHost() ? "systemInfo" : "nodes"]) ||
    (observedAt() !== null &&
      Date.now() - observedAt()! >
        (gatewayHost() ? SYSTEMS_GATEWAY_STALE_MS : SYSTEMS_NODE_STALE_MS));
  const retained = () => controller().telemetryHistory(row()!.environment.id);
  const history = () =>
    retained().length ? retained() : [{ at: observedAt() ?? 0, stats: stats()! }];
  const hasMultipleDisks = () => {
    const disks = stats()?.disks;
    return disks !== undefined && disks.length !== 1;
  };
  const Disk = (diskProps: { path?: string; totalBytes?: number }) => (
    <openclaw-sparkline
      class="gateway-vital systems-vital systems-vital--disk"
      title={diskProps.path}
      prop:label={diskProps.path ? `${t("systems.disk")} ${diskProps.path}` : t("systems.disk")}
      prop:sub={diskProps.totalBytes === undefined ? "" : `/ ${bytes(diskProps.totalBytes!)}`}
      prop:samples={metricSamples(history(), (sample) =>
        diskProps.path === undefined
          ? sample.disks === undefined
            ? sample.diskAvailableBytes
            : undefined
          : sample.disks?.find((disk) => disk.path === diskProps.path)?.availableBytes,
      )}
      prop:format={bytes}
      prop:autorange={true}
    />
  );
  return (
    <Show when={stats()} fallback={<p class="systems-no-telemetry">{t("systems.noTelemetry")}</p>}>
      <Show when={row().environment.id} keyed>
        {(_environmentId) => (
          <div class="systems-metrics" data-stale={String(lastKnown())}>
            <div class={["systems-vitals", { "systems-vitals--volumes": hasMultipleDisks() }]}>
              <openclaw-sparkline
                class="gateway-vital systems-vital systems-vital--load"
                prop:label={t("systems.load")}
                prop:sub={t("systems.cpuCount", { count: String(stats()!.cpuCount) })}
                prop:samples={metricSamples(history(), (sample) => sample.loadAverage?.[0])}
                prop:format={(value: number) => value.toFixed(2)}
                prop:floorMax={stats()!.cpuCount}
              />
              <openclaw-sparkline
                class="gateway-vital systems-vital systems-vital--memory"
                prop:label={t("systems.memory")}
                prop:sub={`/ ${bytes(stats()!.memoryTotalBytes)}`}
                prop:samples={metricSamples(
                  history(),
                  (sample) => sample.memoryTotalBytes - sample.memoryFreeBytes,
                )}
                prop:format={bytes}
                prop:floorMax={stats()!.memoryTotalBytes}
              />
              {stats()!.disks === undefined ? (
                <Disk totalBytes={stats()!.diskTotalBytes} />
              ) : (
                <For each={stats()!.disks!} keyed={(disk) => disk.path}>
                  {(disk) => <Disk path={disk().path} totalBytes={disk().totalBytes} />}
                </For>
              )}
            </div>
            <div class="systems-metrics-caption">
              {!lastKnown() && history().length < 2 ? (
                <span>{t("systems.collectingHistory")}</span>
              ) : null}
              {observedAt() === null ? null : (
                <span class="systems-sample-time">
                  {t(lastKnown() ? "systems.lastKnown" : "systems.sampled", {
                    time: formatTimeAgo(Math.max(0, Date.now() - observedAt()!)),
                  })}
                </span>
              )}
            </div>
          </div>
        )}
      </Show>
    </Show>
  );
}

export type SystemsPageProps = { routeData?: SystemsRouteData; presented: boolean };
type SystemsPageElement = SolidBridgeElement<SystemsPageProps>;

function SystemsPageContent(props: SystemsPageProps, host: SystemsPageElement) {
  const projection = createMemo(() => {
    const controller = props.routeData?.controller;
    return controller
      ? projectSource(controller, {
          read: (value) => value,
          subscribe: (value, notify) => value.subscribe(notify),
          equality: "revision",
        })
      : null;
  });
  const controller = () => projection()?.read();
  createEffect(
    () => ({ controller: props.routeData?.controller, presented: props.presented }),
    ({ controller: active, presented }) => {
      active?.setPresented(presented);
      return () => active?.setPresented(false);
    },
  );
  onSettled(() => {
    const tick = () => {
      const active = controller();
      if (!props.presented || !active) {
        return;
      }
      if (active.needsInventoryRefresh) {
        void active.refresh();
      } else if (active.showStats || active.showDetails) {
        void active.refreshTelemetry();
      }
      if ((!active.selected || active.selectedId === "gateway") && !active.needsInventoryRefresh) {
        void active.refreshBackups();
      }
    };
    let timer: ReturnType<typeof setInterval> | undefined;
    const visibility = () => {
      if (document.visibilityState === "hidden") {
        clearInterval(timer);
        timer = undefined;
      } else if (timer === undefined) {
        timer = setInterval(tick, 15_000);
        tick();
      }
    };
    const desktopToggle = (event: Event) => {
      const active = controller();
      if (!props.presented || !active?.current || !(event instanceof CustomEvent)) {
        return;
      }
      const detail = isRecord(event.detail) ? event.detail : {};
      const environmentId =
        typeof detail.environmentId === "string" ? detail.environmentId : undefined;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (detail.open === false || environmentId === active.selectedId) {
        host.querySelector("openclaw-desktop-panel")?.handleToggleRequest(event);
      } else if (environmentId) {
        active.select(environmentId);
        if (!active.rows.some((row) => row.environment.id === environmentId)) {
          void active.refresh();
        }
      }
    };
    if (document.visibilityState !== "hidden") {
      timer = setInterval(tick, 15_000);
    }
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener(DESKTOP_PANEL_TOGGLE_EVENT, desktopToggle);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener(DESKTOP_PANEL_TOGGLE_EVENT, desktopToggle);
    };
  });
  return (
    <Show
      when={controller()?.current}
      fallback={
        <p class="systems-state" role="status">
          {t("systems.loading")}
        </p>
      }
    >
      <SystemsWorkspace controller={controller()!} presented={props.presented} />
    </Show>
  );
}

function SystemsDetails(props: { controller: SystemsController; row: SystemsInventoryRow }) {
  const controller = () => props.controller;
  const row = () => props.row;
  const environment = () => row()!.environment;
  return (
    <aside class="systems-details" aria-label={t("systems.details")}>
      <header>
        <h2>{t("systems.details")}</h2>
        <button
          class="systems-icon-button"
          aria-label={t("systems.closeDetails")}
          onClick={() =>
            controller().updatePresentation({ showDetails: !controller().showDetails })
          }
        >
          <Icon name="x" />
        </button>
      </header>
      <dl>
        <dt>{t("systems.identifier")}</dt>
        <dd>{environment().id}</dd>
        <dt>{t("systems.status")}</dt>
        <dd>{controller().connected ? systemStatus(row()) : t("systems.offline")}</dd>
        <dt>{t("systems.platform")}</dt>
        <dd>{systemPlatform(row()) ?? t("systems.unknown")}</dd>
      </dl>
      <h3>{t("systems.telemetry")}</h3>
      <SystemMeasurements row={row()} controller={controller()} />
      <h3>{t("systems.relatedSessions")}</h3>
      <p class="systems-detail-hint">{t("systems.relatedHint")}</p>
      {row().sessions.length ? (
        <For each={row().sessions}>
          {(relation) => {
            const session = relation.session;
            const face = resolveSessionPreferredFace(session);
            const target = () =>
              sessionNavigationTarget({
                context: controller().context,
                face,
                sessionKey: session.key,
                preferenceDerivedFace: true,
              });
            return (
              <a
                class="systems-session-link"
                href={target().href}
                onClick={(event: MouseEvent) => {
                  if (!shouldHandleNavigationClick(event)) {
                    return;
                  }
                  event.preventDefault();
                  controller().context.navigate(face, target().options);
                }}
              >
                <strong class="systems-session-link__title">
                  {session.displayName ?? session.label ?? session.key}
                </strong>
                <span>{t("systems.relations." + relation.kind)}</span>
              </a>
            );
          }}
        </For>
      ) : (
        <p class="systems-detail-hint">{t("systems.noRelatedSessions")}</p>
      )}
      {environment().worker?.attachedSessionIds.length ? (
        <>
          <h3>{t("systems.attachedSessions")}</h3>
          <p class="systems-detail-hint">{t("systems.attachedHint")}</p>
          <ul>
            <For each={environment().worker!.attachedSessionIds}>{(id) => <li>{id}</li>}</For>
          </ul>
        </>
      ) : null}
      <h3>{t("systems.capabilities")}</h3>
      <div class="systems-capabilities">
        <For each={environment().capabilities ?? []}>
          {(capability) => <span>{capability}</span>}
        </For>
      </div>
    </aside>
  );
}

function HostDesktopSetup(props: { controller: SystemsController; row: SystemsInventoryRow }) {
  const controller = () => props.controller;
  const row = () => props.row;
  const setup = () => row()!.environment.desktopSetup;
  const enabled = () => controller().hostDesktopEnabled;
  const isMac = () => systemPlatform(row())?.startsWith("macOS") === true;
  const ready = () => setup()?.state === "ready" || setup()?.state === "managed";
  const title = () =>
    enabled()
      ? "systems.desktopSetupEnabled"
      : ([
          ["managed", "systems.managedDesktopConfigured"],
          ["ready", isMac() ? "systems.screenSharingDetected" : "systems.desktopDetected"],
          ["needs-server", isMac() ? "systems.screenSharingNeeded" : "systems.desktopServerNeeded"],
        ].find(([kind]) => kind === setup()?.state)?.[1] ?? "systems.desktopSetupAttention");
  const hint = () =>
    enabled()
      ? "systems.desktopSetupConnecting"
      : ready()
        ? "systems.desktopSetupEnableHint"
        : isMac() && setup()?.state === "needs-server"
          ? "systems.screenSharingSetupHint"
          : "systems.desktopServerSetupHint";
  return (
    <div class="systems-state" role="status">
      <span class="systems-state__icon" aria-hidden="true">
        <Icon name="monitor" />
      </span>
      <h2>{t(title())}</h2>
      <p>{t(hint())}</p>
      {setup()?.state === "unsupported" && setup()!.detail ? <p>{setup()!.detail}</p> : null}
      {controller().desktopSetupError ? (
        <p class="systems-callout--error" role="alert">
          {controller().desktopSetupError}
        </p>
      ) : null}
      {!enabled() && ready() ? (
        <>
          <button
            class="btn primary systems-text-button"
            disabled={!controller().canEnableHostDesktop || controller().desktopSetupBusy}
            onClick={() => void controller().enableHostDesktop()}
          >
            {t(
              controller().desktopSetupBusy
                ? "systems.desktopSetupEnabling"
                : "systems.enableDesktopAccess",
            )}
          </button>
          <p>
            {t(
              controller().context.runtimeConfig.canPatch === true
                ? "systems.desktopSetupApplyHint"
                : "systems.desktopSetupAdminHint",
            )}
          </p>
        </>
      ) : null}
      {!enabled() && !ready() ? (
        <button
          class="systems-text-button"
          disabled={controller().loading || !controller().connected}
          onClick={() => void controller().refresh("manual")}
        >
          {t("systems.desktopSetupCheckAgain")}
        </button>
      ) : null}
    </div>
  );
}

function SystemsWorkspace(props: { controller: SystemsController; presented: boolean }) {
  const controller = () => props.controller;
  const row = () => controller().selected;
  const canView = () =>
    Boolean(
      row()?.environment.desktop &&
      row()!.environment.status === "available" &&
      controller().desktopAvailable &&
      props.presented,
    );
  const title = () => (row() ? systemName(row()!) : t("systems.title"));
  const auxiliaryErrors = () => Object.values(controller().inventory?.errors ?? {});
  const emptyTitle = () =>
    !controller().connected
      ? t("systems.offlineGateway")
      : controller().loading && !controller().inventory
        ? t("systems.loading")
        : controller().selectedId && !row()
          ? t("systems.missingTitle")
          : !row()
            ? t("systems.select")
            : row()!.environment.status !== "available"
              ? row()!.environment.status === "unavailable"
                ? t("systems.offlineTitle")
                : systemStatus(row()!)
              : !row()!.environment.desktop
                ? t("systems.noDesktopTitle")
                : t("systems.accessTitle");
  const emptyHint = () =>
    controller().selectedId && !row()
      ? t("systems.missingHint")
      : !row()
        ? t("systems.selectHint")
        : row()!.environment.status !== "available"
          ? t("systems.offlineHint")
          : !row()!.environment.desktop
            ? t(
                row()!.environment.id === "gateway"
                  ? "systems.noHostDesktopHint"
                  : "systems.noDesktopHint",
              )
            : t("systems.accessHint");
  return (
    <section class="systems-workspace" aria-label={t("systems.title")}>
      <header class="systems-toolbar">
        <div class="systems-heading">
          <h1>{title()}</h1>
          <span>{row() ? t("systems." + systemKind(row()!)) : t("systems.selectHint")}</span>
        </div>
        <select
          class="systems-mobile-picker"
          aria-label={t("systems.select")}
          onChange={(event: Event) => {
            if (event.currentTarget instanceof HTMLSelectElement) {
              controller().select(event.currentTarget.value);
            }
          }}
        >
          <option value="" disabled selected={!row()}>
            {t("systems.select")}
          </option>
          <For each={controller().rows}>
            {(entry) => (
              <option
                value={entry.environment.id}
                selected={entry.environment.id === controller().selectedId}
              >
                {systemName(entry)}
              </option>
            )}
          </For>
        </select>
        <button
          class="systems-icon-button"
          title={t(controller().showStats ? "systems.hideStats" : "systems.stats")}
          aria-label={t(controller().showStats ? "systems.hideStats" : "systems.stats")}
          aria-pressed={controller().showStats ? "true" : "false"}
          onClick={() => controller().updatePresentation({ showStats: !controller().showStats })}
        >
          <Icon name="activity" />
        </button>
        <button
          class="systems-icon-button"
          title={t("systems.details")}
          aria-label={t("systems.details")}
          aria-pressed={controller().showDetails ? "true" : "false"}
          disabled={!row()}
          onClick={() =>
            controller().updatePresentation({ showDetails: !controller().showDetails })
          }
        >
          <Icon name="panelRightOpen" />
        </button>
      </header>
      {controller().error ? (
        <div class="systems-callout systems-callout--error" role="alert">
          {controller().error}
          <button
            onClick={() => void controller().refresh("manual")}
            disabled={controller().loading}
          >
            {t("common.retry")}
          </button>
        </div>
      ) : null}
      {!controller().connected ? (
        <div class="systems-callout" role="status">
          {t("systems.offlineGateway")}
        </div>
      ) : null}
      {auxiliaryErrors().length ? (
        <details class="systems-callout">
          <summary>{t("systems.errors")}</summary>
          <For each={auxiliaryErrors()}>{(error) => <p>{error}</p>}</For>
        </details>
      ) : null}
      {controller().showStats && row() ? (
        <SystemMeasurements row={row()!} controller={controller()} />
      ) : null}
      {!row() || row()!.environment.id === "gateway" ? (
        <SystemsBackups controller={controller()} />
      ) : null}
      <div class="systems-body">
        <div class="systems-desktop">
          {canView() && row() ? (
            <openclaw-desktop-panel
              embedded
              data-chat-autotype-exempt
              prop:client={controller().context.gateway.snapshot.client}
              prop:available={controller().desktopAvailable}
              prop:presented={props.presented}
              prop:workspaceControls={true}
              prop:suppliedEnvironments={controller().inventory?.environments ?? []}
              prop:requestedSource={row()!.environment.id}
              prop:basePath={controller().context.basePath}
            />
          ) : row()?.environment.id === "gateway" &&
            controller().connected &&
            row()!.environment.status === "available" &&
            (row()!.environment.desktopSetup ||
              (row()!.environment.desktop &&
                controller().hostDesktopEnabled &&
                controller().context.runtimeConfig.canPatch === true)) ? (
            <HostDesktopSetup controller={controller()} row={row()!} />
          ) : (
            <div class="systems-state" role="status">
              <span class="systems-state__icon" aria-hidden="true">
                <Icon name="monitor" />
              </span>
              <h2>{emptyTitle()}</h2>
              <p>{emptyHint()}</p>
              {row() ? (
                <button
                  class="systems-text-button"
                  onClick={() =>
                    controller().updatePresentation({
                      showDetails: !controller().showDetails,
                    })
                  }
                >
                  {t("systems.details")}
                </button>
              ) : null}
            </div>
          )}
        </div>
        {controller().showDetails && row() ? (
          <SystemsDetails controller={controller()} row={row()!} />
        ) : null}
      </div>
    </section>
  );
}

export const SystemsPage = defineSolidBridge<SystemsPageProps>(
  "openclaw-systems-page",
  SystemsPageContent,
  {
    properties: {
      routeData: { default: undefined, attribute: false },
      presented: { default: true, type: Boolean },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-systems-page": SystemsPageElement;
  }
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-sparkline": HTMLAttributes<HTMLElement> & {
        "prop:label"?: string;
        "prop:sub"?: string;
        "prop:samples"?: readonly SparklineSample[];
        "prop:format"?: (value: number) => string;
        "prop:floorMax"?: number;
        "prop:autorange"?: boolean;
      };
      "openclaw-desktop-panel": HTMLAttributes<HTMLElementTagNameMap["openclaw-desktop-panel"]> & {
        embedded?: boolean;
        "prop:client"?: HTMLElementTagNameMap["openclaw-desktop-panel"]["client"];
        "prop:available"?: boolean;
        "prop:presented"?: boolean;
        "prop:workspaceControls"?: boolean;
        "prop:suppliedEnvironments"?: HTMLElementTagNameMap["openclaw-desktop-panel"]["suppliedEnvironments"];
        "prop:requestedSource"?: string;
        "prop:basePath"?: string;
      };
    }
  }
}
