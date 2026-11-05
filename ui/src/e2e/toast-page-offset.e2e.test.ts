import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite(true);

suite.define(() => {
  it.each([390, 1200])("only reserves the session toolbar on session pages at %ipx", (width) =>
    suite.withPage(
      { viewport: { width, height: 844 }, reducedMotion: "reduce" },
      async ({ page }) => {
        const gateway = await installMockGateway(page);
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
        await gateway.waitForRequest("sessions.list");
        for (const session of [true, false]) {
          if (!session) {
            await evaluateControlUiContext(page, (context) => context.navigate("new-session"));
            await expectBrowser(page.locator(".new-session-page")).toBeVisible();
          }
          const shell = page.locator(".shell--chat");
          await expectBrowser(shell).toBeVisible();
          await page.evaluate(`(async () => {
          const { showToast } = await import("/src/lib/toast.ts");
          showToast({ message: "Section removed. Sessions are unchanged.", durationMs: 60_000 });
        })()`);
          const toast = page.locator(".app-toast-lane--top-center > .app-toast");
          await expectBrowser(toast).toHaveText(/Section removed/);
          const expectedTop = await shell.evaluate(
            (element, { session: isSession, width: viewportWidth }) => {
              const style = getComputedStyle(element);
              const px = (name: string) => Number.parseFloat(style.getPropertyValue(name)) || 0;
              return (
                px("--safe-area-top") +
                (isSession
                  ? viewportWidth <= 768
                    ? px("--shell-topbar-height") + px("--chat-mobile-pane-header-height") + 20
                    : px("--rail-header-height") + 12
                  : 20)
              );
            },
            { session, width },
          );
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            const directory = suite.artifactDir;
            console.log("Toast proof: " + directory);
            await writeFile(
              path.join(directory, (session ? "session" : "new") + "-" + width + ".png"),
              await takeControlUiViewportScreenshot(page, shell, [toast]),
            );
          }
          const bounds = await toast.boundingBox();
          expect(bounds?.y).toBeCloseTo(expectedTop, 0);
          await toast.hover();
          await toast.getByRole("button", { name: "Dismiss", exact: true }).click();
          await expectBrowser(toast).toHaveCount(0);
        }
      },
    ),
  );
});
