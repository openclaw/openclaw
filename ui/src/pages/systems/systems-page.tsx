import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  Errored,
  For,
  Loading,
  Repeat,
  Show,
  action,
  createEffect,
  createMemo,
  createOptimistic,
  latest,
  onSettled,
} from "solid-js";
import { hostDesktopSetupCopy } from "../../components/desktop/host-desktop-setup.ts";
import { DESKTOP_PANEL_TOGGLE_EVENT } from "../../components/panel-toggle-contract.ts";
import "../../components/desktop/desktop-panel-solid.tsx";
import { HubPageHeader } from "../../components/solid/hub-page-header.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { registerSystemsEnglish } from "../../i18n/locales/en-systems.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { handleNavigationClick } from "../../lib/navigation-click.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import {
  resolveSessionPreferredFace,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import { SystemsBackups } from "./systems-backups.tsx";
import type { SystemsInventoryRow } from "./systems-data.ts";
import { SystemMeasurements } from "./systems-measurements.tsx";
import { createSystemsRead } from "./systems-read.ts";
import { systemKind, systemName, systemPlatform, systemStatus } from "./systems-sidebar.tsx";
import type { Systems } from "./systems-state.ts";
import "../../styles/systems.css";

registerEnglishCatalog(registerSystemsEnglish);

export function SystemsPage(props: { controller: Systems; presented: boolean }) {
  let desktopPanel: HTMLElementTagNameMap["openclaw-desktop-panel"] | undefined;
  const source = createMemo(() => props.controller);
  const isPresented = createMemo(() => props.presented);
  const projection = createMemo(() => projectOwner(source(), (value) => value));
  const config = createMemo(() => projectRuntimeConfig(source().context.runtimeConfig));
  const controller = () => {
    config().revision();
    return projection().read();
  };
  const inventoryRead = createSystemsRead(() => controller().inventoryRead);
  // The systems owner starts and parks its Gateway polling with page visibility.
  createEffect(
    () => ({ controller: source(), presented: isPresented() }),
    ({ controller: active, presented }) => {
      active.setPresented(presented);
      return () => active.setPresented(false);
    },
  );
  onSettled(() => {
    const tick = () => {
      const active = controller();
      if (!props.presented) {
        return;
      }
      const needsInventory = active.needsInventoryRefresh();
      if (needsInventory) {
        void active.refresh();
      } else if (active.state.showStats || active.state.showDetails) {
        void active.refreshTelemetry();
      }
      if ((!active.selected() || active.state.selectedId === "gateway") && !needsInventory) {
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
      if (!props.presented || !active.current() || !(event instanceof CustomEvent)) {
        return;
      }
      const detail = isRecord(event.detail) ? event.detail : {};
      const environmentId =
        typeof detail.environmentId === "string" ? detail.environmentId : undefined;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (detail.open === false || environmentId === active.state.selectedId) {
        desktopPanel?.handleToggleRequest(event);
      } else if (environmentId) {
        active.select(environmentId);
        if (!active.state.rows.some((row) => row.environment.id === environmentId)) {
          void active.refresh();
        }
      }
    };
    if (document.visibilityState !== "hidden") {
      timer = setInterval(tick, 15_000);
    }
    const stopVisibility = listen(document, "visibilitychange", visibility);
    const stopToggle = listen(window, DESKTOP_PANEL_TOGGLE_EVENT, desktopToggle);
    return () => {
      clearInterval(timer);
      stopVisibility();
      stopToggle();
    };
  });
  return (
    <openclaw-systems-page>
      <Show
        when={controller().current()}
        fallback={
          <p class="systems-state" role="status">
            {t("systems.loading")}
          </p>
        }
      >
        <SystemsWorkspace
          controller={controller()}
          inventoryRead={inventoryRead}
          presented={props.presented}
          onDesktopPanel={(panel) => {
            desktopPanel = panel;
          }}
        />
      </Show>
    </openclaw-systems-page>
  );
}

function SystemsDetails(props: { controller: Systems; row?: SystemsInventoryRow }) {
  const controller = () => props.controller;
  let panel!: HTMLElement;
  onSettled(() => {
    const opener = document.activeElement;
    panel.focus();
    return () => {
      if (panel.contains(document.activeElement) && opener instanceof HTMLElement) {
        opener.focus();
      }
    };
  });
  return (
    <aside
      ref={(element) => (panel = element)}
      class="systems-details"
      tabindex={-1}
      aria-label={t("systems.details")}
    >
      <header>
        <h2>{t("systems.details")}</h2>
        <button
          class="systems-icon-button"
          aria-label={t("systems.closeDetails")}
          onClick={() =>
            controller().updatePresentation({ showDetails: !controller().state.showDetails })
          }
        >
          <Icon name="x" />
        </button>
      </header>
      <Show when={props.row}>
        {(row) => {
          const environment = () => row().environment;
          return (
            <>
              <dl>
                <dt>{t("systems.identifier")}</dt>
                <dd>{environment().id}</dd>
                <dt>{t("systems.status")}</dt>
                <dd>{controller().connected() ? systemStatus(row()) : t("systems.offline")}</dd>
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
                        onClick={(event: MouseEvent) =>
                          handleNavigationClick(event, () => {
                            controller().context.navigate(face, target().options);
                          })
                        }
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
                    <For each={environment().worker!.attachedSessionIds}>
                      {(id) => <li>{id}</li>}
                    </For>
                  </ul>
                </>
              ) : null}
              <h3>{t("systems.capabilities")}</h3>
              <div class="systems-capabilities">
                <For each={environment().capabilities ?? []}>
                  {(capability) => <span>{capability}</span>}
                </For>
              </div>
            </>
          );
        }}
      </Show>
      {!props.row || props.row.environment.id === "gateway" ? (
        <SystemsBackups controller={controller()} />
      ) : null}
    </aside>
  );
}

function HostDesktopSetup(props: {
  controller: Systems;
  row: SystemsInventoryRow;
  loading: boolean;
}) {
  const controller = () => props.controller;
  const row = () => props.row;
  const setup = () => row()!.environment.desktopSetup;
  const enabled = () => controller().hostDesktopEnabled();
  const isMac = () => systemPlatform(row())?.startsWith("macOS") === true;
  const ready = () => setup()?.state === "ready" || setup()?.state === "managed";
  const copy = () => hostDesktopSetupCopy(setup()?.state, isMac(), enabled());
  const [enabling, setEnabling] = createOptimistic(false);
  const presentEnable = action(function* (
    operation: NonNullable<ReturnType<Systems["enableHostDesktop"]>>,
  ) {
    setEnabling(true);
    yield Promise.race([operation.completion, operation.retired]);
  });
  const enable = async () => {
    const operation = controller().enableHostDesktop();
    if (!operation) {
      return;
    }
    // Let the owner's admission publish before starting its optimistic presentation.
    await Promise.resolve();
    await presentEnable(operation);
  };
  return (
    <div class="systems-state" role="status">
      <span class="systems-state__icon" aria-hidden="true">
        <Icon name="monitor" />
      </span>
      <h2>{t(copy().title)}</h2>
      <p>{t(copy().hint)}</p>
      {setup()?.state === "unsupported" && setup()!.detail ? <p>{setup()!.detail}</p> : null}
      {controller().state.desktopSetupError ? (
        <p class="systems-callout--error" role="alert">
          {controller().state.desktopSetupError}
        </p>
      ) : null}
      {!enabled() && ready() ? (
        <>
          <button
            class="btn primary systems-text-button"
            disabled={
              enabling() || controller().desktopSetupBusy() || !controller().canEnableHostDesktop()
            }
            onClick={() => void enable()}
          >
            {t(enabling() ? "systems.desktopSetupEnabling" : "systems.enableDesktopAccess")}
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
          disabled={props.loading || !controller().connected()}
          onClick={() => void controller().refresh("manual")}
        >
          {t("systems.desktopSetupCheckAgain")}
        </button>
      ) : null}
    </div>
  );
}

function SystemsWorkspace(props: {
  controller: Systems;
  inventoryRead: ReturnType<typeof createSystemsRead>;
  presented: boolean;
  onDesktopPanel: (panel: HTMLElementTagNameMap["openclaw-desktop-panel"] | undefined) => void;
}) {
  const controller = () => props.controller;
  const row = () => controller().selected();
  const readStatus = () => {
    latest(props.inventoryRead.read);
    return null;
  };
  const canView = () =>
    Boolean(
      row()?.environment.desktop &&
      row()!.environment.status === "available" &&
      controller().desktopAvailable() &&
      props.presented,
    );
  const title = () => (row() ? systemName(row()!) : t("systems.select"));
  const auxiliaryErrors = () => Object.values(controller().state.inventory?.errors ?? {});
  const emptyTitle = () =>
    !controller().connected()
      ? t("systems.offlineGateway")
      : props.inventoryRead.pending() && !controller().state.inventory
        ? t("systems.loading")
        : controller().state.selectedId && !row()
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
    controller().state.selectedId && !row()
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
  const Desktop = () => {
    let panel!: HTMLElementTagNameMap["openclaw-desktop-panel"];
    onSettled(() => {
      props.onDesktopPanel(panel);
      return () => props.onDesktopPanel(undefined);
    });
    return (
      <openclaw-desktop-panel
        ref={(element) => (panel = element)}
        embedded
        data-chat-autotype-exempt
        prop:client={controller().context.gateway.snapshot.client}
        prop:available={controller().desktopAvailable()}
        prop:presented={props.presented}
        prop:workspaceControls={true}
        prop:suppliedEnvironments={controller().state.inventory?.environments ?? []}
        prop:requestedSource={row()!.environment.id}
        prop:basePath={controller().context.basePath}
      />
    );
  };
  return (
    <section class="systems-workspace" aria-label={t("systems.title")}>
      <HubPageHeader
        active="systems"
        wide
        docsUrl="https://docs.openclaw.ai/web/control-ui/sessions-and-sidebar#systems-workspace"
        class="systems-page-header"
      />
      <header class="systems-toolbar">
        <div class="systems-heading">
          <h2>{title()}</h2>
          <span>{row() ? t("systems." + systemKind(row()!)) : t("systems.selectHint")}</span>
        </div>
        <select
          class="systems-mobile-picker"
          aria-label={t("systems.select")}
          onChange={(event) => controller().select(event.currentTarget.value)}
        >
          <option value="" disabled selected={!row()}>
            {t("systems.select")}
          </option>
          <For each={controller().state.rows}>
            {(entry) => (
              <option
                value={entry.environment.id}
                selected={entry.environment.id === controller().state.selectedId}
              >
                {systemName(entry)}
              </option>
            )}
          </For>
        </select>
        <button
          class="systems-icon-button"
          title={t(controller().state.showStats ? "systems.hideStats" : "systems.stats")}
          aria-label={t(controller().state.showStats ? "systems.hideStats" : "systems.stats")}
          aria-pressed={controller().state.showStats ? "true" : "false"}
          onClick={() =>
            controller().updatePresentation({ showStats: !controller().state.showStats })
          }
        >
          <Icon name="activity" />
        </button>
        <button
          class="systems-icon-button"
          title={t("systems.details")}
          aria-label={t("systems.details")}
          aria-pressed={controller().state.showDetails ? "true" : "false"}
          onClick={() =>
            controller().updatePresentation({ showDetails: !controller().state.showDetails })
          }
        >
          <Icon name="panelRightOpen" />
        </button>
      </header>
      <div
        class={["systems-overview", { "systems-overview--compact": !controller().state.showStats }]}
        role="region"
        aria-label={`${t("systems.telemetry")} / ${t("systems.backups.title")}`}
        tabindex={0}
      >
        <Show when={props.inventoryRead.receipt()} keyed>
          {(receipt) => (
            <Errored
              fallback={(error) => (
                <div class="systems-callout systems-callout--error" role="alert">
                  {formatUiError(error())}
                  <button
                    onClick={() => void controller().refresh("manual")}
                    disabled={props.inventoryRead.pending()}
                  >
                    {t("common.retry")}
                  </button>
                </div>
              )}
            >
              <Loading on={receipt}>{readStatus()}</Loading>
            </Errored>
          )}
        </Show>
        {!controller().connected() ? (
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
        {controller().state.showStats ? (
          <div class="systems-overview__telemetry">
            <Show
              when={row()}
              fallback={
                <Show when={props.inventoryRead.pending()}>
                  <div class="systems-metrics" aria-hidden="true">
                    <div class="systems-vitals">
                      <Repeat count={3}>{() => <div class="systems-vital skeleton" />}</Repeat>
                    </div>
                  </div>
                </Show>
              }
            >
              {(selected) => (
                <SystemMeasurements
                  row={selected()}
                  controller={controller()}
                  summary
                  onDetails={() => controller().updatePresentation({ showDetails: true })}
                />
              )}
            </Show>
          </div>
        ) : null}
        {!row() || row()!.environment.id === "gateway" ? (
          <SystemsBackups
            controller={controller()}
            onDetails={() => controller().updatePresentation({ showDetails: true })}
          />
        ) : null}
      </div>
      <div class="systems-body">
        <div class="systems-desktop">
          {canView() && row() ? (
            <Desktop />
          ) : row()?.environment.id === "gateway" &&
            controller().connected() &&
            row()!.environment.status === "available" &&
            (row()!.environment.desktopSetup ||
              (row()!.environment.desktop &&
                controller().hostDesktopEnabled() &&
                controller().context.runtimeConfig.canPatch === true)) ? (
            <HostDesktopSetup
              controller={controller()}
              row={row()!}
              loading={props.inventoryRead.pending()}
            />
          ) : (
            <div
              class="systems-state"
              role="status"
              style={{
                visibility:
                  props.inventoryRead.pending() && !controller().state.inventory
                    ? "hidden"
                    : undefined,
              }}
            >
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
                      showDetails: !controller().state.showDetails,
                    })
                  }
                >
                  {t("systems.details")}
                </button>
              ) : null}
            </div>
          )}
        </div>
        {controller().state.showDetails ? (
          <SystemsDetails controller={controller()} row={row()} />
        ) : null}
      </div>
    </section>
  );
}
