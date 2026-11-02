import type { BrowserContext, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import * as setup from "./model-setup-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI browser sign-in with an unresponsive Gateway",
  startServerBeforeBrowser: true,
});

const withPage = setup.setupPages(suite, () =>
  setup.setupContext({ viewport: { width: 1280, height: 800 } }),
);
const detection = setup.makeDetection({
  authOptions: [{ id: "openrouter-oauth", label: "OpenRouter", kind: "oauth", featured: true }],
});

async function startSignIn(page: Page, context: BrowserContext, held: string) {
  const gateway = await installMockGateway(page, {
    featureMethods: ["openclaw.setup.detect", "openclaw.setup.auth.start", "wizard.next"],
    heldMethods: [held],
    methodResponses: {
      "openclaw.setup.detect": detection,
      ...(held === "wizard.next" ? { "openclaw.setup.auth.start": setup.runningWizard() } : {}),
    },
  });
  await page.goto(`${suite.server.baseUrl}settings/model-setup?firstRun=1`);
  const [reserved] = await Promise.all([
    context.waitForEvent("page"),
    page.locator('[data-auth-choice="openrouter-oauth"] button').click(),
  ]);
  expect(reserved.url()).toBe("about:blank");
  await gateway.waitForRequest(held);
  const closed = reserved.waitForEvent("close");
  return { gateway, closed, dialog: page.locator("openclaw-modal-dialog") };
}

suite.define(() => {
  it("closes the sign-in tab and explains a start the Gateway never answers", async () => {
    await withPage(async ({ page, context }) => {
      await page.clock.install();
      const { closed, dialog } = await startSignIn(page, context, "openclaw.setup.auth.start");
      await page.clock.runFor(30_000);
      await closed;
      const error = "The Gateway is not responding. Check that it is running, then try again.";
      await dialog.getByRole("alert").getByText(error, { exact: true }).waitFor();
      expect(await dialog.locator("details").count()).toBe(0);
    });
  });

  it("closes the sign-in tab while the Gateway is away and offers the link after it returns", async () => {
    await withPage(async ({ page, context }) => {
      const { gateway, closed, dialog } = await startSignIn(page, context, "wizard.next");
      await gateway.setOnline(false);
      await closed;
      const notice = dialog.getByRole("alert").filter({
        hasText: "The Gateway is not responding. Waiting for it to reconnect.",
      });
      await notice.waitFor();

      // The admitted wizard resumes; its URL stays reachable without the closed tab.
      await gateway.setOnline(true);
      await gateway.waitForRequest("wizard.next", { after: 1 });
      await gateway.deferNext("wizard.next", { answer: { stepId: "browser-note" } });
      await gateway.resolveDeferred(
        "wizard.next",
        setup.runningStep("browser-note", "note", "Finish signing in in your browser.", {
          executor: "client",
          externalUrl: "https://openrouter.example/auth",
        }),
      );
      const openSignIn = dialog.getByRole("link", { name: "Reopen browser tab", exact: true });
      await openSignIn.waitFor();
      expect(await openSignIn.getAttribute("href")).toBe("https://openrouter.example/auth");
      expect(await notice.count()).toBe(0);
    });
  });
});
