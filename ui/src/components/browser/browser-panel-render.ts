import { html, nothing, svg, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import { registerBrowserEnglish } from "../../i18n/locales/en-browser.ts";
import { renderDockDestinations } from "../dock-destination-controls.ts";
import { strokeIcon } from "../icons-tools.ts";
import { icons } from "../icons.ts";
import { renderPanelEmptyState } from "../panel-empty-state.ts";
import { renderPanelLoadingSkeleton } from "../panel-loading-skeleton.ts";
import type { BrowserPanelController } from "./browser-panel-controller.ts";
import { renderBrowserPanelTabs } from "./browser-panel-tabs.ts";

registerBrowserEnglish();

export type BrowserPanelDock = "bottom" | "right";

// Browser-only artwork stays with this lazy surface, outside the startup icon set.
const mousePointer = strokeIcon(svg`<path d="m4 4 7.07 17 2.51-7.39L21 11.07z" />`);

function renderIconButton(params: {
  label: string;
  icon: TemplateResult;
  onClick: () => void;
  className?: string;
  title?: string;
  disabled?: boolean;
  busy?: boolean;
  newTab?: boolean;
}) {
  return html`<button
    class=${params.className ?? "bp-icon"}
    type="button"
    ?data-new-tab-action=${params.newTab}
    title=${params.title ?? params.label}
    aria-label=${params.label}
    aria-busy=${params.busy ?? nothing}
    ?disabled=${params.disabled}
    @click=${params.onClick}
  >
    ${params.icon}
  </button>`;
}

function renderHeaderActions(
  controller: BrowserPanelController,
  dock: BrowserPanelDock,
  onDockChange: (dock: BrowserPanelDock) => void,
  onClose: () => void,
) {
  const activeUrl =
    controller.native.activeTab?.url ||
    controller.view?.metrics?.url ||
    controller.view?.url ||
    controller.urlDraft;
  return html`
    <div class="rail-header__actions bp-actions">
      ${renderDockDestinations({
        current: dock,
        groupClass: "bp-dock-modes",
        groupLabel: t("browser.title"),
        destinations: [
          {
            dock: "bottom",
            label: t("browser.dockBottom"),
            icon: icons.panelBottomOpen,
            className: "bp-icon",
          },
          {
            dock: "right",
            label: t("browser.dockRight"),
            icon: icons.panelRightOpen,
            className: "bp-icon",
          },
        ],
        onSelect: onDockChange,
      })}
      ${renderIconButton({
        className: "rail-header__action bp-icon",
        label: t("browser.openExternal"),
        icon: icons.externalLink,
        newTab: true,
        disabled: !activeUrl,
        onClick: () => controller.openExternal(),
      })}
      ${renderIconButton({
        className: "rail-header__action bp-icon",
        label: t("browser.close"),
        icon: icons.x,
        onClick: onClose,
      })}
    </div>
  `;
}

function renderToolbar(controller: BrowserPanelController, embedded: boolean) {
  const nativeTab = controller.native.activeTab;
  const hasView = Boolean(nativeTab || controller.view);
  return html`
    <div class="bp-toolbar">
      ${
        !nativeTab &&
        !controller.host.fixedTab &&
        !controller.host.dashboardTarget?.sessionScoped &&
        controller.operations.route
          ? html`<span
              class="bp-profile"
              title=${t("browser.profile", { profile: controller.operations.route.profile })}
              >${controller.operations.route.profile}</span
            >`
          : nothing
      }
      ${
        embedded && !controller.host.fixedTab
          ? renderIconButton({
              label: t("browser.newTab"),
              icon: icons.plus,
              newTab: true,
              onClick: () => controller.beginNewTab(),
            })
          : nothing
      }
      ${renderIconButton({
        label: t("browser.back"),
        icon: icons.chevronLeft,
        disabled: nativeTab ? !nativeTab.canGoBack : !hasView || controller.evaluateUnavailable,
        onClick: () => controller.goHistory(-1),
      })}
      ${renderIconButton({
        label: t("browser.forward"),
        icon: icons.chevronRight,
        disabled: nativeTab ? !nativeTab.canGoForward : !hasView || controller.evaluateUnavailable,
        onClick: () => controller.goHistory(1),
      })}
      ${renderIconButton({
        label: t(nativeTab?.loading ? "browser.stop" : "browser.reload"),
        icon: nativeTab?.loading ? icons.x : icons.refresh,
        busy: !nativeTab && controller.loading,
        disabled: !controller.activeTargetId,
        onClick: () => controller.reloadPage(),
      })}
      <input
        class="bp-url"
        type="text"
        spellcheck="false"
        autocomplete="off"
        ?disabled=${Boolean(controller.host.fixedTab && !controller.activeTargetId)}
        placeholder=${t("browser.urlPlaceholder")}
        .value=${controller.urlDraft}
        @focus=${(event: FocusEvent) => {
          controller.urlDraftEditing = true;
          (event.target as HTMLInputElement).select();
        }}
        @blur=${() => {
          controller.urlDraftEditing = false;
        }}
        @input=${(event: InputEvent) =>
          controller.setState("urlDraft", (event.target as HTMLInputElement).value)}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === "Enter") {
            event.preventDefault();
            controller.commitUrlDraft();
            (event.target as HTMLInputElement).blur();
          } else if (event.key === "Escape") {
            controller.resetUrlDraftFromView();
            (event.target as HTMLInputElement).blur();
          }
        }}
      />
      ${
        embedded
          ? renderIconButton({
              label: t("browser.openExternal"),
              icon: icons.externalLink,
              newTab: true,
              disabled: !hasView,
              onClick: () => controller.openExternal(),
            })
          : nothing
      }
      ${
        controller.host.dashboardTarget?.sessionScoped
          ? nothing
          : renderIconButton({
              label: t(
                controller.download.pending ? "browser.downloading" : "browser.downloadFile",
              ),
              icon: controller.download.pending ? icons.loader : icons.download,
              busy: controller.download.pending,
              disabled: !controller.download.available,
              onClick: () => void controller.download.save(),
            })
      }
      ${renderIconButton({
        className: `bp-icon ${controller.mode === "annotate" ? "is-active" : ""}`,
        label: t("browser.annotate"),
        icon: icons.penLine,
        disabled: !hasView,
        onClick: () => controller.setMode("annotate"),
      })}
      ${renderIconButton({
        className: `bp-icon ${controller.mode === "inspect" ? "is-active" : ""}`,
        label: t("browser.inspect"),
        title:
          !nativeTab && controller.evaluateUnavailable
            ? t("browser.inspectUnavailable")
            : t("browser.inspect"),
        icon: mousePointer,
        disabled: !hasView || (!nativeTab && controller.evaluateUnavailable),
        onClick: () => controller.setMode("inspect"),
      })}
    </div>
  `;
}

function renderAnnotateBar(controller: BrowserPanelController) {
  if (controller.mode !== "annotate") {
    return nothing;
  }
  return html`
    <div class="bp-annotatebar">
      <span class="bp-annotatebar__hint">${t("browser.annotateHint")}</span>
      <button
        class="bp-btn"
        type="button"
        ?disabled=${controller.strokes.length === 0}
        @click=${() => controller.input.undoStroke()}
      >
        ${t("browser.annotateUndo")}
      </button>
      <button
        class="bp-btn"
        type="button"
        ?disabled=${controller.strokes.length === 0}
        @click=${() => controller.input.clearStrokes()}
      >
        ${t("browser.annotateClear")}
      </button>
      <button
        class="bp-btn"
        type="button"
        title=${t("browser.annotateDone")}
        @click=${() => controller.exitCaptureModes()}
      >
        ${icons.x}
      </button>
      <button
        class="bp-btn bp-btn--primary"
        type="button"
        ?disabled=${controller.strokes.length === 0}
        @click=${() => void controller.input.sendAnnotation({})}
      >
        ${t("browser.annotateSend")}
      </button>
    </div>
  `;
}

function renderInspectTooltip(controller: BrowserPanelController) {
  const node = controller.inspected;
  const pointer = controller.inspectPointer;
  if (controller.mode !== "inspect" || !node || !pointer) {
    return nothing;
  }
  const left = `${Math.min(92, Math.max(0, pointer.x * 100))}%`;
  const top = `${Math.min(92, Math.max(0, pointer.y * 100 + 2))}%`;
  const classes = node.classes.map((className) => `.${className}`).join("");
  return html`
    <div class="bp-tooltip" style="left:${left};top:${top}">
      <div class="bp-tooltip__title">
        <span class="bp-tooltip__selector"
          >${node.tag}${node.id ? `#${node.id}` : ""}${classes}</span
        >
        <span class="bp-tooltip__size"
          >${Math.round(node.rect.width)} × ${Math.round(node.rect.height)}</span
        >
      </div>
      ${
        node.name
          ? html`<div class="bp-tooltip__row">
              <span>${t("browser.inspectName")}</span><span>${node.name}</span>
            </div>`
          : nothing
      }
      ${
        node.role
          ? html`<div class="bp-tooltip__row">
              <span>${t("browser.inspectRole")}</span><span>${node.role}</span>
            </div>`
          : nothing
      }
      <div class="bp-tooltip__row">
        <span>${t("browser.inspectFocusable")}</span><span>${node.focusable ? "✓" : "–"}</span>
      </div>
    </div>
  `;
}

function renderViewportContent(controller: BrowserPanelController) {
  if (controller.native.activeTab && controller.mode === "interact") {
    return html`<div
      class="bp-stage bp-stage--native"
      aria-busy=${controller.native.activeTab.loading}
    >
      ${controller.native.activeTab.loading ? html`<span class="bp-native-loading" role="status">${t("browser.loading")}</span>` : nothing}
    </div>`;
  }
  if (!controller.native.activeTab && controller.running === false) {
    return renderPanelEmptyState({
      icon: icons.globe,
      heading: t("chat.sidePanel.browser"),
      description: t("browser.notRunning"),
      action: controller.host.fixedTab
        ? nothing
        : html`
            <button class="bp-btn" type="button" @click=${() => void controller.startBrowserNow()}>
              ${t("browser.start")}
            </button>
          `,
    });
  }
  if (!controller.view && controller.unavailableTabText) {
    return html`<div class="bp-status" role="status">${controller.unavailableTabText}</div>`;
  }
  if (!controller.view) {
    return controller.loading
      ? renderPanelLoadingSkeleton("browser", t("browser.loading"))
      : renderPanelEmptyState({
          icon: icons.globe,
          heading: t("chat.sidePanel.browser"),
          description: t("chat.sidePanel.browserEmpty"),
        });
  }
  const overlayMode =
    controller.mode === "annotate"
      ? "bp-overlay--annotate"
      : controller.mode === "inspect"
        ? "bp-overlay--inspect"
        : "";
  return html`
    <div class="bp-stage">
      <img
        class="bp-shot"
        src=${controller.view.dataUrl}
        alt=${controller.view.metrics?.title || ""}
      />
      <canvas
        class="bp-overlay ${overlayMode}"
        @click=${(event: MouseEvent) => controller.handleStageClick(event)}
        @pointerdown=${(event: PointerEvent) => controller.input.handleOverlayPointerDown(event)}
        @pointermove=${(event: PointerEvent) => controller.handleOverlayPointerMove(event)}
        @pointerup=${(event: PointerEvent) => controller.input.handleOverlayPointerUp(event)}
        @pointercancel=${(event: PointerEvent) => controller.input.handleOverlayPointerUp(event)}
        @lostpointercapture=${(event: PointerEvent) => controller.input.handleOverlayPointerUp(event)}
      ></canvas>
      ${
        controller.mode === "interact"
          ? html`<textarea
              class="bp-overlay bp-input"
              aria-label=${t("browser.inputLabel")}
              autocomplete="off"
              autocorrect="off"
              autocapitalize="off"
              spellcheck="false"
              @click=${(event: MouseEvent) => controller.handleStageClick(event)}
              @contextmenu=${(event: MouseEvent) => controller.handleStageClick(event)}
              @beforeinput=${(event: InputEvent) => controller.input.handleTextInput(event)}
              @input=${(event: InputEvent) => controller.input.handleTextInput(event)}
              @compositionstart=${() => controller.input.handleCompositionStart()}
              @compositionend=${(event: CompositionEvent) => controller.input.handleCompositionEnd(event)}
              @pointerdown=${(event: PointerEvent) => controller.input.handleTouchPointerDown(event)}
              @pointermove=${(event: PointerEvent) => controller.input.handleTouchPointerMove(event)}
              @pointerup=${(event: PointerEvent) => controller.input.handleTouchPointerEnd(event)}
              @pointercancel=${(event: PointerEvent) => controller.input.handleTouchPointerEnd(event)}
              @lostpointercapture=${(event: PointerEvent) => controller.input.handleTouchPointerEnd(event)}
            ></textarea>`
          : nothing
      }
      ${renderInspectTooltip(controller)}
    </div>
  `;
}

function renderViewport(controller: BrowserPanelController, rendersTabStrip: boolean) {
  // A native function avoids Chromium's blocked-input diagnostic crash on Lit listeners.
  return html`
    <wa-tab-panel
      id="browser-tab-panel"
      class="bp-viewport"
      name=${controller.activeTargetId ?? "browser"}
      active
      aria-labelledby=${
        rendersTabStrip && controller.activeTargetId
          ? `browser-tab-${controller.activeTargetId}`
          : nothing
      }
      tabindex="0"
      .onwheel=${(event: WheelEvent) => controller.handleWheel(event)}
      @keydown=${(event: KeyboardEvent) => controller.handleViewportKeydown(event)}
      @paste=${(event: ClipboardEvent) => controller.handleViewportPaste(event)}
      aria-busy=${controller.loading ? "true" : "false"}
    >
      ${renderViewportContent(controller)}
    </wa-tab-panel>
  `;
}

export function renderBrowserPanelChrome(
  controller: BrowserPanelController,
  dock: BrowserPanelDock,
  height: number,
  width: number,
  onDockChange: (dock: BrowserPanelDock) => void,
  onClose: () => void,
  resizer: TemplateResult | typeof nothing,
  embedded = false,
  tabsInHeader = false,
) {
  const style = embedded ? nothing : dock === "bottom" ? `height:${height}px` : `width:${width}px`;
  const rendersTabStrip =
    !controller.host.fixedTab && (!embedded || (!tabsInHeader && controller.tabs.length > 0));
  return html`
    <section
      class="bp bp--${embedded ? "embedded" : dock}"
      style=${style}
      aria-label=${t("browser.title")}
    >
      ${embedded ? nothing : resizer}
      ${
        rendersTabStrip
          ? html`<header class="rail-header bp-header">
              ${renderBrowserPanelTabs({
                tabs: controller.tabs,
                activeTargetId: controller.activeTargetId,
                onSelect: (targetId) => void controller.selectTab(targetId),
                onClose: (targetId) => controller.closeTab(targetId),
                onNew: () => controller.beginNewTab(),
                hideNewControl: embedded,
              })}
              ${embedded ? nothing : renderHeaderActions(controller, dock, onDockChange, onClose)}
            </header>`
          : nothing
      }
      ${renderToolbar(controller, embedded)} ${renderAnnotateBar(controller)}
      ${
        controller.errorText
          ? html`<div class="bp-note bp-note--error" role="alert">${controller.errorText}</div>`
          : controller.noticeText
            ? html`<div class="bp-note" role="status">${controller.noticeText}</div>`
            : nothing
      }
      ${renderViewport(controller, rendersTabStrip)}
    </section>
  `;
}
