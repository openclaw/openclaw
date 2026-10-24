import type { Server as HttpServer } from "node:http";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { SANDBOX_HOST_PATH } from "../../../src/agents/sandbox-host.js";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import { createSandboxHostHttpServer } from "../../../src/gateway/mcp-app-sandbox-http.js";
import {
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { bounds } from "./new-session-page.scenario.test-support.ts";
import { pollText, pollCount } from "./new-session-page.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "dashboard fullscreen modes",
  startServerBeforeBrowser: true,
});

const sessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
const initialFocusPath = "focus/dashboard/main/12345678";
const sessionRow = {
  key: sessionKey,
  kind: "direct",
  boardFace: "dashboard",
  displayName: "Deploy monitor",
  updatedAt: 1,
};
const resolvedSession = {
  ok: true,
  key: sessionKey,
  agentId: "main",
  displayName: sessionRow.displayName,
  boardFace: sessionRow.boardFace,
};
const makeWidget = (name: string, title: string, position: number) => ({
  name,
  title,
  position,
  tabId: "main",
  contentKind: "html",
  sizeW: 6,
  sizeH: 4,
  grantState: "pending",
  revision: 1,
  frameUrl: `about:blank#${name}`,
});
const boardSnapshot = {
  sessionKey,
  revision: 1,
  tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
  widgets: [makeWidget("status", "Status", 0), makeWidget("permissions", "Permissions", 1)],
};

function installBoard(page: Page, scenario: ControlUiMockGatewayScenario = {}) {
  return installMockGateway(page, {
    sessionKey,
    featureMethods: ["board.get"],
    ...scenario,
    methodResponses: {
      "sessions.resolve": resolvedSession,
      "sessions.describe": { session: sessionRow },
      "board.get": boardSnapshot,
      ...scenario.methodResponses,
    },
  });
}
const resetScroll = (page: Locator) =>
  page.evaluate((element) => {
    element.scrollTop = 0;
  });
const scrollTop = (page: Locator) => page.evaluate((element) => element.scrollTop);
const scrollRemaining = (board: Locator) =>
  board.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
async function expectWidgetReady(board: Locator, frame: Locator) {
  await expect.poll(() => frame.getAttribute("inert")).toBeNull();
  expect(await frame.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  expect(await board.getByRole("status", { name: "Loading…", exact: true }).count()).toBe(0);
}

async function openFocusFromDashboards(page: Page, focusPath: string): Promise<void> {
  await page.goto(`${suite.server.baseUrl}dashboards`);
  await page.locator("openclaw-app-shell").waitFor();
  await page.goto(`${suite.server.baseUrl}${focusPath}`);
}

async function closeFocusedView(page: Page, label: "Back" | "Close dashboard"): Promise<void> {
  const action = page.getByRole("button", { name: label, exact: true });
  await action.waitFor();
  await action.click();
  await page.waitForURL(`${suite.server.baseUrl}dashboards`);
}

async function listenOnLoopback(server: HttpServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("sandbox host did not bind a TCP address");
  }
  return address.port;
}

suite.define(() => {
  it("fails an unsupported focus target visibly without mounting the application shell", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      await installMockGateway(page);
      await openFocusFromDashboards(page, "focus/not-supported");
      await page.getByRole("alert").getByText("This focused view is not supported.").waitFor();
      expect(await page.locator("openclaw-app-shell").count()).toBe(0);
      await closeFocusedView(page, "Back");
    });
  });

  it("leaves dashboard dismissal to the native navigation host", async () => {
    await suite.withPage(
      { serviceWorkers: "block", viewport: { width: 393, height: 852 } },
      async ({ page }) => {
        await page.addInitScript(() => {
          Object.defineProperty(window, "__OPENCLAW_NATIVE_WEB_CHROME__", {
            value: true,
            configurable: true,
          });
        });
        await installBoard(page);

        await page.goto(`${suite.server.baseUrl}${initialFocusPath}`);
        const dashboardDocument = page.locator("openclaw-board-document");
        await dashboardDocument.locator("openclaw-board-view").waitFor();

        expect(await page.locator("openclaw-app-shell").count()).toBe(0);
        expect(
          await dashboardDocument.getByRole("button", { name: "Close dashboard" }).count(),
        ).toBe(0);
        const horizontalOverflow = await page.evaluate(() => {
          const board = document.querySelector("openclaw-board-view");
          return {
            document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            board: board ? board.scrollWidth - board.clientWidth : null,
            shortBoardVertical: board ? board.scrollHeight - board.clientHeight : null,
          };
        });
        expect(horizontalOverflow).toEqual({ document: 0, board: 0, shortBoardVertical: 0 });
      },
    );
  });

  it("hands nested sandbox scroll remainder to the shell-free dashboard document", async () => {
    const sandboxHost = createSandboxHostHttpServer();
    const sandboxPort = await listenOnLoopback(sandboxHost);
    try {
      await suite.withPage(
        {
          hasTouch: true,
          isMobile: true,
          serviceWorkers: "block",
          viewport: { width: 393, height: 852 },
        },
        async ({ context, page }) => {
          let widgetDocument = buildWidgetDocument(
            "Nightly disk cleanup",
            `<style>
            .local-scroll{height:120px;overflow-y:auto}.local-row{height:40px}
            .row{height:48px;border-bottom:1px solid #333}
          </style>
          <section class="local-scroll">${Array.from(
            { length: 8 },
            (_, index) => `<div class="local-row">Local row ${index + 1}</div>`,
          ).join("")}</section>
          <main>${Array.from(
            { length: 28 },
            (_, index) =>
              `<div class="row"${index === 27 ? ' id="dashboard-final-row"' : ""}>Cleanup row ${index + 1}</div>`,
          ).join("")}</main>`,
          );
          const widgetUrl = `${suite.server.baseUrl}__widget/long-dashboard`;
          const widgetSnapshot = {
            ...boardSnapshot,
            widgets: [
              {
                name: "long-dashboard",
                tabId: "main",
                title: "Nightly disk cleanup",
                contentKind: "html",
                sizeW: 12,
                sizeH: 6,
                position: 0,
                grantState: "none",
                revision: 1,
                frameUrl: widgetUrl,
                instanceId: "long-dashboard-instance",
                viewTicket: "long-dashboard-ticket",
                viewTicketTtlMs: 1_200_000,
                viewGeneration: "long-dashboard-generation",
                sandboxUrl: SANDBOX_HOST_PATH,
                sandboxPort,
                sandboxOrigin: `http://127.0.0.1:${sandboxPort}`,
              },
            ],
          };
          let releaseDocument!: () => void;
          const documentGate = new Promise<void>((resolve) => {
            releaseDocument = resolve;
          });
          await page.route(widgetUrl, async (route) => {
            await documentGate;
            await route.fulfill({
              body: widgetDocument,
              contentType: "text/html; charset=utf-8",
              status: 200,
            });
          });
          const gateway = await installBoard(page, {
            methodResponses: { "board.get": widgetSnapshot },
          });

          await page.goto(`${suite.server.baseUrl}${initialFocusPath}`);
          const board = page.locator("openclaw-board-document openclaw-board-view");
          const frame = page.locator(
            '.board-widget[data-widget-name="long-dashboard"] .board-widget__frame',
          );
          await frame.waitFor();
          try {
            await expect
              .poll(() =>
                page
                  .frames()
                  .some((candidate) => candidate.parentFrame()?.url().includes(SANDBOX_HOST_PATH)),
              )
              .toBe(true);
            expect(await frame.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
            expect(await frame.getAttribute("inert")).toBe("");
            await board.getByRole("status", { name: "Loading…", exact: true }).waitFor();
          } finally {
            releaseDocument();
          }
          await expectWidgetReady(board, frame);
          await expect
            .poll(() => board.evaluate((element) => element.scrollHeight > element.clientHeight))
            .toBe(true);
          const embeddedFrame = page
            .frames()
            .find((candidate) => candidate.parentFrame()?.url().includes(SANDBOX_HOST_PATH));
          if (!embeddedFrame) {
            throw new Error("Dashboard widget document is not mounted");
          }
          const localScroller = embeddedFrame.locator(".local-scroll");
          const localScrollerBox = await bounds(localScroller);
          const boardBox = await bounds(board);
          const frameBox = await bounds(frame);

          await resetScroll(board);
          await page.mouse.move(
            localScrollerBox.x + localScrollerBox.width / 2,
            localScrollerBox.y + localScrollerBox.height / 2,
          );
          await page.mouse.wheel(0, 80);
          await expect.poll(() => scrollTop(localScroller)).toBeGreaterThan(0);
          expect(await scrollTop(board)).toBe(0);

          await embeddedFrame.evaluate(() => {
            document.body.dispatchEvent(
              new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 500 }),
            );
          });
          expect(await scrollTop(board)).toBe(0);

          await page.mouse.move(
            frameBox.x + frameBox.width / 2,
            Math.min(frameBox.y + frameBox.height / 2, boardBox.y + boardBox.height / 2),
          );
          await page.mouse.wheel(0, 500);
          await expect.poll(() => scrollTop(board)).toBeGreaterThan(0);

          await embeddedFrame.evaluate(() => {
            if (document.scrollingElement) {
              document.scrollingElement.scrollTop = 0;
            }
          });
          await resetScroll(board);
          const cdp = await context.newCDPSession(page);
          for (let attempt = 0; attempt < 4; attempt += 1) {
            const currentBoardBox = await bounds(board);
            const currentFrameBox = await bounds(frame);
            const touchX = currentFrameBox.x + currentFrameBox.width / 2;
            const touchStartY = Math.min(
              currentFrameBox.y + currentFrameBox.height - 24,
              currentBoardBox.y + currentBoardBox.height - 24,
            );
            const touchEndY = Math.max(
              currentFrameBox.y + 24,
              currentBoardBox.y + 24,
              touchStartY - 300,
            );
            await cdp.send("Input.dispatchTouchEvent", {
              type: "touchStart",
              touchPoints: [{ x: touchX, y: touchStartY }],
            });
            await cdp.send("Input.dispatchTouchEvent", {
              type: "touchMove",
              touchPoints: [{ x: touchX, y: touchEndY }],
            });
            await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
            const remaining = await scrollRemaining(board);
            if (remaining <= 1) {
              break;
            }
          }
          await expect.poll(() => scrollRemaining(board)).toBeLessThanOrEqual(1);
          const finalRowBox = await bounds(embeddedFrame.locator("#dashboard-final-row"));
          const finalBoardBox = await bounds(board);
          expect(finalRowBox.y + finalRowBox.height).toBeLessThanOrEqual(
            finalBoardBox.y + finalBoardBox.height + 1,
          );

          widgetDocument = buildWidgetDocument(
            "Cleanup controls",
            `<button style="position:fixed;top:24px;left:24px"
              onclick="this.textContent='Cleanup requested'">Run cleanup</button>`,
          );
          await gateway.setMethodResponse("board.get", {
            ...widgetSnapshot,
            revision: 2,
            widgets: [{ ...widgetSnapshot.widgets[0], revision: 2 }],
          });
          await gateway.emitGatewayEvent("board.changed", { sessionKey, widget: "long-dashboard" });
          const replacement = page.frameLocator(".board-widget__frame").frameLocator("iframe");
          const cleanup = replacement.getByRole("button", { name: "Run cleanup", exact: true });
          await cleanup.waitFor();
          expect(
            await replacement.locator("body").evaluate((body) => {
              if (!(body instanceof HTMLElement)) {
                throw new Error("Widget body is not an HTML element");
              }
              return Math.max(
                body.scrollHeight,
                body.offsetHeight,
                body.getBoundingClientRect().height,
              );
            }),
          ).toBe(0);
          await expectWidgetReady(board, frame);
          await cleanup.tap();
          await replacement
            .getByRole("button", { name: "Cleanup requested", exact: true })
            .waitFor();
        },
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        sandboxHost.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("keeps ambiguity candidates inside the focused dashboard namespace", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const secondKey = "agent:main:dashboard:12345678-aaaa-cdef-1234-567890abcdef";
      const gateway = await installMockGateway(page, {
        featureMethods: ["board.get"],
        methodResponses: {
          "sessions.resolve": {
            ok: false,
            candidates: [sessionKey, secondKey].map((key, index) => ({
              key,
              agentId: "main",
              boardFace: sessionRow.boardFace,
              displayName: index ? "Deploy monitor beta" : sessionRow.displayName,
            })),
          },
        },
      });

      await openFocusFromDashboards(page, initialFocusPath);
      const links = page.getByRole("link");
      await pollCount(links).toBe(2);
      for (const link of await links.all()) {
        expect(new URL((await link.getAttribute("href")) ?? "", page.url()).pathname).toMatch(
          /^\/focus\/dashboard\/main\//u,
        );
      }
      expect(await gateway.getRequests("sessions.resolve")).toHaveLength(1);
      expect(await gateway.getRequests("sessions.describe")).toHaveLength(0);
      expect(await gateway.getRequests("board.get")).toHaveLength(0);
      expect(await page.locator("openclaw-board-document").count()).toBe(0);
      await closeFocusedView(page, "Close dashboard");
    });
  });

  it("shows a clear outcome when the requested session does not exist", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["board.get"],
        methodResponses: { "sessions.resolve": { ok: false } },
      });

      await openFocusFromDashboards(page, initialFocusPath);
      await page.getByText("This session could not be found.", { exact: true }).waitFor();
      expect(await page.locator("openclaw-app-shell").count()).toBe(0);
      expect(await page.locator("openclaw-board-document").count()).toBe(0);
      expect(await gateway.getRequests("board.get")).toHaveLength(0);
      await closeFocusedView(page, "Close dashboard");
    });
  });

  it("escapes a focused dashboard route-resolution failure", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      await installMockGateway(page, {
        methodResponses: {
          "sessions.resolve": {
            __mockError: { code: "UNAVAILABLE", message: "session routing is unavailable" },
          },
        },
      });

      await openFocusFromDashboards(page, initialFocusPath);
      const alert = page.getByRole("alert");
      await alert.waitFor();
      await pollText(alert).toContain("session routing is unavailable");
      expect(await page.locator("openclaw-app-shell").count()).toBe(0);
      await closeFocusedView(page, "Close dashboard");
    });
  });

  it("shows an actionable error when the initial board load fails", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installBoard(page, {
        methodResponses: {
          "board.get": {
            __mockError: { code: "UNAVAILABLE", message: "dashboard storage is unavailable" },
          },
        },
      });

      await openFocusFromDashboards(page, initialFocusPath);
      await gateway.waitForRequest("board.get");
      const alert = page.getByRole("alert");
      await alert.waitFor();
      await pollText(alert).toContain("dashboard storage is unavailable");
      await pollText(alert).toContain("try again");
      await closeFocusedView(page, "Close dashboard");
    });
  });
});
