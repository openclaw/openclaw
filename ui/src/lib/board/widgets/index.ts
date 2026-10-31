import type { GatewayControlUiPluginWidgetKind } from "../../../api/gateway.ts";
import { t } from "../../../i18n/index.ts";
import { registerBoardDocumentEnglish } from "../../../i18n/locales/en-board-document.ts";
import { registerSessionProgressEnglish } from "../../../i18n/locales/en-session-progress.ts";
import type { BoardWidget } from "../types.ts";

registerBoardDocumentEnglish();

registerSessionProgressEnglish();

/**
 * Core widget metadata stays independent of the lazy renderers. Preview-safe widgets consume
 * only saved data; they never acquire live subscriptions or invoke Gateway methods.
 */
const CORE_BOARD_WIDGET_ELEMENTS = [
  {
    kind: "session:progress",
    tagName: "openclaw-session-progress-widget",
    get label() {
      return t("sessionProgressCard.widgetLabel");
    },
    previewSafe: false,
  },
  {
    kind: "session:report",
    tagName: "openclaw-report-widget",
    get label() {
      return t("board.widget.kindReport");
    },
    previewSafe: true,
  },
  {
    kind: "session:website",
    tagName: "openclaw-website-widget",
    get label() {
      return t("board.widget.kindWebsite");
    },
    previewSafe: false,
  },
  {
    kind: "browser:dashboard",
    tagName: "openclaw-browser-dashboard-widget",
    get label() {
      return t("board.widget.kindBrowserDashboard");
    },
    previewSafe: false,
  },
] as const;

type CoreBoardWidgetElement = (typeof CORE_BOARD_WIDGET_ELEMENTS)[number];

export function pluginIdForWidgetKind(kind: string | undefined): string {
  return kind?.split(":", 1)[0]?.trim() || "unknown";
}

export function getPluginWidgetKindContribution(
  kind: string | undefined,
  activeKinds: readonly GatewayControlUiPluginWidgetKind[],
): CoreBoardWidgetElement | null {
  if (!kind) {
    return null;
  }
  const contribution = CORE_BOARD_WIDGET_ELEMENTS.find((entry) => entry.kind === kind);
  if (!contribution) {
    return null;
  }
  const pluginId = pluginIdForWidgetKind(kind);
  return activeKinds.some((entry) => entry.kind === kind && entry.pluginId === pluginId)
    ? contribution
    : null;
}

export function isPassiveBoardWidget(
  widget: BoardWidget,
  activeKinds: readonly GatewayControlUiPluginWidgetKind[],
): boolean {
  return (
    widget.contentKind === "html" ||
    (widget.contentKind === "plugin" &&
      !widget.frameUrl &&
      getPluginWidgetKindContribution(widget.pluginKind, activeKinds)?.previewSafe === true)
  );
}
