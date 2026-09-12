import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { focusChatSidePanel } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "website dashboards",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
const websiteUrl = "https://status.example/dashboard";
const sessionRow = {
  ...createControlUiSessionRow(sessionKey, "Service status", Date.now()),
  boardFace: "dashboard",
};
const snapshot = {
  sessionKey,
  revision: 1,
  tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
  widgets: [
    {
      name: "website",
      tabId: "main",
      title: "Service status",
      contentKind: "plugin",
      pluginKind: "session:website",
      props: { url: websiteUrl },
      sizeW: 12,
      sizeH: 8,
      position: 0,
      grantState: "none",
      revision: 1,
    },
  ],
};
const website = `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Service status</title>
<style>body{margin:0;background:#102820;color:#e8fff2;font:16px system-ui}main{padding:clamp(24px,5vw,64px)}h1{font-size:clamp(32px,5vw,58px);margin:10px 0 24px}p{color:#a9c9b8}input,button,a{font:inherit}input{display:block;max-width:85%;margin:20px 0;padding:10px}button{padding:10px 16px;background:#b4f9bf;border:0;border-radius:8px}a{color:#b4f9bf}#status{font-size:24px;color:#b4f9bf}</style>
<main><p>OPERATIONS / SERVICE STATUS</p><h1>Everything in view.</h1><p id="status">Loading status…</p><input aria-label="Status note" placeholder="Add a local note"><button id="refresh">Refresh status</button><p><a href="/details">View details</a></p></main>
<script>const note=document.querySelector('input');note.value=localStorage.getItem('status-note')||'';note.oninput=()=>localStorage.setItem('status-note',note.value);async function refresh(){document.querySelector('#status').textContent=(await (await fetch('/api/status')).json()).text;}document.querySelector('#refresh').onclick=refresh;refresh();</script></html>`;

suite.define(() => {
  it("runs a website with its own storage and refresh, preserving it through dashboard focus", async () => {
    await suite.withPage(
      { serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page, context }) => {
        let requests = 0;
        await context.route("https://status.example/**", (route) => {
          const path = new URL(route.request().url()).pathname;
          if (path === "/api/status") {
            requests += 1;
            return route.fulfill({
              contentType: "application/json",
              body: JSON.stringify({
                text: requests === 1 ? "All systems operational" : "Status refreshed",
              }),
            });
          }
          return route.fulfill({
            contentType: "text/html",
            body: path === "/details" ? "<!doctype html><h1>Service details</h1>" : website,
          });
        });
        const gateway = await installMockGateway(page, {
          sessionKey,
          controlUiWidgetKinds: [
            { pluginId: "session", kind: "session:website", label: "Website" },
          ],
          featureMethods: ["board.get", "sessions.patch"],
          methodResponses: {
            "sessions.list": { count: 1, sessions: [sessionRow], defaults: {}, path: "", ts: 1 },
            "sessions.patch": {},
            "sessions.describe": { session: sessionRow },
            "sessions.resolve": {
              ok: true,
              key: sessionKey,
              agentId: "main",
              displayName: sessionRow.displayName,
              boardFace: "dashboard",
            },
            "board.get": snapshot,
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
        const frame = page.locator(".board-website__frame");
        const content = page.frameLocator(".board-website__frame");
        await content.getByText("All systems operational", { exact: true }).waitFor();
        const sidebarRow = page.locator(
          `.sidebar-recent-session[data-session-key="${sessionKey}"]`,
        );
        await sidebarRow.hover();
        await sidebarRow.getByRole("button", { name: "Pin session", exact: true }).click();
        const pinned = page.locator(`[data-sidebar-entry="session:${sessionKey}"]`);
        await pinned.waitFor();
        expect(
          await gateway.getRequests("sessions.patch", { key: sessionKey, pinned: true }),
        ).toHaveLength(1);
        await content.getByRole("textbox", { name: "Status note" }).fill("Keep this note");
        const originalFrame = await frame.elementHandle();
        expect(
          await frame.evaluate((element: HTMLIFrameElement) => {
            try {
              return element.contentWindow?.document !== undefined;
            } catch {
              return false;
            }
          }),
        ).toBe(false);
        await page.mouse.move(0, 0);
        await page.screenshot({ path: `${suite.artifactDir}/website-split.png` });
        await focusChatSidePanel(page);
        await expect.poll(() => page.locator(".sidebar-region--expanded").count()).toBe(1);
        const viewportFits = () =>
          frame.evaluate((element) => {
            const board = element.closest("openclaw-board-view")!.getBoundingClientRect();
            const websiteBounds = element.closest(".board-website")!.getBoundingClientRect();
            return (
              Math.abs(board.width - websiteBounds.width) < 1 &&
              Math.abs(board.height - websiteBounds.height) < 1
            );
          });
        await expect.poll(viewportFits).toBe(true);
        expect(
          await frame.evaluate((element, previous) => element === previous, originalFrame),
        ).toBe(true);
        expect(await content.getByRole("textbox", { name: "Status note" }).inputValue()).toBe(
          "Keep this note",
        );
        await content.getByRole("button", { name: "Refresh status" }).click();
        await content.getByText("Status refreshed", { exact: true }).waitFor();
        expect(requests).toBe(2);
        await content.locator("body").evaluate(() => {
          parent.postMessage(
            {
              type: "openclaw:widget-bridge-request",
              id: "website-request",
              method: "data.read",
              params: { bindingId: "sessions" },
              ticket: "website-has-no-ticket",
            },
            "*",
          );
        });
        await page.mouse.move(0, 0);
        await page.screenshot({ path: `${suite.artifactDir}/website-expanded.png` });
        await page.getByRole("link", { name: "Agents", exact: true }).click();
        await page.waitForURL(`${suite.server.baseUrl}agents`);
        await pinned.locator(".sidebar-recent-session__link").click();
        await frame.waitFor();
        await expect.poll(() => page.locator(".sidebar-region--expanded").count()).toBe(1);
        expect(await content.getByRole("textbox", { name: "Status note" }).inputValue()).toBe(
          "Keep this note",
        );
        expect(
          await frame.evaluate((element, previous) => element === previous, originalFrame),
        ).toBe(true);
        await page.screenshot({ path: `${suite.artifactDir}/website-pinned-return.png` });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator(".shell--mobile-nav").waitFor();
        if (await page.locator(".shell--nav-drawer-open").count()) {
          await page.locator(".shell-nav-backdrop").click();
        }
        await expect
          .poll(() =>
            page.locator(".shell-nav").evaluate((element) => element.getBoundingClientRect().right),
          )
          .toBeLessThanOrEqual(0);
        await expect.poll(viewportFits).toBe(true);
        await page.screenshot({ path: `${suite.artifactDir}/website-mobile.png` });
        expect(await gateway.getRequests("board.data.read")).toHaveLength(0);
        await page.getByRole("button", { name: "Restore split", exact: true }).click();
        await content.getByRole("textbox", { name: "Status note" }).waitFor();
        expect(await content.getByRole("textbox", { name: "Status note" }).inputValue()).toBe(
          "Keep this note",
        );
        await content.getByRole("link", { name: "View details" }).click();
        await content.getByRole("heading", { name: "Service details" }).waitFor();
        const opened = context.waitForEvent("page");
        await page.getByRole("link", { name: "Open website", exact: true }).click();
        const separatePage = await opened;
        await separatePage.waitForURL(websiteUrl);
        expect(await separatePage.evaluate(() => window.opener)).toBeNull();
        await separatePage.close();

        await page.goto(`${suite.server.baseUrl}focus/dashboard/main/12345678`);
        await content.getByRole("heading", { name: "Everything in view." }).waitFor();
        await expect.poll(viewportFits).toBe(true);
        expect(await page.locator("openclaw-app-shell").count()).toBe(0);
        await page.screenshot({ path: `${suite.artifactDir}/website-document.png` });
      },
    );
  });

  it("keeps an external escape link when the website refuses embedding", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      await page.route(websiteUrl, (route) =>
        route.fulfill({
          contentType: "text/html",
          headers: { "Content-Security-Policy": "frame-ancestors 'none'" },
          body: "<!doctype html><h1>Standalone only</h1>",
        }),
      );
      await installMockGateway(page, {
        sessionKey,
        controlUiWidgetKinds: [{ pluginId: "session", kind: "session:website", label: "Website" }],
        featureMethods: ["board.get"],
        methodResponses: { "board.get": snapshot },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
      const link = page.getByRole("link", { name: "Open website", exact: true });
      await link.waitFor();
      expect(await link.getAttribute("href")).toBe(websiteUrl);
      expect(await link.getAttribute("target")).toBe("_blank");
      await page.screenshot({ path: `${suite.artifactDir}/website-embedding-blocked.png` });
    });
  });
});
