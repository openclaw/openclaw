import type { BoardSnapshot } from "@openclaw/gateway-protocol";
import { html, nothing, svg, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { t } from "../../i18n/index.ts";
import { registerDashboardsEnglish } from "../../i18n/locales/en-dashboards.ts";
import { layout, type BoardGridRect } from "../../lib/board/grid.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";

registerDashboardsEnglish();

type DashboardPreviewRequest = {
  sessionKey: string;
  agentId?: string;
};

/** Resolves the board snapshot for one dashboard; `null` means no preview is available. */
export type DashboardPreviewLoader = (
  request: DashboardPreviewRequest,
) => Promise<BoardSnapshot | null>;

// The thumbnail mirrors the live board's 12-column grid at 16:9. Real cells are
// ~93x56px in the 1120px column, so one grid row is 0.6 column units; the
// viewBox therefore shows the board's top ~11 rows, which is what an operator
// recognizes when the dashboard opens.
const PREVIEW_COLUMNS = 12;
const PREVIEW_ROW_UNIT = 0.6;
const PREVIEW_HEIGHT = 6.75;
const PREVIEW_GAP = 0.08;
const PREVIEW_LABEL_SIZE = 0.3;
// SVG text cannot be clipped to its widget without per-instance clipPath ids,
// so labels are trimmed to the characters that fit an average glyph width.
const PREVIEW_LABEL_UNIT = 0.19;
const PREVIEW_FOCUS_TAB_INDEX = 0;

type PreviewWidget = BoardGridRect & {
  title: string;
  kind: BoardSnapshot["widgets"][number]["contentKind"];
};

function dashboardPreviewWidgets(snapshot: BoardSnapshot): PreviewWidget[] {
  const tabs = snapshot.tabs.toSorted((left, right) => left.position - right.position);
  const focusTab = tabs[PREVIEW_FOCUS_TAB_INDEX]?.tabId;
  const widgets = snapshot.widgets.filter((widget) => !focusTab || widget.tabId === focusTab);
  const byName = new Map(widgets.map((widget) => [widget.name, widget] as const));
  return layout(
    widgets.map((widget) => ({
      name: widget.name,
      w: widget.sizeW,
      h: widget.sizeH,
      order: widget.position,
    })),
  ).map((rect) => {
    const widget = byName.get(rect.name);
    const title = widget?.title?.trim() || widget?.kindLabel?.trim() || rect.name;
    return Object.assign(rect, { title, kind: widget?.contentKind ?? "html" });
  });
}

function trimLabel(title: string, width: number): string {
  const budget = Math.max(0, Math.floor((width - PREVIEW_LABEL_UNIT * 2) / PREVIEW_LABEL_UNIT));
  const characters = Array.from(title);
  return characters.length > budget
    ? `${characters.slice(0, Math.max(0, budget - 1)).join("")}…`
    : title;
}

function renderWidget(widget: PreviewWidget) {
  const x = widget.x + PREVIEW_GAP / 2;
  const y = widget.y * PREVIEW_ROW_UNIT + PREVIEW_GAP / 2;
  const width = widget.w - PREVIEW_GAP;
  const height = widget.h * PREVIEW_ROW_UNIT - PREVIEW_GAP;
  const headerHeight = Math.min(height, PREVIEW_ROW_UNIT * 0.8);
  return svg`<g class="dashboard-preview__widget dashboard-preview__widget--${widget.kind}">
    <rect x=${x} y=${y} width=${width} height=${height} rx="0.14" />
    ${
      height > headerHeight
        ? svg`<rect
            class="dashboard-preview__body"
            x=${x}
            y=${y + headerHeight}
            width=${width}
            height=${height - headerHeight}
          />`
        : nothing
    }
    <text x=${x + PREVIEW_LABEL_UNIT} y=${y + headerHeight * 0.68} font-size=${PREVIEW_LABEL_SIZE}>
      ${trimLabel(widget.title, width)}
    </text>
  </g>`;
}

class DashboardPreview extends OpenClawLightDomElement {
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) agentId?: string;
  @property({ attribute: false }) load?: DashboardPreviewLoader | null;

  /** `undefined` while loading, `null` when the board cannot be previewed. */
  @state() private snapshot?: BoardSnapshot | null;
  private observer?: IntersectionObserver;
  private loadedKey?: string;
  private loadedBy?: DashboardPreviewLoader;

  override connectedCallback() {
    super.connectedCallback();
    this.scheduleLoad();
  }

  override disconnectedCallback() {
    this.stopObserving();
    super.disconnectedCallback();
  }

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("sessionKey") || changed.has("agentId") || changed.has("load")) {
      this.scheduleLoad();
    }
  }

  private stopObserving(): void {
    this.observer?.disconnect();
    this.observer = undefined;
  }

  // Off-screen cards never request their board; the page-level loader caches
  // snapshots so re-entering the viewport (or switching views) costs nothing.
  private scheduleLoad(): void {
    if (typeof IntersectionObserver === "undefined") {
      void this.fetchSnapshot();
      return;
    }
    if (this.observer) {
      return;
    }
    this.observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          this.stopObserving();
          void this.fetchSnapshot();
        }
      },
      { rootMargin: "240px" },
    );
    this.observer.observe(this);
  }

  private async fetchSnapshot(): Promise<void> {
    const load = this.load;
    if (!this.sessionKey || load === null) {
      this.loadedKey = undefined;
      this.loadedBy = undefined;
      this.snapshot = null;
      return;
    }
    if (!load) {
      this.loadedKey = undefined;
      this.loadedBy = undefined;
      this.snapshot = undefined;
      return;
    }
    const key = `${this.agentId ?? ""}\u0000${this.sessionKey}`;
    if (this.loadedKey === key && this.loadedBy === load) {
      return;
    }
    this.loadedKey = key;
    this.loadedBy = load;
    this.snapshot = undefined;
    let snapshot: BoardSnapshot | null;
    try {
      snapshot = await load({
        sessionKey: this.sessionKey,
        agentId: this.agentId,
      });
    } catch {
      snapshot = null;
    }
    if (this.loadedKey === key && this.loadedBy === load) {
      this.snapshot = snapshot;
    }
  }

  override render() {
    const snapshot = this.snapshot;
    if (snapshot === undefined) {
      return html`<div
        class="dashboard-preview dashboard-preview--loading"
        aria-hidden="true"
      ></div>`;
    }
    const widgets = snapshot ? dashboardPreviewWidgets(snapshot) : [];
    if (widgets.length === 0) {
      return html`<div class="dashboard-preview dashboard-preview--empty" aria-hidden="true">
        <span>
          ${snapshot ? t("dashboardsPage.previewEmpty") : t("dashboardsPage.previewUnavailable")}
        </span>
      </div>`;
    }
    return html`<div class="dashboard-preview" aria-hidden="true">
      <svg viewBox="0 0 ${PREVIEW_COLUMNS} ${PREVIEW_HEIGHT}" preserveAspectRatio="xMinYMin slice">
        ${widgets.map(renderWidget)}
      </svg>
    </div>`;
  }
}

if (!customElements.get("openclaw-dashboard-preview")) {
  customElements.define("openclaw-dashboard-preview", DashboardPreview);
}
