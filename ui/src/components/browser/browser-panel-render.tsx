import { createMemo } from "@solidjs/signals";
import type { JSX } from "@solidjs/web";
import { For, Match, onSettled, Switch } from "solid-js";
import { registerBrowserEnglish } from "../../i18n/locales/en-browser.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { createTabFocus } from "../../lib/tabs.ts";
import { generateUUID } from "../../lib/uuid.ts";
import type { LinkFaviconFetcher } from "../../pages/chat/link-favicon-cache.ts";
import { PanelTabStrip } from "../panel-tab-strip-solid.tsx";
import { Icon } from "../solid/icon.tsx";
import { PanelEmptyState } from "../solid/panel-empty-state.tsx";
import { PanelIconButton } from "../solid/panel-icon-button.tsx";
import { PanelLoadingSkeleton } from "../solid/panel-loading-skeleton.tsx";
import type { BrowserPanel } from "./browser-panel-owner.ts";
import { browserPanelHostedTabs } from "./browser-panel-tabs.ts";
import { BrowserToolbar } from "./browser-panel-toolbar.tsx";
import "../../styles/session-panel-rail.css";

registerEnglishCatalog(registerBrowserEnglish);
export type BrowserPanelDock = "bottom" | "right";
type ControllerProps = { controller: BrowserPanel };

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
          <PanelIconButton
            class="rail-header__action bp-icon"
            label={t(props.dock === "bottom" ? "browser.dockRight" : "browser.dockBottom")}
            icon={<Icon name={props.dock === "bottom" ? "panelRightOpen" : "panelBottomOpen"} />}
            onClick={() => props.onDockChange(props.dock === "bottom" ? "right" : "bottom")}
          />
        </openclaw-tooltip>
      </span>
      <PanelIconButton
        class="rail-header__action bp-icon"
        label={t("browser.openExternal")}
        icon={<Icon name="externalLink" />}
        newTab
        disabled={!activeUrl()}
        onClick={() => props.controller.openExternal()}
      />
      <PanelIconButton
        class="rail-header__action bp-icon"
        label={t("browser.close")}
        icon={<Icon name="x" />}
        onClick={() => props.onClose()}
      />
    </div>
  );
}

function AnnotateBar(props: ControllerProps) {
  return (
    <div class="bp-annotatebar">
      <span class="bp-annotatebar__hint">{t("browser.annotateHint")}</span>
      <For each={["undoStroke", "clearStrokes"] as const}>
        {(action) => (
          <button
            class="bp-btn"
            type="button"
            disabled={props.controller.strokes.length === 0}
            onClick={() => props.controller.input[action]()}
          >
            {t(action === "undoStroke" ? "browser.annotateUndo" : "browser.annotateClear")}
          </button>
        )}
      </For>
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

function NativeViewport(props: ControllerProps) {
  let stage!: HTMLDivElement;
  // Native geometry retains this viewport’s synchronous presentation owner.
  onSettled(() => props.controller.native.presentation.mountStage(stage));
  return (
    <div
      ref={(element) => (stage = element)}
      class="bp-stage bp-stage--native"
      aria-busy={props.controller.native.activeTab?.loading ? "true" : "false"}
    >
      {props.controller.native.activeTab?.loading ? (
        <span class="bp-native-loading" role="status">
          {t("browser.loading")}
        </span>
      ) : null}
    </div>
  );
}

function ViewportContent(
  props: ControllerProps & { mobilePresentation?: boolean; emptyError: boolean },
) {
  const remoteInput = () =>
    props.controller.native.activeTab ? undefined : props.controller.input;
  onSettled(() => {
    const input = props.controller.input;
    return () => (input.elements = {});
  });
  return (
    <Switch>
      <Match
        when={Boolean(props.controller.native.activeTab) && props.controller.mode === "interact"}
      >
        <NativeViewport controller={props.controller} />
      </Match>
      <Match when={props.emptyError}>
        <PanelEmptyState
          presentation="desktop"
          icon={<Icon name="globe" />}
          heading={t("browser.loadFailed")}
          description={props.controller.errorText!}
          action={
            <button
              class="bp-btn bp-empty-action"
              type="button"
              disabled={props.controller.loading}
              onClick={() => void props.controller.retryEmptyError()}
            >
              <Icon name="refresh" />
              {t(
                props.controller.errorRetry
                  ? "common.retry"
                  : props.controller.running === false && !props.controller.host.fixedTab
                    ? "browser.start"
                    : "common.refresh",
              )}
            </button>
          }
        />
      </Match>
      <Match
        when={
          !props.controller.native.activeTab &&
          props.controller.running === false &&
          !props.controller.loading
        }
      >
        <PanelEmptyState
          presentation={props.mobilePresentation ? undefined : "desktop"}
          icon={<Icon name="globe" />}
          heading={t("chat.sidePanel.browser")}
          description={t("browser.notRunning")}
          action={
            props.controller.host.fixedTab ? undefined : (
              <button
                class={["bp-btn", { "bp-empty-action": !props.mobilePresentation }]}
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
        {props.mobilePresentation ? (
          <div class="bp-status" role="status">
            {props.controller.unavailableTabText}
          </div>
        ) : (
          <PanelEmptyState
            presentation="desktop"
            icon={<Icon name="globe" />}
            heading={t("chat.sidePanel.browser")}
            description={props.controller.unavailableTabText!}
          />
        )}
      </Match>
      <Match when={!props.controller.view && props.controller.loading}>
        <PanelLoadingSkeleton variant="browser" label={t("browser.loading")} />
      </Match>
      <Match when={!props.controller.view}>
        <PanelEmptyState
          presentation={props.mobilePresentation ? undefined : "desktop"}
          icon={<Icon name="globe" />}
          heading={t("chat.sidePanel.browser")}
          description={t("chat.sidePanel.browserEmpty")}
        />
      </Match>
      <Match when={Boolean(props.controller.view)}>
        <div class="bp-stage" ref={(element) => (props.controller.input.elements.stage = element)}>
          <img
            class="bp-shot"
            src={props.controller.view!.dataUrl}
            alt={props.controller.view?.metrics?.title || ""}
          />
          <canvas
            ref={(element) => (props.controller.input.elements.overlay = element)}
            class={[
              "bp-overlay",
              {
                "bp-overlay--annotate": props.controller.mode === "annotate",
                "bp-overlay--inspect": props.controller.mode === "inspect",
              },
            ]}
            onClick={(event) => remoteInput()?.handleStageClick(event)}
            onPointerDown={(event) => props.controller.input.handleOverlayPointerDown(event)}
            onPointerMove={(event) => props.controller.handleOverlayPointerMove(event)}
            onPointerUp={(event) => props.controller.input.handleOverlayPointerUp(event)}
            onPointerCancel={(event) => props.controller.input.handleOverlayPointerUp(event)}
            onLostPointerCapture={(event) => props.controller.input.handleOverlayPointerUp(event)}
          />
          {props.controller.mode === "interact" ? (
            <textarea
              ref={(element) => (props.controller.input.elements.input = element)}
              class="bp-overlay bp-input"
              aria-label={t("browser.inputLabel")}
              autocomplete="off"
              autocorrect="off"
              autocapitalize="off"
              spellcheck="false"
              onClick={(event) => remoteInput()?.handleStageClick(event)}
              onContextMenu={(event) => remoteInput()?.handleStageClick(event)}
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
    mobilePresentation?: boolean;
    fetchFavicon?: LinkFaviconFetcher;
  },
) {
  const remoteInput = () =>
    props.controller.native.activeTab ? undefined : props.controller.input;
  onSettled(() => {
    const controller = props.controller;
    const viewport = controller.input.elements.viewport!;
    const observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(([entry]) => {
            if (entry) {
              controller.handleViewportResize(entry.contentRect.width, entry.contentRect.height);
            }
          })
        : undefined;
    observer?.observe(viewport);
    // SAFETY: Native wheel events are WheelEvents; cancel local scrolling before they bubble.
    const handleWheel = (event: Event) => remoteInput()?.handleWheel(event as WheelEvent);
    const stopWheel = listen(viewport, "wheel", handleWheel, { passive: false });
    return () => {
      observer?.disconnect();
      stopWheel();
    };
  });
  const panelId = `browser-tab-panel-${generateUUID()}`;
  const tabFocus = createTabFocus();
  const rendersTabStrip = createMemo(
    () =>
      !props.controller.host.fixedTab &&
      (!props.embedded || (!props.tabsInHeader && props.controller.tabs.length > 0)),
  );
  function BrowserTabs() {
    const sourceTabs = createMemo(() => props.controller.tabs);
    const tabs = createMemo(() =>
      browserPanelHostedTabs(sourceTabs(), document).map((tab, index) => ({
        id: tab.id,
        domId: `${panelId}-tab-${tab.id}`,
        label: tab.label,
        title: `${t(sourceTabs()[index]?.kind === "native" ? "browser.nativeTab" : "browser.remoteTab")}: ${tab.url}`,
        icon: tab.favicon ? (
          <img class="tabstrip-tab__favicon" src={tab.favicon} alt="" />
        ) : (
          tab.icon
        ),
        closeLabel: `${t("browser.closeTab")}: ${tab.label}`,
      })),
    );
    return (
      <PanelTabStrip
        focusOwner={tabFocus}
        tabs={tabs()}
        activeId={props.controller.activeTargetId}
        ariaControls={panelId}
        onSelect={(id) => void props.controller.selectTab(id)}
        onClose={(id) => props.controller.closeTab(id)}
        onNew={() => props.controller.beginNewTab()}
        newLabel={t("browser.newTab")}
        newTabAction
        newControl={props.embedded ? null : undefined}
      />
    );
  }

  // Keep a usable page visible when an action fails. Only an empty desktop
  // viewport replaces its placeholder with the owner's actual failure.
  const emptyError = () =>
    !props.mobilePresentation &&
    !props.controller.native.activeTab &&
    !props.controller.view &&
    Boolean(props.controller.errorText);
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
          <BrowserTabs />
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
      <BrowserToolbar
        controller={props.controller}
        mobilePresentation={props.mobilePresentation}
        fetchFavicon={props.fetchFavicon}
      />
      {props.controller.mode === "annotate" ? <AnnotateBar controller={props.controller} /> : null}
      {props.controller.errorText ? (
        emptyError() ? null : (
          <div class="bp-note bp-note--error" role="alert">
            {props.controller.errorText}
          </div>
        )
      ) : props.controller.noticeText ? (
        <div class="bp-note" role="status">
          {props.controller.noticeText}
        </div>
      ) : null}
      <div
        ref={(element) => (props.controller.input.elements.viewport = element)}
        id={panelId}
        class="bp-viewport"
        role="tabpanel"
        aria-hidden="false"
        aria-labelledby={
          rendersTabStrip() && props.controller.activeTargetId
            ? `${panelId}-tab-${props.controller.activeTargetId}`
            : undefined
        }
        tabindex="0"
        onKeyDown={(event: KeyboardEvent) => remoteInput()?.handleViewportKeydown(event)}
        onPaste={(event: ClipboardEvent) => remoteInput()?.handleViewportPaste(event)}
        aria-busy={props.controller.loading ? "true" : "false"}
      >
        <ViewportContent
          controller={props.controller}
          mobilePresentation={props.mobilePresentation}
          emptyError={emptyError()}
        />
      </div>
    </section>
  );
}
