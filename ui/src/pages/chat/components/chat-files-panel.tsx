import { dynamic, type JSX } from "@solidjs/web";
import { For, Show, createEffect, createMemo, onCleanup, refresh } from "solid-js";
import { createMcpAppUnmountGate } from "../../../components/mcp-app-unmount.ts";
import {
  notifyPanelHostedTabsChanged,
  type PanelHostedTab,
} from "../../../components/panel-hosted-tabs.ts";
import { PanelTabStrip } from "../../../components/panel-tab-strip-solid.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import { nativeListener } from "../../../lib/solid-native-listener.ts";
import { AttachmentFileIcon } from "./chat-attachment-file-icon-solid.tsx";
import type { SessionWorkspacePreview } from "./chat-session-workspace-types.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";

type Props = {
  previews: SessionWorkspacePreview[];
  activeId: string | null;
  tabsInHeader: boolean;
  browser: JSX.Element;
  renderDetail: ((props: { content: SidebarContent }) => JSX.Element) | null;
  onSelect: (id: string | null) => void;
  onClose: (id: string) => void;
};
type Methods = { selectHostedTab(id: string): void; closeHostedTab(id: string): Promise<void> };
type ChatFilesPanel = SolidBridgeElement<Props, Methods> & {
  readonly hostedTabs: PanelHostedTab[];
  readonly activeHostedTabId: string | null;
  readonly hostedActions: HTMLButtonElement;
};
let filesPanelSequence = 0;

/** The workspace owns tab order and selection; this view retains retiring app DOM. */
defineSolidBridge<Props, Methods>(
  "openclaw-chat-files-panel",
  (props, host) => {
    const contentId = `chat-files-content-${++filesPanelSequence}`;
    const pages = new Map<string, HTMLElement>();
    let completeCommit = () => {};
    const appUnmount = createMcpAppUnmountGate<Props>(
      () => void refresh(rendered),
      () =>
        new Promise<void>((resolve) => {
          completeCommit = resolve;
        }),
    );
    const rendered = createMemo(() => {
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
          [...pages].flatMap(([id, element]) =>
            element.hasAttribute("data-app-tab-id") && !appKeys.has(id) ? [element] : [],
          ),
      );
    });
    const Detail = dynamic(() => rendered().renderDetail ?? (() => null));
    createEffect(rendered, () => completeCommit());
    // Disposal also settles the gate; it restarts only views that remain connected.
    onCleanup(() => completeCommit());
    const hostedTabs = (): PanelHostedTab[] => {
      const tabs = props.previews.map(({ id, label, content }) => ({
        id,
        label,
        title: content.kind === "file" ? content.path : label,
        get icon() {
          return content.kind === "mcp-app" ? (
            <Icon name="puzzle" />
          ) : (
            <AttachmentFileIcon filename={label} mode="preview-with-favicon" />
          );
        },
        className: content.kind === "loading" ? "is-connecting" : undefined,
      }));
      return props.activeId === null && tabs.length
        ? [
            { id: "browse", label: t("chat.sidePanel.files"), icon: <Icon name="folder" /> },
            ...tabs,
          ]
        : tabs;
    };
    const activeHostedTabId = () => props.activeId ?? (props.previews.length ? "browse" : null);
    const tabStripTabs = createMemo(() =>
      hostedTabs().map((tab) => ({
        id: tab.id,
        label: tab.label,
        title: tab.title,
        icon: tab.icon,
        className: tab.className,
        domId: `${contentId}-tab-${tab.id}`,
        closeLabel: `${t("browser.closeTab")}: ${tab.label}`,
      })),
    );
    let browseAction!: HTMLButtonElement;
    const showBrowser = () => props.onSelect(null);
    // The hosted header moves this action outside the panel's delegated event root.
    const browseClick = nativeListener("click", showBrowser);
    <button
      ref={[(element) => (browseAction = element), browseClick]}
      class="rail-header__action"
      type="button"
      aria-label={t("chat.sidePanel.files")}
      title={t("chat.sidePanel.files")}
    >
      <Icon name="folder" />
    </button>;
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
              <openclaw-panel-tab-strip style={{ display: "contents" }}>
                <PanelTabStrip
                  tabs={tabStripTabs()}
                  activeId={activeHostedTabId()}
                  ariaControls={contentId}
                  onSelect={(id) => host.selectHostedTab(id)}
                  onClose={(id) => host.closeHostedTab(id)}
                  onNew={() => props.onSelect(null)}
                  newLabel={t("chat.sidePanel.files")}
                  newControl={hostedActions()}
                />
              </openclaw-panel-tab-strip>
            </div>
          </header>
        </Show>
        <div id={contentId} class="chat-files-panel__content">
          <div class="chat-files-panel__page" hidden={rendered().activeId !== null}>
            {rendered().browser}
          </div>
          <For each={rendered().previews} keyed={(preview) => preview.id}>
            {(preview) => {
              onCleanup(() => pages.delete(preview().id));
              const entry = () => {
                rendered();
                return preview();
              };
              const detail = () => {
                const content = entry().content;
                return content.kind === "loading" || content.kind === "unavailable"
                  ? undefined
                  : content;
              };
              return (
                <div
                  ref={(element) => pages.set(preview().id, element)}
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
                    <Show when={detail()}>{(content) => <Detail content={content()} />}</Show>
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
