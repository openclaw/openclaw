import { createMemo } from "@solidjs/signals";
import type { JSX } from "@solidjs/web";
import { Match, Switch } from "solid-js";
import { registerBrowserEnglish } from "../../i18n/locales/en-browser.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { Icon } from "../solid/icon.tsx";
import { PanelEmptyState } from "../solid/panel-empty-state.tsx";
import { PanelLoadingSkeleton } from "../solid/panel-loading-skeleton.tsx";
import type { BrowserPanelController } from "./browser-panel-controller.ts";
import { BrowserPanelTabs } from "./browser-panel-tabs.tsx";

registerEnglishCatalog(registerBrowserEnglish);
export type BrowserPanelDock = "bottom" | "right";
type ControllerProps = { controller: BrowserPanelController };

function BrowserIconButton(props: {
  label: string;
  icon: Parameters<typeof Icon>[0]["name"] | "mousePointer";
  onClick: () => void;
  class?: JSX.IntrinsicElements["button"]["class"];
  title?: string;
  disabled?: boolean;
  busy?: boolean;
  newTab?: boolean;
}) {
  return (
    <button
      class={props.class ?? "bp-icon"}
      type="button"
      data-new-tab-action={props.newTab ? "" : undefined}
      title={props.title ?? props.label}
      aria-label={props.label}
      aria-busy={props.busy === undefined ? undefined : props.busy ? "true" : "false"}
      disabled={props.disabled}
      onClick={() => props.onClick()}
    >
      {props.icon === "mousePointer" ? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="m4 4 7.07 17 2.51-7.39L21 11.07z" />
        </svg>
      ) : (
        <Icon name={props.icon} />
      )}
    </button>
  );
}

function HeaderActions(
  props: ControllerProps & {
    dock: BrowserPanelDock;
    onDockChange: (dock: BrowserPanelDock) => void;
    onClose: () => void;
  },
) {
  const activeUrl = createMemo(
    () =>
      props.controller.native.activeTab?.url ||
      props.controller.view?.metrics?.url ||
      props.controller.view?.url ||
      props.controller.urlDraft,
  );
  return (
    <div class="rail-header__actions bp-actions">
      <span class="bp-dock-modes" role="group" aria-label={t("browser.title")}>
        <openclaw-tooltip
          prop:content={t(props.dock === "bottom" ? "browser.dockRight" : "browser.dockBottom")}
        >
          <BrowserIconButton
            class="rail-header__action bp-icon"
            label={t(props.dock === "bottom" ? "browser.dockRight" : "browser.dockBottom")}
            icon={props.dock === "bottom" ? "panelRightOpen" : "panelBottomOpen"}
            onClick={() => props.onDockChange(props.dock === "bottom" ? "right" : "bottom")}
          />
        </openclaw-tooltip>
      </span>
      <BrowserIconButton
        class="rail-header__action bp-icon"
        label={t("browser.openExternal")}
        icon="externalLink"
        newTab
        disabled={!activeUrl()}
        onClick={() => props.controller.openExternal()}
      />
      <BrowserIconButton
        class="rail-header__action bp-icon"
        label={t("browser.close")}
        icon="x"
        onClick={() => props.onClose()}
      />
    </div>
  );
}

function Toolbar(props: ControllerProps & { embedded: boolean }) {
  const nativeTab = createMemo(() => props.controller.native.activeTab);
  const hasView = createMemo(() => Boolean(nativeTab() || props.controller.view));
  return (
    <div class="bp-toolbar">
      {!nativeTab() &&
      !props.controller.host.fixedTab &&
      !props.controller.host.dashboardTarget?.sessionScoped &&
      props.controller.operations.route ? (
        <span
          class="bp-profile"
          title={t("browser.profile", { profile: props.controller.operations.route!.profile })}
        >
          {props.controller.operations.route!.profile}
        </span>
      ) : null}
      {props.embedded && !props.controller.host.fixedTab ? (
        <BrowserIconButton
          label={t("browser.newTab")}
          icon="plus"
          newTab
          onClick={() => props.controller.beginNewTab()}
        />
      ) : null}
      <BrowserIconButton
        label={t("browser.back")}
        icon="chevronLeft"
        disabled={
          nativeTab() ? !nativeTab()!.canGoBack : !hasView() || props.controller.evaluateUnavailable
        }
        onClick={() => props.controller.goHistory(-1)}
      />
      <BrowserIconButton
        label={t("browser.forward")}
        icon="chevronRight"
        disabled={
          nativeTab()
            ? !nativeTab()!.canGoForward
            : !hasView() || props.controller.evaluateUnavailable
        }
        onClick={() => props.controller.goHistory(1)}
      />
      <BrowserIconButton
        label={t(nativeTab()?.loading ? "browser.stop" : "browser.reload")}
        icon={nativeTab()?.loading ? "x" : "refresh"}
        busy={!nativeTab() && props.controller.loading}
        disabled={!props.controller.activeTargetId}
        onClick={() => props.controller.reloadPage()}
      />
      <input
        class="bp-url"
        type="text"
        spellcheck="false"
        autocomplete="off"
        disabled={Boolean(props.controller.host.fixedTab && !props.controller.activeTargetId)}
        placeholder={t("browser.urlPlaceholder")}
        value={props.controller.urlDraft}
        onFocus={(event) => {
          props.controller.urlDraftEditing = true;
          event.currentTarget.select();
        }}
        onBlur={() => {
          props.controller.urlDraftEditing = false;
        }}
        onInput={(event) => props.controller.setState("urlDraft", event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            props.controller.commitUrlDraft();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            props.controller.resetUrlDraftFromView();
            event.currentTarget.blur();
          }
        }}
      />
      {props.embedded ? (
        <BrowserIconButton
          label={t("browser.openExternal")}
          icon="externalLink"
          newTab
          disabled={!hasView()}
          onClick={() => props.controller.openExternal()}
        />
      ) : null}
      {!props.controller.host.dashboardTarget?.sessionScoped ? (
        <BrowserIconButton
          label={t(
            props.controller.download.pending ? "browser.downloading" : "browser.downloadFile",
          )}
          icon={props.controller.download.pending ? "loader" : "download"}
          busy={props.controller.download.pending}
          disabled={!props.controller.download.available}
          onClick={() => void props.controller.download.save()}
        />
      ) : null}
      <BrowserIconButton
        class={["bp-icon", { "is-active": props.controller.mode === "annotate" }]}
        label={t("browser.annotate")}
        icon="penLine"
        disabled={!hasView()}
        onClick={() => props.controller.setMode("annotate")}
      />
      <BrowserIconButton
        class={["bp-icon", { "is-active": props.controller.mode === "inspect" }]}
        label={t("browser.inspect")}
        title={t(
          !nativeTab() && props.controller.evaluateUnavailable
            ? "browser.inspectUnavailable"
            : "browser.inspect",
        )}
        icon="mousePointer"
        disabled={!hasView() || (!nativeTab() && props.controller.evaluateUnavailable)}
        onClick={() => props.controller.setMode("inspect")}
      />
    </div>
  );
}

function AnnotateBar(props: ControllerProps) {
  return (
    <div class="bp-annotatebar">
      <span class="bp-annotatebar__hint">{t("browser.annotateHint")}</span>
      <button
        class="bp-btn"
        type="button"
        disabled={props.controller.strokes.length === 0}
        onClick={() => props.controller.input.undoStroke()}
      >
        {t("browser.annotateUndo")}
      </button>
      <button
        class="bp-btn"
        type="button"
        disabled={props.controller.strokes.length === 0}
        onClick={() => props.controller.input.clearStrokes()}
      >
        {t("browser.annotateClear")}
      </button>
      <button
        class="bp-btn"
        type="button"
        title={t("browser.annotateDone")}
        onClick={() => props.controller.exitCaptureModes()}
      >
        <Icon name="x" />
      </button>
      <button
        class="bp-btn bp-btn--primary"
        type="button"
        disabled={props.controller.strokes.length === 0}
        onClick={() => void props.controller.input.sendAnnotation({})}
      >
        {t("browser.annotateSend")}
      </button>
    </div>
  );
}

function InspectTooltip(props: ControllerProps) {
  const node = createMemo(() => props.controller.inspected);
  const pointer = createMemo(() => props.controller.inspectPointer);
  return (
    <>
      {props.controller.mode === "inspect" && node() && pointer() ? (
        <div
          class="bp-tooltip"
          style={{
            left: `${Math.min(92, Math.max(0, pointer()!.x * 100))}%`,
            top: `${Math.min(92, Math.max(0, pointer()!.y * 100 + 2))}%`,
          }}
        >
          <div class="bp-tooltip__title">
            <span class="bp-tooltip__selector">
              {node()!.tag}
              {node()!.id ? `#${node()!.id}` : ""}
              {node()!
                .classes.map((name) => `.${name}`)
                .join("")}
            </span>
            <span class="bp-tooltip__size">
              {Math.round(node()!.rect.width)} × {Math.round(node()!.rect.height)}
            </span>
          </div>
          {node()!.name ? (
            <div class="bp-tooltip__row">
              <span>{t("browser.inspectName")}</span>
              <span>{node()!.name}</span>
            </div>
          ) : null}
          {node()!.role ? (
            <div class="bp-tooltip__row">
              <span>{t("browser.inspectRole")}</span>
              <span>{node()!.role}</span>
            </div>
          ) : null}
          <div class="bp-tooltip__row">
            <span>{t("browser.inspectFocusable")}</span>
            <span>{node()!.focusable ? "✓" : "–"}</span>
          </div>
        </div>
      ) : null}
    </>
  );
}

function ViewportContent(props: ControllerProps) {
  return (
    <Switch>
      <Match
        when={Boolean(props.controller.native.activeTab) && props.controller.mode === "interact"}
      >
        <div
          class="bp-stage bp-stage--native"
          aria-busy={props.controller.native.activeTab?.loading ? "true" : "false"}
        >
          {props.controller.native.activeTab?.loading ? (
            <span class="bp-native-loading" role="status">
              {t("browser.loading")}
            </span>
          ) : null}
        </div>
      </Match>
      <Match when={!props.controller.native.activeTab && props.controller.running === false}>
        <PanelEmptyState
          icon={<Icon name="globe" />}
          heading={t("chat.sidePanel.browser")}
          description={t("browser.notRunning")}
          action={
            props.controller.host.fixedTab ? undefined : (
              <button
                class="bp-btn"
                type="button"
                onClick={() => void props.controller.startBrowserNow()}
              >
                {t("browser.start")}
              </button>
            )
          }
        />
      </Match>
      <Match when={!props.controller.view && Boolean(props.controller.unavailableTabText)}>
        <div class="bp-status" role="status">
          {props.controller.unavailableTabText}
        </div>
      </Match>
      <Match when={!props.controller.view && props.controller.loading}>
        <PanelLoadingSkeleton variant="browser" label={t("browser.loading")} />
      </Match>
      <Match when={!props.controller.view}>
        <PanelEmptyState
          icon={<Icon name="globe" />}
          heading={t("chat.sidePanel.browser")}
          description={t("chat.sidePanel.browserEmpty")}
        />
      </Match>
      <Match when={Boolean(props.controller.view)}>
        <div class="bp-stage">
          <img
            class="bp-shot"
            src={props.controller.view!.dataUrl}
            alt={props.controller.view?.metrics?.title || ""}
          />
          <canvas
            class={[
              "bp-overlay",
              {
                "bp-overlay--annotate": props.controller.mode === "annotate",
                "bp-overlay--inspect": props.controller.mode === "inspect",
              },
            ]}
            onClick={(event) => props.controller.handleStageClick(event)}
            onPointerDown={(event) => props.controller.input.handleOverlayPointerDown(event)}
            onPointerMove={(event) => props.controller.handleOverlayPointerMove(event)}
            onPointerUp={(event) => props.controller.input.handleOverlayPointerUp(event)}
            onPointerCancel={(event) => props.controller.input.handleOverlayPointerUp(event)}
            onLostPointerCapture={(event) => props.controller.input.handleOverlayPointerUp(event)}
          />
          {props.controller.mode === "interact" ? (
            <textarea
              class="bp-overlay bp-input"
              aria-label={t("browser.inputLabel")}
              autocomplete="off"
              autocorrect="off"
              autocapitalize="off"
              spellcheck="false"
              onClick={(event) => props.controller.handleStageClick(event)}
              onContextMenu={(event) => props.controller.handleStageClick(event)}
              onBeforeInput={(event) => props.controller.input.handleTextInput(event)}
              onInput={(event) => props.controller.input.handleTextInput(event)}
              onCompositionStart={() => props.controller.input.handleCompositionStart()}
              onCompositionEnd={(event) => props.controller.input.handleCompositionEnd(event)}
              onPointerDown={(event) => props.controller.input.handleTouchPointerDown(event)}
              onPointerMove={(event) => props.controller.input.handleTouchPointerMove(event)}
              onPointerUp={(event) => props.controller.input.handleTouchPointerEnd(event)}
              onPointerCancel={(event) => props.controller.input.handleTouchPointerEnd(event)}
              onLostPointerCapture={(event) => props.controller.input.handleTouchPointerEnd(event)}
            />
          ) : null}
          <InspectTooltip controller={props.controller} />
        </div>
      </Match>
    </Switch>
  );
}

export function BrowserPanelChrome(
  props: ControllerProps & {
    dock: BrowserPanelDock;
    height: number;
    width: number;
    onDockChange: (dock: BrowserPanelDock) => void;
    onClose: () => void;
    resizer?: JSX.Element;
    embedded: boolean;
    tabsInHeader: boolean;
  },
) {
  const panelId = `browser-tab-panel-${generateUUID()}`;
  const rendersTabStrip = createMemo(
    () =>
      !props.controller.host.fixedTab &&
      (!props.embedded || (!props.tabsInHeader && props.controller.tabs.length > 0)),
  );
  return (
    <section
      class={["bp", `bp--${props.embedded ? "embedded" : props.dock}`]}
      style={
        props.embedded
          ? undefined
          : props.dock === "bottom"
            ? { height: `${props.height}px` }
            : { width: `${props.width}px` }
      }
      aria-label={t("browser.title")}
    >
      {!props.embedded ? props.resizer : null}
      {rendersTabStrip() ? (
        <header class="rail-header bp-header">
          <BrowserPanelTabs
            panelId={panelId}
            tabs={props.controller.tabs}
            activeTargetId={props.controller.activeTargetId}
            onSelect={(id) => void props.controller.selectTab(id)}
            onClose={(id) => props.controller.closeTab(id)}
            onNew={() => props.controller.beginNewTab()}
            hideNewControl={props.embedded}
          />
          {!props.embedded ? (
            <HeaderActions
              controller={props.controller}
              dock={props.dock}
              onDockChange={props.onDockChange}
              onClose={props.onClose}
            />
          ) : null}
        </header>
      ) : null}
      <Toolbar controller={props.controller} embedded={props.embedded} />
      {props.controller.mode === "annotate" ? <AnnotateBar controller={props.controller} /> : null}
      {props.controller.errorText ? (
        <div class="bp-note bp-note--error" role="alert">
          {props.controller.errorText}
        </div>
      ) : props.controller.noticeText ? (
        <div class="bp-note" role="status">
          {props.controller.noticeText}
        </div>
      ) : null}
      <wa-tab-panel
        ref={(element) => {
          // Remote scrolling must cancel local scrolling before the event bubbles.
          element.addEventListener("wheel", (event) => props.controller.handleWheel(event), {
            passive: false,
          });
        }}
        id={panelId}
        class="bp-viewport"
        name={props.controller.activeTargetId ?? "browser"}
        prop:active
        aria-labelledby={
          rendersTabStrip() && props.controller.activeTargetId
            ? `${panelId}-tab-${props.controller.activeTargetId}`
            : undefined
        }
        tabindex="0"
        onKeyDown={(event: KeyboardEvent) => props.controller.handleViewportKeydown(event)}
        onPaste={(event: ClipboardEvent) => props.controller.handleViewportPaste(event)}
        aria-busy={props.controller.loading ? "true" : "false"}
      >
        <ViewportContent controller={props.controller} />
      </wa-tab-panel>
    </section>
  );
}
