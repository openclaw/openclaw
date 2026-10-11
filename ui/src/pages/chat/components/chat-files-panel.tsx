import { For, Show, createEffect, onCleanup } from "solid-js";
import { icons } from "../../../components/icons.ts";
import { McpAppUnmountGate } from "../../../components/mcp-app-unmount.ts";
import {
  notifyPanelHostedTabsChanged,
  type PanelHostedTab,
} from "../../../components/panel-hosted-tabs.ts";
import { renderPanelTabStrip } from "../../../components/panel-tab-strip.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import {
  defineSolidBridge,
  LitContent,
  type SolidBridgeElement,
} from "../../../lit/solid-bridge.ts";
import { createSolidRenderLifecycle } from "../solid-render-lifecycle.ts";
import { renderAttachmentFileIcon } from "./chat-attachment-file-icon.ts";
import type { SessionWorkspacePreview } from "./chat-session-workspace-types.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";

type Props = {
  previews: SessionWorkspacePreview[];
  activeId: string | null;
  tabsInHeader: boolean;
  /** Opaque output of the retained workspace renderer, consumed only by LitContent. */
  browser: unknown;
  renderDetail: ((content: SidebarContent) => unknown) | null;
  onSelect: (id: string | null) => void;
  onClose: (id: string) => void;
};
type Methods = { selectHostedTab(id: string): void; closeHostedTab(id: string): Promise<void> };
export type ChatFilesPanel = SolidBridgeElement<Props, Methods> & {
  readonly hostedTabs: PanelHostedTab[];
  readonly activeHostedTabId: string | null;
  readonly hostedActions: HTMLButtonElement;
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
          lifecycle.afterCommit((complete) => {
            resolve();
            complete();
          }, resolve);
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
    let browseAction!: HTMLButtonElement;
    const showBrowser = () => props.onSelect(null);
    <button
      ref={(element) => {
        browseAction = element;
        // The Lit header hosts this action outside Solid's delegated event root.
        browseAction.addEventListener("click", showBrowser);
      }}
      class="rail-header__action"
      type="button"
      aria-label={t("chat.sidePanel.files")}
      title={t("chat.sidePanel.files")}
    >
      <Icon name="folder" />
    </button>;
    onCleanup(() => browseAction.removeEventListener("click", showBrowser));
    const hostedActions = () => browseAction;
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
      () => [
        activeHostedTabId(),
        t("chat.sidePanel.files"),
        hostedTabs().map(({ id, label, title, className }) => [id, label, title, className]),
      ],
      (facts) => notifyPanelHostedTabsChanged(host, facts),
    );
    return (
      <>
        <Show when={!rendered().tabsInHeader}>
          <header class="rail-header side-panel__header">
            <div class="side-panel__header-tabs">
              <LitContent
                render={() =>
                  renderPanelTabStrip({
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
                  })
                }
              />
            </div>
          </header>
        </Show>
        <div id={contentId} class="chat-files-panel__content">
          <div class="chat-files-panel__page" hidden={rendered().activeId !== null}>
            <LitContent render={() => rendered().browser} />
          </div>
          <For each={rendered().previews} keyed={(preview) => preview.id}>
            {(preview) => {
              const entry = () => {
                rendered();
                return preview();
              };
              const renderDetail = () => {
                const content = entry().content;
                return content.kind === "loading" || content.kind === "unavailable"
                  ? undefined
                  : rendered().renderDetail?.(content);
              };
              return (
                <div
                  class="chat-files-panel__page"
                  data-app-tab-id={entry().content.kind === "mcp-app" ? entry().id : undefined}
                  hidden={rendered().activeId !== entry().id}
                >
                  {entry().content.kind === "loading" ? (
                    <PanelLoadingSkeleton variant="files" label={t("common.loading")} />
                  ) : entry().content.kind === "unavailable" ? (
                    <div class="callout danger" role="alert">
                      {(() => {
                        const content = entry().content;
                        return content.kind === "unavailable" ? content.message : "";
                      })()}
                    </div>
                  ) : (
                    <LitContent render={renderDetail} />
                  )}
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
      browser: { default: undefined, attribute: false },
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
