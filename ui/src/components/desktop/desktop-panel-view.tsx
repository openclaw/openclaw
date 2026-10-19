import type {
  DesktopAvailability,
  EnvironmentSummary,
  WorkerDesktopAppId,
} from "@openclaw/gateway-protocol";
import type { JSX } from "@solidjs/web";
import { For, Show, onSettled } from "solid-js";
import { registerDesktopEnglish } from "../../i18n/locales/en-desktop.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { Icon } from "../solid/icon.tsx";
import { PanelIconButton } from "../solid/panel-icon-button.tsx";
import { PanelLoadingSkeleton } from "../solid/panel-loading-skeleton.tsx";
import type { DesktopSizingMode } from "./desktop-client.ts";
import type { DesktopPanelState } from "./desktop-panel-state.ts";
import { desktopSourceForEnvironment } from "./desktop-source.ts";

registerEnglishCatalog(registerDesktopEnglish);

export function DesktopLoading(props: { label: string; overlay?: boolean }) {
  return <PanelLoadingSkeleton variant="desktop" label={props.label} overlay={props.overlay} />;
}

export function DesktopPanelView(props: {
  embedded: boolean;
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
  return (
    <section
      ref={(element) => props.sectionRef(element)}
      class={["bp", `bp--${props.embedded ? "embedded" : props.dock}`]}
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

export function DesktopPicker(props: {
  automatic: boolean;
  environments: EnvironmentSummary[];
  loading: boolean;
  onConnect: (environmentId: string) => void;
  onRefresh: () => void;
}) {
  return (
    <>
      {props.automatic ? (
        <div class="desktop-status" role="status">
          <button class="desktop-button" type="button" onClick={props.onRefresh}>
            {t("common.retry")}
          </button>
        </div>
      ) : (
        <>
          <div class="desktop-toolbar">
            <span>{t("desktop.pickerTitle")}</span>
            <span class="desktop-toolbar__spacer" />
            <button
              class="desktop-button"
              type="button"
              disabled={props.loading}
              onClick={props.onRefresh}
            >
              {props.loading ? t("desktop.refreshing") : t("desktop.refresh")}
            </button>
          </div>
          <div class="desktop-picker">
            {props.loading && props.environments.length === 0 ? (
              <DesktopLoading label={t("desktop.loading")} />
            ) : props.environments.length === 0 ? (
              <div class="desktop-status">{t("desktop.empty")}</div>
            ) : (
              <For each={props.environments} keyed={(environment) => environment.id}>
                {(environment) => (
                  <DesktopEnvironment environment={environment()} onConnect={props.onConnect} />
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
}) {
  return (
    <div class="desktop-environment">
      <div class="desktop-environment__details">
        <div class="desktop-environment__id">
          {desktopSourceForEnvironment(props.environment).kind === "host"
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
}) {
  return (
    <div class="desktop-status">
      <form class="desktop-credentials" onSubmit={(event) => props.onSubmit(event)}>
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
  );
}

function DesktopConnection(props: {
  state: DesktopPanelState;
  surfaceRef: (element: HTMLElement | undefined) => void;
  controlling: boolean;
  desktopApps: WorkerDesktopAppId[];
  launchingApp: WorkerDesktopAppId | null;
  showApps: boolean;
  sizing: DesktopSizingOptions;
  pictureInPictureControl: JSX.Element;
  audioControl?: JSX.Element;
  presentationControls?: JSX.Element;
  onDisconnect: () => void;
  onLaunch: (app: WorkerDesktopAppId) => void;
  onTakeControl: () => void;
  onControlToggle: () => void;
}) {
  return (
    <>
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
      <div class="desktop-stage">
        {/* noVNC owns this island's children for the entire connection. */}
        <DesktopSurface bind={props.surfaceRef} />
        {!props.controlling && (
          <button
            class="desktop-stage__take-control"
            type="button"
            title={t("desktop.takeControl")}
            aria-label={t("desktop.takeControl")}
            disabled={props.state !== "connected"}
            onClick={props.onTakeControl}
          />
        )}
        {props.state === "connecting" && <DesktopLoading label={t("desktop.connecting")} overlay />}
      </div>
    </>
  );
}

export type DesktopSizingOptions = {
  mode: DesktopSizingMode;
  canResize: boolean;
  onChange: (mode: DesktopSizingMode) => void;
};

export function DesktopSizing(props: DesktopSizingOptions) {
  // Retain Match during reconnect so Fit can cancel it before authentication completes.
  return (
    <select
      class="desktop-sizing"
      aria-label={t("desktop.sizing")}
      title={t("desktop.matchRequirement")}
      onChange={(event) => {
        const mode = event.currentTarget.value;
        if (mode === "fit" || mode === "actual" || (mode === "match" && props.canResize)) {
          props.onChange(mode);
        }
      }}
    >
      <option value="fit" selected={props.mode === "fit"}>
        {t("desktop.fit")}
      </option>
      <option value="actual" selected={props.mode === "actual"}>
        {t("desktop.actual")}
      </option>
      {(props.canResize || props.mode === "match") && (
        <option value="match" selected={props.mode === "match"} disabled={!props.canResize}>
          {t("desktop.match")}
        </option>
      )}
    </select>
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
}) {
  return (
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
