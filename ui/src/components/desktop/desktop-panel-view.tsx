import type { DesktopAvailability, EnvironmentSummary } from "@openclaw/gateway-protocol";
import type { JSX } from "@solidjs/web";
import { For, Show, createMemo, onSettled } from "solid-js";
import { registerDesktopEnglish } from "../../i18n/locales/en-desktop.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { Icon } from "../solid/icon.tsx";
import { PanelEmptyState } from "../solid/panel-empty-state.tsx";
import { PanelIconButton } from "../solid/panel-icon-button.tsx";
import { PanelLoadingSkeleton } from "../solid/panel-loading-skeleton.tsx";
import {
  DesktopConnectionRail,
  DesktopOpenWindow,
  DesktopSizing,
  type DesktopConnectionControls,
  type DesktopConnectionRailOptions,
} from "./desktop-panel-rail.tsx";
import type { DesktopPanelState } from "./desktop-panel-state.ts";
import { DesktopStatusSurface, DesktopViewerHint } from "./desktop-panel-status.tsx";
import { desktopSourceForEnvironment } from "./desktop-source.ts";
import { hostDesktopSetupCopy, type DesktopHostSetup } from "./host-desktop-setup.ts";

export { DesktopSizing } from "./desktop-panel-rail.tsx";
export type { DesktopSizingOptions } from "./desktop-panel-rail.tsx";

registerEnglishCatalog(registerDesktopEnglish);

export function DesktopPanelView(props: {
  embedded: boolean;
  desktopPresentation?: boolean;
  mobilePresentation?: boolean;
  workspaceControls?: boolean;
  dock: "bottom" | "right";
  height: number;
  width: number;
  fullscreen: boolean;
  sectionRef: (element: HTMLElement) => void;
  renderResizer: () => JSX.Element;
  renderFullscreenControl: () => JSX.Element;
  onClose: () => void;
  onDock: (dock: "bottom" | "right") => void;
  onOpenWindow: () => void;
  content: Omit<Parameters<typeof DesktopPanelContent>[0], "connection">;
  connection: Omit<Parameters<typeof DesktopConnection>[0], "state">;
}) {
  const statusRail = () =>
    props.connection.rail &&
    (props.connection.rail.machine || props.connection.rail.openWindowHref) && (
      <DesktopConnectionRail
        {...props.connection}
        recovery
        state={props.content.state}
        options={props.connection.rail}
      />
    );
  return (
    <section
      ref={(element) => props.sectionRef(element)}
      class={[
        "bp",
        `bp--${props.embedded ? "embedded" : props.dock}`,
        {
          "desktop-presentation--desktop": props.desktopPresentation,
          "desktop-presentation--mobile": props.mobilePresentation,
          "desktop-presentation--fullscreen": props.desktopPresentation && props.fullscreen,
        },
      ]}
      style={
        props.embedded || props.fullscreen
          ? ""
          : props.dock === "bottom"
            ? `height:${props.height}px`
            : `width:${props.width}px`
      }
      aria-label={t("desktop.title")}
    >
      {!props.embedded && props.renderResizer()}
      {!props.embedded && (
        <header class="rail-header bp-header">
          <div class="rail-header__title bp-title">{t("desktop.title")}</div>
          <div class="rail-header__actions bp-actions">
            <PanelIconButton
              class={["rail-header__action bp-icon", { "is-active": props.dock === "bottom" }]}
              label={t("desktop.dockBottom")}
              icon={<Icon name="panelBottomOpen" />}
              onClick={() => props.onDock("bottom")}
            />
            <PanelIconButton
              class={["rail-header__action bp-icon", { "is-active": props.dock === "right" }]}
              label={t("desktop.dockRight")}
              icon={<Icon name="panelRightOpen" />}
              onClick={() => props.onDock("right")}
            />
            <PanelIconButton
              class="rail-header__action bp-icon bp-open-window"
              label={t("desktop.openWindow")}
              icon={<Icon name="externalLink" />}
              onClick={props.onOpenWindow}
            />
            {props.renderFullscreenControl()}
            <PanelIconButton
              class="rail-header__action bp-icon"
              label={t("desktop.hide")}
              icon={<Icon name="x" />}
              onClick={props.onClose}
            />
          </div>
        </header>
      )}
      <DesktopPanelContent
        {...props.content}
        credentials={() => (
          <>
            {props.desktopPresentation && statusRail()}
            {props.content.credentials()}
          </>
        )}
        recovery={() => (
          <>
            {statusRail()}
            {props.content.recovery()}
          </>
        )}
        connection={() => (
          <DesktopConnection
            {...props.connection}
            state={props.content.state}
            presentationControls={
              props.workspaceControls && (
                <>
                  <PanelIconButton
                    class="desktop-toolbar-action"
                    label={t("desktop.openWindow")}
                    icon={<Icon name="externalLink" />}
                    onClick={props.onOpenWindow}
                  />
                  {props.renderFullscreenControl()}
                </>
              )
            }
          />
        )}
      />
    </section>
  );
}

export function DesktopPanelContent(props: {
  state: DesktopPanelState;
  notice: () => JSX.Element;
  picker: () => JSX.Element;
  credentials: () => JSX.Element;
  recovery: () => JSX.Element;
  connection: () => JSX.Element;
}) {
  const Notice = () => props.notice();
  return (
    <div class="desktop-content">
      <Notice />
      <Show when={props.state === "picker"}>{(shown) => shown() && props.picker()}</Show>
      <Show when={props.state === "inventory-error" || props.state === "disconnected"}>
        {(shown) => shown() && props.recovery()}
      </Show>
      <Show when={props.state === "credentials"}>{(shown) => shown() && props.credentials()}</Show>
      {/* Connection transitions update siblings without remounting noVNC's island. */}
      <Show when={props.state === "connecting" || props.state === "connected"}>
        {(shown) => shown() && props.connection()}
      </Show>
    </div>
  );
}

// Systems hints sit under the selected machine's row; the panel names the Gateway host instead.
const HOST_SETUP_HINTS: Record<string, string> = {
  "systems.desktopSetupEnableHint": "desktop.hostDesktopEnableHint",
  "systems.screenSharingSetupHint": "desktop.hostScreenSharingSetupHint",
  "systems.desktopServerSetupHint": "desktop.hostDesktopServerSetupHint",
};

function DesktopHostSetupNotice(props: { setup: DesktopHostSetup; loading: boolean }) {
  const state = () => props.setup.environment.desktopSetup?.state;
  const ready = () => state() === "ready" || state() === "managed";
  const mac = () => props.setup.environment.platform === "darwin";
  const copy = () => hostDesktopSetupCopy(state(), mac(), false);
  return (
    <div class="desktop-status" role="status">
      <div>{t("desktop.hostDesktopOff")}</div>
      <h2>{t(copy().title)}</h2>
      <div>{t(HOST_SETUP_HINTS[copy().hint] ?? copy().hint)}</div>
      {state() === "needs-server" || state() === "ready" ? (
        <div>{t(mac() ? "desktop.screenSharingNetwork" : "desktop.desktopServerNetwork")}</div>
      ) : null}
      {state() === "ready" ? (
        <div>
          {t(mac() ? "desktop.hostScreenSharingAccount" : "desktop.hostDesktopServerAccount")}
        </div>
      ) : null}
      {state() === "unsupported" && props.setup.environment.desktopSetup?.detail ? (
        <div>{props.setup.environment.desktopSetup.detail}</div>
      ) : null}
      {props.setup.error ? (
        <div class="desktop-note--error" role="alert">
          {props.setup.error}
        </div>
      ) : null}
      {ready() ? (
        <>
          <button
            class="desktop-button desktop-button--primary"
            type="button"
            disabled={!props.setup.canEnable || props.setup.busy}
            onClick={props.setup.onEnable}
          >
            {t(props.setup.busy ? "systems.desktopSetupEnabling" : "systems.enableDesktopAccess")}
          </button>
          <div>
            {t(
              props.setup.canEnable
                ? "systems.desktopSetupApplyHint"
                : "systems.desktopSetupAdminHint",
            )}
          </div>
        </>
      ) : null}
      {/* Systems polls; the panel retests on request whenever it cannot enable here. */}
      {!ready() || !props.setup.canEnable ? (
        <button
          class="desktop-button"
          type="button"
          disabled={props.loading}
          onClick={props.setup.onCheckAgain}
        >
          {t(props.loading ? "desktop.refreshing" : "systems.desktopSetupCheckAgain")}
        </button>
      ) : null}
    </div>
  );
}

export function DesktopPicker(props: {
  automatic: boolean;
  environments: EnvironmentSummary[];
  hostSetup?: DesktopHostSetup | null;
  loading: boolean;
  presentation?: "desktop" | "mobile";
  genuineEmpty?: boolean;
  openWindowHref?: string;
  onConnect: (environmentId: string) => void;
  onRefresh: () => void;
}) {
  return (
    <>
      {props.automatic ? (
        <>
          {props.openWindowHref && (
            <div class="desktop-toolbar session-panel-rail" data-presentation="desktop">
              <span class="desktop-toolbar__spacer" />
              <DesktopOpenWindow href={props.openWindowHref} />
            </div>
          )}
          {props.hostSetup ? (
            <DesktopHostSetupNotice setup={props.hostSetup} loading={props.loading} />
          ) : (
            <div class="desktop-status" role="status">
              <button class="desktop-button" type="button" onClick={props.onRefresh}>
                {t("common.retry")}
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <div
            class={["desktop-toolbar", { "session-panel-rail": props.presentation === "desktop" }]}
            data-presentation={props.presentation === "desktop" ? "desktop" : undefined}
          >
            <span>
              {t(
                props.presentation === "mobile"
                  ? "desktop.availableDesktops"
                  : "desktop.pickerTitle",
              )}
            </span>
            <span class="desktop-toolbar__spacer" />
            <button
              class={
                props.presentation === "desktop"
                  ? "session-panel-rail__button session-panel-rail__button--labelled"
                  : "desktop-button"
              }
              type="button"
              disabled={props.loading}
              onClick={props.onRefresh}
            >
              {props.presentation === "mobile" && <Icon name="refresh" />}
              {props.loading ? t("desktop.refreshing") : t("desktop.refresh")}
            </button>
            {props.openWindowHref && <DesktopOpenWindow href={props.openWindowHref} />}
          </div>
          <div class="desktop-picker">
            {props.loading && props.environments.length === 0 ? (
              props.presentation === "desktop" ? (
                <DesktopStatusSurface heading={t("desktop.loading")} pending />
              ) : (
                <PanelLoadingSkeleton variant="desktop" label={t("desktop.loading")} />
              )
            ) : props.environments.length === 0 ? (
              props.presentation && props.genuineEmpty ? (
                <PanelEmptyState
                  presentation={props.presentation}
                  icon={<Icon name="monitor" />}
                  heading={t("desktop.emptyTitle")}
                  description={t("desktop.empty")}
                />
              ) : (
                <div class="desktop-status">{t("desktop.empty")}</div>
              )
            ) : (
              <For each={props.environments} keyed={(environment) => environment.id}>
                {(environment) => (
                  <DesktopEnvironment
                    environment={environment()}
                    onConnect={props.onConnect}
                    useLabel={props.presentation === "desktop"}
                  />
                )}
              </For>
            )}
          </div>
        </>
      )}
    </>
  );
}

function DesktopEnvironment(props: {
  environment: EnvironmentSummary;
  onConnect: (environmentId: string) => void;
  useLabel?: boolean;
}) {
  return (
    <div class="desktop-environment">
      <div class="desktop-environment__details">
        <div class="desktop-environment__id">
          {props.useLabel && props.environment.label
            ? props.environment.label
            : desktopSourceForEnvironment(props.environment).kind === "host"
              ? t("desktop.thisMachine")
              : props.environment.id}
        </div>
        <div class="desktop-environment__meta">
          <span>{props.environment.worker?.state ?? props.environment.status}</span>
        </div>
        {Boolean(props.environment.worker?.attachedSessionIds.length) && (
          <div class="desktop-environment__sessions">
            <For
              each={props.environment.worker?.attachedSessionIds}
              keyed={(sessionId) => sessionId}
            >
              {(sessionId) => <span class="desktop-session">{sessionId()}</span>}
            </For>
          </div>
        )}
      </div>
      <button
        class="desktop-button desktop-button--primary"
        type="button"
        onClick={() => props.onConnect(props.environment.id)}
      >
        {t("desktop.connect")}
      </button>
    </div>
  );
}

export function DesktopCredentials(props: {
  ardAccount: boolean;
  username: string;
  onSubmit: (event: SubmitEvent) => void;
  presentation?: "desktop" | "mobile";
  machineName?: string;
  onBack?: () => void;
}) {
  return (
    <>
      {props.presentation === "mobile" && (
        <div class="desktop-toolbar desktop-credentials-rail">
          {props.onBack && (
            <PanelIconButton
              class="desktop-toolbar-action"
              label={t("desktop.back")}
              icon={<Icon name="chevronLeft" />}
              onClick={props.onBack}
            />
          )}
          <span title={props.machineName}>{props.machineName}</span>
        </div>
      )}
      <div class="desktop-status">
        <form class="desktop-credentials" onSubmit={(event) => props.onSubmit(event)}>
          {props.presentation === "desktop" && (
            <>
              <Icon name="lock" class="desktop-credentials__icon" />
              <strong class="desktop-credentials__title">{t("desktop.credentialsTitle")}</strong>
            </>
          )}
          <div>{t(props.ardAccount ? "desktop.accountPrompt" : "desktop.passwordPrompt")}</div>
          {props.ardAccount && (
            <label class="desktop-credentials__label">
              {t("desktop.usernameLabel")}
              <input
                class="desktop-credentials__input"
                name="username"
                type="text"
                autocomplete="off"
                value={props.username}
                required
              />
            </label>
          )}
          <label class="desktop-credentials__label">
            {t(props.ardAccount ? "desktop.accountPasswordLabel" : "desktop.passwordLabel")}
            <input
              class="desktop-credentials__input"
              name="password"
              type="password"
              autocomplete="off"
              required
            />
          </label>
          <button class="desktop-button desktop-button--primary" type="submit">
            {t("desktop.connect")}
          </button>
        </form>
      </div>
    </>
  );
}

function DesktopConnection(
  props: DesktopConnectionControls & {
    surfaceRef: (element: HTMLElement | undefined) => void;
    pictureInPictureControl: JSX.Element;
    audioControl?: JSX.Element;
    presentationControls?: JSX.Element;
    rail?: DesktopConnectionRailOptions;
  },
) {
  let stage!: HTMLDivElement;
  const hasRail = createMemo(() => props.rail !== undefined);
  const desktop = createMemo(() => props.rail?.platform === "desktop");
  return (
    <>
      {hasRail() ? (
        <DesktopConnectionRail {...props} options={props.rail!} />
      ) : (
        <div class="desktop-toolbar desktop-toolbar--connection">
          {props.showApps && props.desktopApps.length > 0 && (
            <div class="desktop-apps">
              <For each={props.desktopApps} keyed={(app) => app}>
                {(app) => (
                  <button
                    class="desktop-app-button"
                    type="button"
                    title={t(app() === "browser" ? "browser.title" : "terminal.title")}
                    aria-label={t(app() === "browser" ? "browser.title" : "terminal.title")}
                    aria-busy={props.launchingApp === app() ? "true" : "false"}
                    disabled={props.launchingApp === app()}
                    onClick={() => props.onLaunch(app())}
                  >
                    <span
                      class={[
                        "desktop-app-button__icon",
                        { "desktop-app-button__icon--launching": props.launchingApp === app() },
                      ]}
                      aria-hidden="true"
                    >
                      <Icon name={app() === "browser" ? "chrome" : "terminal"} />
                    </span>
                    <span>{t(app() === "browser" ? "browser.title" : "terminal.title")}</span>
                  </button>
                )}
              </For>
            </div>
          )}
          <span class="desktop-toolbar__spacer" />
          {props.controlling ? (
            <button
              class="desktop-toolbar-action"
              type="button"
              aria-label={t("desktop.switchToViewOnly")}
              disabled={props.state !== "connected"}
              onClick={props.onControlToggle}
            >
              {t("desktop.control")}
            </button>
          ) : (
            props.state === "connected" && (
              <span class="desktop-toolbar-mode" role="status">
                {t("desktop.viewOnly")}
              </span>
            )
          )}
          <DesktopSizing {...props.sizing} />
          {props.audioControl}
          {props.pictureInPictureControl}
          {props.presentationControls}
          <button
            class="desktop-toolbar-action"
            type="button"
            title={t("desktop.disconnect")}
            aria-label={t("desktop.disconnect")}
            onClick={() => props.onDisconnect()}
          >
            {t("desktop.disconnect")}
          </button>
        </div>
      )}
      {desktop() && props.rail?.takeoverText && !props.rail.fullscreen && (
        <div class="desktop-takeover" role="status">
          {props.rail.takeoverText}
        </div>
      )}
      <div
        class="desktop-stage"
        ref={(element) => {
          stage = element;
        }}
      >
        {/* noVNC owns this island's children for the entire connection. */}
        <DesktopSurface bind={props.surfaceRef} />
        {!props.controlling && (
          <button
            class="desktop-stage__take-control"
            type="button"
            title={desktop() ? undefined : t("desktop.takeControl")}
            aria-label={t("desktop.takeControl")}
            disabled={props.state !== "connected"}
            onClick={props.onTakeControl}
          />
        )}
        {desktop() && (
          <DesktopViewerHint
            stage={() => stage}
            active={props.state === "connected" && !props.controlling}
            fullscreen={props.rail?.fullscreen ?? false}
          />
        )}
        {props.state === "connecting" &&
          (desktop() ? (
            props.rail?.controlTransition ? (
              <div class="desktop-control-transition" role="status">
                <Icon name="loader" />
                <span>{props.rail.pendingLabel}</span>
              </div>
            ) : (
              <DesktopStatusSurface
                heading={props.rail?.pendingLabel ?? t("desktop.connecting")}
                pending
                overlay
              />
            )
          ) : (
            <PanelLoadingSkeleton variant="desktop" label={t("desktop.connecting")} overlay />
          ))}
      </div>
    </>
  );
}

export function DesktopNotice(props: {
  errorText: string | null;
  noticeText: string | null;
  availability?: DesktopAvailability;
}) {
  return (
    <>
      {props.errorText ? (
        <div class="desktop-note desktop-note--error" role="alert">
          {props.errorText}
        </div>
      ) : (
        props.noticeText && (
          <div class="desktop-note" role="status">
            {props.noticeText}
          </div>
        )
      )}
      {props.availability?.state === "locked" ? (
        <div class="desktop-note" role="status">
          {t("desktop.macLocked")}
        </div>
      ) : (
        props.availability?.state === "unknown" && (
          <div class="desktop-note" role="status">
            {t("desktop.macLockStateUnknown")}
          </div>
        )
      )}
    </>
  );
}

export function DesktopPanelRecovery(props: {
  inventoryError: boolean;
  reason: string | null;
  onRetry: () => void;
  presentation?: "desktop" | "mobile";
  kind?: "error" | "lost" | "closed" | null;
}) {
  const retry = () => (
    <button class="desktop-button" type="button" onClick={props.onRetry}>
      <Icon name="refresh" />
      {t(props.inventoryError ? "common.retry" : "desktop.reconnect")}
    </button>
  );
  return (
    <Show
      when={props.presentation === "desktop"}
      fallback={
        <div class="desktop-status">
          {!props.inventoryError && (
            <div>
              {props.reason
                ? t("desktop.disconnected", { reason: props.reason })
                : t("desktop.disconnectedClean")}
            </div>
          )}
          <button
            class="desktop-button desktop-button--primary"
            type="button"
            onClick={() => props.onRetry()}
          >
            {t(props.inventoryError ? "common.retry" : "desktop.reconnect")}
          </button>
        </div>
      }
    >
      <DesktopStatusSurface
        heading={t(
          props.inventoryError
            ? "desktop.inventoryError"
            : props.kind === "error"
              ? "desktop.connectionError"
              : props.kind === "lost"
                ? "desktop.connectionLost"
                : "desktop.disconnectedClean",
        )}
        description={props.reason}
        action={retry()}
      />
    </Show>
  );
}

/** Solid owns the target; noVNC owns its children for the whole connection. */
export function DesktopSurface(props: { bind: (element: HTMLElement | undefined) => void }) {
  onSettled(() => {
    const bind = props.bind;
    return () => bind(undefined);
  });
  return <div class="desktop-surface" ref={(element) => props.bind(element)} />;
}
