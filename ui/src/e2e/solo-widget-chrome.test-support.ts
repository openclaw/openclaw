import { writeFileSync } from "node:fs";
import path from "node:path";
import { withTimeout } from "@openclaw/fs-safe/advanced";
import type { Page } from "playwright";
import type { BoardViewElement } from "../components/board/board-view-state.ts";

/** Observe synthetic fixtures only; never wrap menu handlers or change registration timing. */
export async function withWidgetChromeDiagnostics(
  page: Page,
  artifactDir: () => string,
  run: () => Promise<void>,
): Promise<void> {
  const context = page.context();
  await context.tracing.start({ screenshots: true, snapshots: true });
  await page.addInitScript(() => {
    const read = () => {
      const board = document.querySelector<BoardViewElement>("openclaw-board-view");
      const widgets = board?.snapshot?.widgets ?? [];
      return {
        registered: {
          board: Boolean(customElements.get("openclaw-board-view")),
          cell: Boolean(customElements.get("openclaw-board-widget-cell")),
        },
        board: board
          ? {
              connected: board.isConnected,
              active: board.active,
              canMutate: board.canMutate,
              revision: board.snapshot?.revision,
              activeTabId: board.activeTabId,
              pageWidgetName: board.pageWidgetName,
              selectRegistered: typeof board.selectPageWidgetMenuItem === "function",
              widgets: widgets.slice(0, 8).map(({ name, tabId, revision }) => ({
                name,
                tabId,
                revision,
              })),
              cells: [...board.querySelectorAll("openclaw-board-widget-cell")]
                .slice(0, 8)
                .map((cell) => ({
                  name: cell.widget?.name,
                  revision: cell.widget?.revision,
                  boardRevision: cell.boardRevision,
                  connected: cell.isConnected,
                  active: cell.active,
                  pageChrome: cell.pageChrome,
                  busy: cell.busy,
                  canMutate: cell.canMutate,
                  presentationReady: cell.presentationReady,
                  widgetMatchesSnapshot: widgets.includes(cell.widget!),
                  selectRegistered: typeof cell.selectMenuItem === "function",
                })),
            }
          : null,
        researchSelected: document
          .querySelector('[role="tab"][data-board-tab-id="research"]')
          ?.getAttribute("aria-selected"),
        menuExpanded: document
          .querySelector(".chat-dashboard-menu__trigger")
          ?.getAttribute("aria-expanded"),
        removePresent: Boolean(
          document.querySelector('.chat-dashboard-menu [data-value="remove"]'),
        ),
      };
    };
    const events: Array<{ type: string; at: number; state: ReturnType<typeof read> }> = [];
    for (const type of ["pointerdown", "click"]) {
      document.addEventListener(
        type,
        (event) => {
          if (
            event.target instanceof Element &&
            event.target.closest('.chat-dashboard-menu [data-value="remove"]')
          ) {
            events.push({ type, at: performance.now(), state: read() });
            if (events.length > 4) {
              events.shift();
            }
          }
        },
        true,
      );
    }
    Object.assign(window, {
      widgetChromeDiagnostics: () => ({ events, failure: read() }),
    });
  });
  try {
    await run();
  } catch (error) {
    try {
      const directory = artifactDir();
      // Independent, best-effort captures preserve the original assertion even if Chromium stalls.
      const captures = await Promise.allSettled([
        withTimeout(
          page.evaluate(() => {
            const scope = window as Window & { widgetChromeDiagnostics?: () => unknown };
            return scope.widgetChromeDiagnostics?.() ?? null;
          }),
          2_000,
          "widget chrome state capture",
        ).then((state) => {
          console.error("[single-widget-chrome] registration state", JSON.stringify(state));
          writeFileSync(
            path.join(directory, "widget-chrome-state.json"),
            JSON.stringify(state, null, 2),
          );
        }),
        page.screenshot({ path: path.join(directory, "widget-chrome.png"), timeout: 2_000 }),
        withTimeout(
          context.tracing.stop({ path: path.join(directory, "widget-chrome-trace.zip") }),
          5_000,
          "widget chrome trace capture",
        ),
      ]);
      for (const [index, capture] of captures.entries()) {
        if (capture.status === "rejected") {
          console.error(
            `[single-widget-chrome] capture ${index} failed: ${String(capture.reason)}`,
          );
        }
      }
      console.error(`[single-widget-chrome] failure artifacts: ${directory}`);
    } catch (captureError) {
      console.error(`[single-widget-chrome] capture failed: ${String(captureError)}`);
    }
    throw error;
  }
  await context.tracing.stop();
}
