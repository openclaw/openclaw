import { html, nothing, type TemplateResult } from "lit";
import { For, Show, createEffect } from "solid-js";
import { icons } from "../../../components/icons.ts";
import { McpAppUnmountGate } from "../../../components/mcp-app-unmount.ts";
import {
  PANEL_HOSTED_TABS_CHANGE_EVENT,
  type PanelHostedTab,
} from "../../../components/panel-hosted-tabs.ts";
import { renderPanelLoadingSkeleton } from "../../../components/panel-loading-skeleton.ts";
import { renderPanelTabStrip } from "../../../components/panel-tab-strip.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lit/solid-bridge.ts";
import { LitContent } from "../../../lit/solid-lit-content.tsx";
import { createSolidRenderLifecycle } from "../solid-render-lifecycle.ts";
import { renderAttachmentFileIcon } from "./chat-attachment-file-icon.ts";
import type { SessionWorkspacePreview } from "./chat-session-workspace-types.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";

type Props = {
  previews: SessionWorkspacePreview[];
  activeId: string | null;
  tabsInHeader: boolean;
  browser: TemplateResult | typeof nothing;
  renderDetail: ((content: SidebarContent) => TemplateResult) | null;
  onSelect: (id: string | null) => void;
  onClose: (id: string) => void;
};
type Methods = { selectHostedTab(id: string): void; closeHostedTab(id: string): Promise<void> };
export type ChatFilesPanel = SolidBridgeElement<Props, Methods> & {
  readonly hostedTabs: PanelHostedTab[];
  readonly activeHostedTabId: string | null;
  readonly hostedActions: TemplateResult;
};
let filesPanelSequence = 0;

/** The workspace owns tab order and selection; this view retains retiring app DOM. */
export const ChatFilesPanel = defineSolidBridge<Props, Methods>(
  "openclaw-chat-files-panel",
  (props, host) => {
    const contentId = `chat-files-content-${++filesPanelSequence}`;
    const appUnmount = new McpAppUnmountGate<Props>(
      { requestUpdate: () => lifecycle.invalidate() },
      () =>
        new Promise<void>((resolve) => {
          lifecycle.afterCommit(resolve, resolve);
        }),
    );
    const lifecycle = createSolidRenderLifecycle({
      host,
      presented: () => true,
      read: () => {
        const snapshot = {
          previews: props.previews,
          activeId: props.activeId,
          tabsInHeader: props.tabsInHeader,
          browser: props.browser,
          renderDetail: props.renderDetail,
          onSelect: props.onSelect,
          onClose: props.onClose,
        };
        const appKeys = new Set(
          snapshot.previews
            .filter((entry) => entry.content.kind === "mcp-app")
            .map((entry) => entry.id),
        );
        return appUnmount.render(
          JSON.stringify([...appKeys]),
          () => snapshot,
          () =>
            [...host.querySelectorAll<HTMLElement>("[data-app-tab-id]")].filter(
              (element) => !appKeys.has(element.dataset.appTabId ?? ""),
            ),
        );
      },
    });
    const rendered = lifecycle.snapshot;
    const hostedTabs = (): PanelHostedTab[] => {
      const tabs = props.previews.map(({ id, label, content }) => ({
        id,
        label,
        title: content.kind === "file" ? content.path : label,
        icon:
          content.kind === "mcp-app"
            ? icons.puzzle
            : renderAttachmentFileIcon({ filename: label, mode: "preview-with-favicon" }),
        className: content.kind === "loading" ? "is-connecting" : undefined,
      }));
      return props.activeId === null && tabs.length
        ? [{ id: "browse", label: t("chat.sidePanel.files"), icon: icons.folder }, ...tabs]
        : tabs;
    };
    const activeHostedTabId = () => props.activeId ?? (props.previews.length ? "browse" : null);
    const hostedActions = () =>
      html`<button
        class="rail-header__action"
        type="button"
        aria-label=${t("chat.sidePanel.files")}
        title=${t("chat.sidePanel.files")}
        @click=${() => props.onSelect(null)}
      >
        ${icons.folder}
      </button>`;
    Object.defineProperties(host, {
      hostedTabs: { configurable: true, get: hostedTabs },
      activeHostedTabId: { configurable: true, get: activeHostedTabId },
      hostedActions: { configurable: true, get: hostedActions },
    });
    host.selectHostedTab = (id) => props.onSelect(id === "browse" ? null : id);
    host.closeHostedTab = async (id) => {
      if (id === "browse") {
        props.onSelect(props.previews.at(-1)?.id ?? null);
      } else {
        props.onClose(id);
      }
    };
    createEffect(
      () =>
        JSON.stringify([
          activeHostedTabId(),
          t("chat.sidePanel.files"),
          hostedTabs().map(({ id, label, title, className }) => [id, label, title, className]),
        ]),
      () => {
        host.dispatchEvent(new CustomEvent(PANEL_HOSTED_TABS_CHANGE_EVENT, { bubbles: true }));
      },
    );
    return (
      <>
        <Show when={!rendered().tabsInHeader}>
          <header class="rail-header side-panel__header">
            <div class="side-panel__header-tabs">
              <LitContent
                value={renderPanelTabStrip({
                  tabs: hostedTabs().map((tab) => ({
                    id: tab.id,
                    label: tab.label,
                    title: tab.title,
                    icon: tab.icon,
                    className: tab.className,
                    domId: `${contentId}-tab-${tab.id}`,
                    closeLabel: `${t("browser.closeTab")}: ${tab.label}`,
                  })),
                  activeId: activeHostedTabId(),
                  ariaControls: contentId,
                  onSelect: (id) => host.selectHostedTab(id),
                  onClose: (id) => host.closeHostedTab(id),
                  onNew: () => props.onSelect(null),
                  newLabel: t("chat.sidePanel.files"),
                  newControl: hostedActions(),
                })}
              />
            </div>
          </header>
        </Show>
        <div id={contentId} class="chat-files-panel__content">
          <div class="chat-files-panel__page" hidden={rendered().activeId !== null}>
            <LitContent value={rendered().browser} />
          </div>
          <For each={rendered().previews} keyed={(preview) => preview.id}>
            {(preview) => {
              const entry = () => {
                rendered();
                return preview();
              };
              return (
                <div
                  class="chat-files-panel__page"
                  data-app-tab-id={entry().content.kind === "mcp-app" ? entry().id : undefined}
                  hidden={rendered().activeId !== entry().id}
                >
                  <LitContent
                    value={
                      entry().content.kind === "loading"
                        ? renderPanelLoadingSkeleton("files", t("common.loading"))
                        : entry().content.kind === "unavailable"
                          ? html`<div class="callout danger" role="alert">
                              ${entry().content.kind === "unavailable" ? entry().content.message : ""}
                            </div>`
                          : rendered().renderDetail?.(entry().content)
                    }
                  />
                </div>
              );
            }}
          </For>
        </div>
      </>
    );
  },
  {
    properties: {
      previews: { default: [], attribute: false },
      activeId: { default: null, attribute: false },
      tabsInHeader: { default: true, type: Boolean },
      browser: { default: nothing, attribute: false },
      renderDetail: { default: null, attribute: false },
      onSelect: { default: () => {}, attribute: false },
      onClose: { default: () => {}, attribute: false },
    },
    methods: { selectHostedTab: () => {}, closeHostedTab: async () => {} },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-files-panel": ChatFilesPanel;
  }
}
