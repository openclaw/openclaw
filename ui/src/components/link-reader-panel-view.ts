import type {
  ControlUiLinkReaderDocument,
  ControlUiLinkReaderDeferredSection,
} from "../../../src/shared/control-ui-link-reader.js";
import { t } from "../i18n/index.ts";
import { createDockPanelLayout } from "./dock-panel-layout.ts";
import { nativeDockPanelCss } from "./dock-panel-styles.ts";
import { iconData, type IconName } from "./icon-data.ts";
import type { LinkReaderImages } from "./link-reader-images.ts";
import type { LinkReaderPanelProps } from "./link-reader-panel-lifecycle.ts";
import type { LinkReaderMetadataUpdate } from "./link-reader-response.ts";
import type { LinkReaderTarget } from "./link-reader-target.ts";
import { createIconElement } from "./markdown-icon.ts";
import type { PanelHostedTab } from "./panel-hosted-tabs.ts";
import { nativePanelTabStripCss } from "./panel-tab-strip-styles.ts";
import linkReaderContentStyles from "./link-reader-content.css?inline";
import linkReaderPanelStyles from "./link-reader-panel.css?inline";

export const linkReaderPanelLayout = createDockPanelLayout({
  storageKey: "openclaw.link-reader.panel.v1",
  minHeight: 240,
  minWidth: 300,
  defaultDock: "right",
  supportedDocks: ["right"],
  defaultHeight: 420,
  defaultWidth: 560,
});

// WebKit 26 can stop matching @scope rules inside native disclosure content.
// Use the same host-selector nesting as the other docked panels.
export const linkReaderViewStyles = `
${nativePanelTabStripCss}
${nativeDockPanelCss}
:where(openclaw-link-reader-panel) {
${linkReaderPanelStyles}
${linkReaderContentStyles}
}
@keyframes lr-loading-pulse {
  50% {
    opacity: 0.5;
  }
}
`;

export function readerIcon(name: string | undefined, ownerDocument: Document) {
  const icon =
    name && Object.hasOwn(iconData, name)
      ? (name as IconName) // SAFETY: The own-key guard admits only names in the built-in catalog.
      : "link";
  return createIconElement(icon, ownerDocument);
}

export type ReaderSection = ControlUiLinkReaderDeferredSection;
export type ReaderReadyView = {
  status: "ready";
  detail: ControlUiLinkReaderDocument;
  scope: Pick<LinkReaderMetadataUpdate, "client" | "agentId" | "sessionKey"> & {
    generation: number;
    recoveryScope: string | undefined;
  };
  images?: LinkReaderImages;
  refreshing?: boolean;
  message?: string;
  sections: Partial<Record<ReaderSection, "idle" | "loading" | "error">>;
};

export function createReaderReadyView(
  detail: ControlUiLinkReaderDocument,
  scope: ReaderReadyView["scope"],
  previous?: ReaderReadyView,
): ReaderReadyView {
  const next: ReaderReadyView = { status: "ready", detail, scope, sections: {} };
  for (const deferred of detail.deferredSections ?? []) {
    next.sections[deferred] = "idle";
  }
  // Same-revision refreshes retain loaded sections until their replacements arrive.
  if (previous && previous.detail.revision === detail.revision) {
    const old = previous.detail;
    next.detail = {
      ...detail,
      ...(next.sections.checks && old.checks ? { checks: old.checks } : {}),
      ...(next.sections.files && old.files
        ? { files: old.files, filesTruncated: old.filesTruncated }
        : {}),
      ...(next.sections.discussion && old.comments
        ? { comments: old.comments, commentsTruncated: old.commentsTruncated }
        : {}),
    };
  }
  return next;
}

type PanelView =
  | { status: "idle" | "loading" }
  | { status: "error"; message: string }
  | ReaderReadyView;
export type ReaderTab = {
  id: string;
  /** One item per tab; another item opens another tab. */
  target: LinkReaderTarget | null;
  view: PanelView;
  reloadPending: boolean;
};
export function tabTarget(tab: ReaderTab | undefined): LinkReaderTarget | null {
  return tab?.target ?? null;
}

export function* readerTabMetadata(
  props: Pick<LinkReaderPanelProps, "client" | "agentId" | "sessionKey" | "readers">,
  tabs: ReaderTab[],
): Generator<LinkReaderMetadataUpdate> {
  const { client, agentId, sessionKey } = props;
  if (!client?.connected) {
    return;
  }
  for (const tab of tabs) {
    const target = tabTarget(tab);
    const view = tab.view;
    if (
      target &&
      props.readers.includes(target.reader) &&
      view.status === "ready" &&
      view.scope.client === client &&
      view.scope.agentId === agentId &&
      view.scope.sessionKey === sessionKey &&
      view.scope.generation === client.connectionGeneration &&
      view.scope.recoveryScope === client.recoveryScope &&
      !tab.reloadPending &&
      !view.detail.stale
    ) {
      yield { client, agentId, sessionKey, target, preview: view.detail };
    }
  }
}

export function tabLabel(tab: ReaderTab): string {
  if (tab.view.status === "ready") {
    return tab.view.detail.title;
  }
  const target = tabTarget(tab);
  return target
    ? target.reader.label + " · " + new URL(target.href).pathname
    : t("linkReader.newTab");
}

export type LinkReaderPanelState = {
  urlDraft: string;
  invalidUrl: boolean;
  tabLimitUrl: string | null;
  tabs: ReaderTab[];
  activeId: string | null;
};

export function readerHostedTabs(tabs: ReaderTab[], ownerDocument: Document): PanelHostedTab[] {
  return tabs.map((tab) => ({
    id: tab.id,
    label: tabLabel(tab),
    url: tabTarget(tab)?.href,
    title: tabTarget(tab)?.href,
    icon: readerIcon(tabTarget(tab)?.reader.icon, ownerDocument),
    className: tab.view.status === "loading" ? "is-connecting" : "",
  }));
}
