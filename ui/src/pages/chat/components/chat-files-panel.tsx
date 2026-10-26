import { dynamic, type JSX } from "@solidjs/web";
import {
  Errored,
  For,
  Loading,
  Show,
  createMemo,
  createSignal,
  onSettled,
  refresh,
} from "solid-js";
import { createMcpAppUnmountGate } from "../../../components/mcp-app-unmount.ts";
import {
  notifyPanelHostedTabsChanged,
  type PanelHostedTab,
} from "../../../components/panel-hosted-tabs.ts";
import { PanelTabStrip } from "../../../components/panel-tab-strip-solid.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import "../../../components/resizable-divider.ts";
import { PanelEmptyState } from "../../../components/solid/panel-empty-state.tsx";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import { createTextOverflow } from "../../../components/solid/text-overflow.ts";
import { i18n } from "../../../i18n/index.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { projectI18n, t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import { nativeListener } from "../../../lib/solid-native-listener.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { createTabFocus } from "../../../lib/tabs.ts";
import { AttachmentFileIcon } from "./chat-attachment-file-icon-solid.tsx";
import { SessionWorkspaceRail } from "./chat-session-workspace-rail-solid.tsx";
import type { SessionWorkspacePreview, SidebarContent } from "./chat-sidebar-content-types.ts";
import { SidebarFileMobileRail } from "./chat-sidebar-file-mobile.tsx";
import type { SessionWorkspaceProps } from "./chat-sidebar-view-types.ts";

type Props = {
  sessionKey: string;
  previews: SessionWorkspacePreview[];
  activeId: string | null;
  tabsInHeader: boolean;
  presentation: SessionWorkspaceProps["presentation"];
  treeVisible: boolean;
  folderView: boolean;
  workspace?: SessionWorkspaceProps;
  browserPresented: () => boolean;
  renderDetail: ((props: { content: SidebarContent; previewId: string }) => JSX.Element) | null;
  onSelect: (id: string | null) => void;
  onClose: (id: string) => void | boolean | Promise<boolean>;
};
type Methods = { selectHostedTab(id: string): void; closeHostedTab(id: string): Promise<void> };
type ChatFilesPanel = SolidBridgeElement<Props, Methods> & {
  readonly hostedTabs: PanelHostedTab[];
  readonly activeHostedTabId: string | null;
  readonly hostedActions: HTMLButtonElement;
};
let filesPanelSequence = 0;
const hostedTabNotifiers = new WeakMap<HTMLElement, () => void>();
const FILE_COLUMN_MIN_WIDTH = 176;

/** The workspace owns tab order and selection; this view retains retiring app DOM. */
export const ChatFilesPanel = defineSolidBridge<Props, Methods>(
  "openclaw-chat-files-panel",
  (props, host) => {
    const contentId = `chat-files-content-${++filesPanelSequence}`;
    const tabFocus = createTabFocus();
    const pages = new Map<string, HTMLElement>();
    const pageRef = (id: string) =>
      elementRef((element: HTMLDivElement) => {
        pages.set(id, element);
        return () => pages.delete(id);
      });
    let contentElement!: HTMLDivElement;
    let catalog!: HTMLDivElement;
    // Local geometry survives file navigation, but not a change of session.
    const [treeWidth, setTreeWidth] = createSignal(() => {
      void props.sessionKey;
      return 240;
    });
    const [contentWidth, setContentWidth] = createSignal(0);
    onSettled(() => {
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          setContentWidth(entry.contentRect.width);
        }
      });
      observer.observe(contentElement);
      return () => observer.disconnect();
    });
    const physicalRatio = (width: number, total: number) =>
      getComputedStyle(contentElement).direction === "rtl" ? 1 - width / total : width / total;
    const appUnmount = createMcpAppUnmountGate<Omit<Props, "workspace" | "browserPresented">>(
      () => void refresh(rendered),
    );
    const rendered = createMemo(() => {
      const snapshot = {
        sessionKey: props.sessionKey,
        previews: props.previews,
        activeId: props.activeId,
        tabsInHeader: props.tabsInHeader,
        presentation: props.presentation,
        treeVisible: props.treeVisible,
        folderView: props.folderView,
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
    const reading = createMemo(() => {
      const snapshot = rendered();
      const preview = snapshot.previews.find((entry) => entry.id === snapshot.activeId);
      return (
        snapshot.presentation === "desktop" &&
        snapshot.activeId !== null &&
        !snapshot.folderView &&
        (preview?.content.kind === "file" ||
          preview?.content.kind === "loading" ||
          preview?.content.kind === "unavailable" ||
          ((preview?.content.kind === "image" ||
            preview?.content.kind === "attachment" ||
            preview?.content.kind === "markdown") &&
            preview.content.file !== undefined))
      );
    });
    const Detail = dynamic(() => rendered().renderDetail ?? (() => null));
    const hostedTabs = (): PanelHostedTab[] => {
      const tabs = props.previews.map(({ id, label, content, pinned }) => ({
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
        className:
          [content.kind === "loading" ? "is-connecting" : "", pinned === false ? "is-preview" : ""]
            .filter(Boolean)
            .join(" ") || undefined,
      }));
      return props.activeId === null && tabs.length
        ? [
            {
              id: "browse",
              label: t("chat.sidePanel.files"),
              get icon() {
                return <Icon name="folder" />;
              },
            },
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
        await props.onClose(id);
      }
    };
    const translation = projectI18n(i18n);
    onSettled(() => {
      let queued = false;
      const notify = () => {
        if (queued) {
          return;
        }
        queued = true;
        queueMicrotask(() => {
          queued = false;
          if (hostedTabNotifiers.get(host) === notify && host.isConnected) {
            notifyPanelHostedTabsChanged(host, [
              activeHostedTabId(),
              t("chat.sidePanel.files"),
              hostedTabs().map(({ id, label, title, className }) => [id, label, title, className]),
            ]);
          }
        });
      };
      hostedTabNotifiers.set(host, notify);
      const stop = translation.subscribe(notify);
      notify();
      return () => {
        hostedTabNotifiers.delete(host);
        stop();
      };
    });
    return (
      <>
        <Show when={!rendered().tabsInHeader}>
          <header class="rail-header side-panel__header">
            <div class="side-panel__header-tabs">
              <openclaw-panel-tab-strip style={{ display: "contents" }}>
                <PanelTabStrip
                  focusOwner={tabFocus}
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
        <div
          ref={(element) => (contentElement = element)}
          id={contentId}
          class={["chat-files-panel__content", { "chat-files-panel__content--reading": reading() }]}
          data-tree-open={rendered().treeVisible ? "true" : "false"}
          style={{
            "--file-tree-preferred-width": `${treeWidth()}px`,
            "--file-column-min-width": `${FILE_COLUMN_MIN_WIDTH}px`,
          }}
        >
          <div
            ref={(element) => (catalog = element)}
            class="chat-files-panel__page chat-files-panel__catalog"
            inert={reading() && !rendered().treeVisible}
            hidden={
              !reading() &&
              rendered().activeId !== null &&
              !rendered().previews.find((entry) => entry.id === rendered().activeId)?.catalogVisible
            }
          >
            <ContentPresentation value={() => props.browserPresented()}>
              <SessionWorkspaceRail workspace={props.workspace} />
            </ContentPresentation>
          </div>
          <Show
            when={reading() && rendered().treeVisible && contentWidth() > FILE_COLUMN_MIN_WIDTH * 2}
          >
            <resizable-divider
              class="chat-files-panel__tree-divider"
              prop:label={`${t("nav.resize")}: ${t("chat.sidePanel.files")}`}
              prop:orientation="vertical"
              prop:splitRatio={physicalRatio(
                Math.min(treeWidth(), contentWidth() - FILE_COLUMN_MIN_WIDTH),
                contentWidth(),
              )}
              prop:minRatio={FILE_COLUMN_MIN_WIDTH / contentWidth()}
              prop:maxRatio={1 - FILE_COLUMN_MIN_WIDTH / contentWidth()}
              prop:measureRatio={() =>
                physicalRatio(catalog.getBoundingClientRect().width, contentElement.clientWidth)
              }
              prop:measureSize={() => contentElement.clientWidth}
              onResize={(event: CustomEvent<{ splitRatio: number }>) => {
                // Resize is direct manipulation; the existing tree toggle restores its own motion.
                contentElement.dataset.treeMotion = "instant";
                const ratio =
                  getComputedStyle(contentElement).direction === "rtl"
                    ? 1 - event.detail.splitRatio
                    : event.detail.splitRatio;
                setTreeWidth(ratio * contentElement.clientWidth);
              }}
            />
          </Show>
          <For each={rendered().previews} keyed={(preview) => preview.id}>
            {(preview) => {
              const entry = () => {
                rendered();
                return preview();
              };
              const FilePath = () => (
                <span
                  ref={createTextOverflow(() => entry().label)}
                  class="sidebar-file-view__path"
                  title={entry().label}
                >
                  {entry().label}
                </span>
              );
              const readResult = createMemo(() => ({ pending: entry().readResult }), {
                equals: (previous, next) => previous.pending === next.pending,
              });
              const source = createMemo(() => entry());
              const currentContent = createMemo(() => entry().content);
              const detail = createMemo(() => {
                const current = source();
                const pending = readResult().pending;
                currentContent();
                const resolved = () => {
                  const value = current.content;
                  if (value.kind === "unavailable") {
                    throw new Error(value.message);
                  }
                  return value.kind === "loading" ? undefined : value;
                };
                // App views and other tabs without an admitted read mount synchronously.
                return pending ? pending.then(resolved) : resolved();
              });
              return (
                <div
                  ref={[pageRef(preview().id)]}
                  class="chat-files-panel__page"
                  data-app-tab-id={entry().content.kind === "mcp-app" ? entry().id : undefined}
                  hidden={rendered().activeId !== entry().id || entry().catalogVisible === true}
                >
                  <Show when={rendered().presentation === "desktop"}>
                    <div
                      class="chat-files-panel__fallback-rail sidebar-file-view__path-bar session-panel-rail"
                      data-presentation="desktop"
                    >
                      <FilePath />
                    </div>
                  </Show>
                  <Show when={rendered().presentation === "mobile"}>
                    <div class="chat-files-panel__mobile-fallback-rail">
                      <SidebarFileMobileRail
                        name={entry().label}
                        identity={entry().label}
                        back={{ label: t("chat.sidePanel.files"), onBack: showBrowser }}
                      />
                    </div>
                  </Show>
                  <div class="chat-files-panel__reader">
                    <Errored
                      fallback={(error) => (
                        <Show
                          when={rendered().presentation === "desktop"}
                          fallback={
                            <div class="callout danger" role="alert">
                              {formatUiError(error())}
                            </div>
                          }
                        >
                          <section class="sidebar-file-view sidebar-file-view--desktop">
                            <div
                              class="sidebar-file-view__path-bar session-panel-rail"
                              data-presentation="desktop"
                            >
                              <FilePath />
                            </div>
                            <div class="sidebar-file-view__workspace-body">
                              <PanelEmptyState
                                presentation="desktop"
                                icon={<Icon name="fileText" />}
                                heading={t("chat.detailPanel.unavailable")}
                                description={formatUiError(error())}
                              />
                            </div>
                          </section>
                        </Show>
                      )}
                    >
                      <Loading
                        fallback={
                          <PanelLoadingSkeleton variant="files" label={t("common.loading")} />
                        }
                      >
                        <Show when={detail()}>
                          {(content) => <Detail content={content()} previewId={entry().id} />}
                        </Show>
                      </Loading>
                    </Errored>
                  </div>
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
      sessionKey: { default: "" },
      previews: { default: [], attribute: false },
      activeId: { default: null, attribute: false },
      tabsInHeader: { default: true, type: Boolean },
      presentation: { default: undefined, attribute: false },
      treeVisible: { default: true, type: Boolean },
      folderView: { default: false, type: Boolean },
      workspace: { default: undefined, attribute: false },
      browserPresented: { default: () => true, attribute: false },
      renderDetail: { default: null, attribute: false },
      onSelect: { default: () => {}, attribute: false },
      onClose: { default: () => {}, attribute: false },
    },
    methods: { selectHostedTab: () => {}, closeHostedTab: async () => {} },
    propertyChanged: (host, key) => {
      if (key === "previews" || key === "activeId") {
        hostedTabNotifiers.get(host)?.();
      }
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-files-panel": ChatFilesPanel;
  }
}
