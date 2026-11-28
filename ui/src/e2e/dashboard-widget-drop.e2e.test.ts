import { expect, it } from "vitest";
import { createBoardWidget } from "../lib/board/widget.test-support.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Dashboard widget drop",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:release-review";
const report = (name: string, title: string, position: number, text: string) =>
  createBoardWidget({
    name,
    title,
    position,
    sizeW: 6,
    sizeH: 3,
    heightMode: "fixed",
    contentKind: "plugin",
    pluginKind: "session:report",
    props: { blocks: [{ type: "text", title, text }] },
  });
const snapshot = {
  sessionKey,
  revision: 1,
  tabs: [
    { tabId: "main", title: "Overview", position: 0, chatDock: "right" },
    { tabId: "notes", title: "Notes", position: 1, chatDock: "right" },
  ],
  widgets: [
    report(
      "schedule",
      "Release schedule",
      0,
      "Tuesday · Candidate build\n\nThursday · Release review",
    ),
    report("checks", "Verification", 1, "Desktop and mobile checks complete.\n\nReady for review."),
  ],
};
suite.define(() => {
  it("keeps the dropped size while saving, rolls back a rejected resize, and accepts a retry", async () => {
    await suite.withPage(
      { viewport: { width: 1240, height: 740 }, reducedMotion: "reduce" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessionKey,
          controlUiWidgetKinds: [{ pluginId: "session", kind: "session:report", label: "Report" }],
          featureMethods: ["board.get", "board.update", "chat.metadata", "chat.startup"],
          methodResponses: { "board.get": snapshot },
        });
        await page.addInitScript(
          ({ key, storage }) =>
            localStorage.setItem(
              storage,
              JSON.stringify({ boardSessionViews: { [key]: { activeTabId: "main" } } }),
            ),
          { key: sessionKey, storage: controlUiBundledSettingsStorageKey(suite.server.baseUrl) },
        );
        const url = new URL(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
        url.searchParams.set("dashboard", "expanded");
        await page.goto(url.href);
        const widget = page.locator('[data-widget-name="schedule"]');
        const handle = widget.locator(".board-widget__resize-handle");
        await widget.getByText("Tuesday", { exact: false }).waitFor();
        const width = () =>
          widget.evaluate((el) => (el instanceof HTMLElement ? el.offsetWidth : 0));
        const initialWidth = await width();
        const resize = async () => {
          await widget.hover();
          await handle.hover();
          const start = (await handle.boundingBox())!;
          const x = start.x + start.width / 2,
            y = start.y + start.height / 2;
          const after = await gateway.deferNext("board.update");
          await page.mouse.down();
          await page.mouse.move(x + initialWidth / 2, y, { steps: 5 });
          await expect.poll(width).toBeGreaterThan(initialWidth * 1.25);
          const preview = await width();
          await page.mouse.up();
          const request = await gateway.waitForRequest("board.update", { after });
          expect(request.params).toMatchObject({
            ops: [{ kind: "widget_resize", name: "schedule", sizeW: 9, heightMode: "fixed" }],
          });
          return preview;
        };
        const preview = await resize();
        expect(await width()).toBe(preview);
        await gateway.rejectDeferred("board.update", {
          code: "UNAVAILABLE",
          message: "Resize was not saved",
        });
        await page.locator(".board-view__error").waitFor();
        await expect.poll(width).toBe(initialWidth);
        await resize();
        const saved = {
          ...snapshot,
          revision: 2,
          widgets: snapshot.widgets.map((w, i) => (i === 0 ? { ...w, sizeW: 9 } : w)),
        };
        await gateway.resolveDeferred("board.update", saved);
        await expect
          .poll(() => page.locator(".board-announcer").textContent())
          .toContain("Resized Release schedule");
        expect(await width()).toBe(preview);
        await widget.hover();
        await widget.locator(".board-widget__menu-trigger").click();
        await widget.getByRole("menu").waitFor();
      },
    );
  });
});
