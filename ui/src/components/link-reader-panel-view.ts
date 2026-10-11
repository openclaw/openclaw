import type { ControlUiLinkReaderDocument } from "../../../src/shared/control-ui-link-reader.js";
import { t } from "../i18n/index.ts";
import { createDockPanelLayout } from "./dock-panel-layout.ts";
import { dockPanelStyles } from "./dock-panel-styles.ts";
import { icons } from "./icons.ts";
import { linkReaderContentStyles } from "./link-reader-content.styles.ts";
import type { LinkReaderImages } from "./link-reader-images.ts";
import { linkReaderPanelStyles } from "./link-reader-panel.styles.ts";
import type { LinkReaderTarget } from "./link-reader-target.ts";
import { panelTabStripStyles } from "./panel-tab-strip.ts";

export const linkReaderPanelLayout = createDockPanelLayout({
  storageKey: "openclaw.link-reader.panel.v1",
  minHeight: 240,
  minWidth: 300,
  defaultDock: "right",
  supportedDocks: ["right"],
  defaultHeight: 420,
  defaultWidth: 560,
});

export const linkReaderViewStyles = [
  panelTabStripStyles,
  dockPanelStyles,
  linkReaderPanelStyles,
  linkReaderContentStyles,
];

export function readerIcon(name: string | undefined) {
  return Object.entries(icons).find(([key]) => key === name)?.[1] ?? icons.link;
}

type PanelView =
  | { status: "idle" | "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; detail: ControlUiLinkReaderDocument; images?: LinkReaderImages };
export type ReaderTab = { id: string; history: LinkReaderTarget[]; index: number; view: PanelView };
export function tabTarget(tab: ReaderTab | undefined): LinkReaderTarget | null {
  return tab?.history[tab.index] ?? null;
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
