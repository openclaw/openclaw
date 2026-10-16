// Browser sign-in reserves a tab before the Gateway returns its URL. When the
// Gateway stops answering first, that tab must close and the dialog must explain why.
import type { BrowserContext } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI browser sign-in with an unresponsive Gateway",
  startServerBeforeBrowser: true,
});

const detection = {
  candidates: [],
  manualProviders: [],
  authOptions: [{ id: "openrouter-oauth", label: "OpenRouter", kind: "oauth", featured: true }],
  workspace: "/tmp/openclaw-e2e",
  setupComplete: false,
};

async function reserveSignInTab(context: BrowserContext, click: () => Promise<void>) {
  const [reserved] = await Promise.all([context.waitForEvent("page"), click()]);
  expect(reserved.url()).toBe("about:blank");
  return reserved;
}

suite.define(() => {
  it("closes the sign-in tab and explains a start the Gateway never answers", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 800 } },
      async ({ page, context }) => {
        await page.clock.install();
        const gateway = await installMockGateway(page, {
          featureMethods: ["openclaw.setup.detect", "openclaw.setup.auth.start", "wizard.next"],
          heldMethods: ["openclaw.setup.auth.start"],
          methodResponses: { "openclaw.setup.detect": detection },
        });
        await page.goto(`${suite.server.baseUrl}settings/model-setup?firstRun=1`);
        const reserved = await reserveSignInTab(context, () =>
          page.locator('[data-auth-choice="openrouter-oauth"] button').click(),
        );
        await gateway.waitForRequest("openclaw.setup.auth.start");
        const closed = reserved.waitForEvent("close");
        await page.clock.runFor(30_000);
        await closed;
        const dialog = page.locator("openclaw-modal-dialog");
        const alert = dialog.getByRole("alert");
        await alert
          .getByText("The Gateway is not responding. Check that it is running, then try again.", {
            exact: true,
          })
          .waitFor();
        expect(await dialog.locator("details").count()).toBe(0);
      },
    );
  });

  it("closes the sign-in tab while the Gateway is away and offers the link after it returns", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 800 } },
      async ({ page, context }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["openclaw.setup.detect", "openclaw.setup.auth.start", "wizard.next"],
          heldMethods: ["wizard.next"],
          methodResponses: {
            "openclaw.setup.detect": detection,
            "openclaw.setup.auth.start": { done: false, status: "running" },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/model-setup?firstRun=1`);
        const reserved = await reserveSignInTab(context, () =>
          page.locator('[data-auth-choice="openrouter-oauth"] button').click(),
        );
        await gateway.waitForRequest("wizard.next");
        const closed = reserved.waitForEvent("close");
        await gateway.setOnline(false);
        await closed;
        const dialog = page.locator("openclaw-modal-dialog");
        const notice = dialog.getByRole("alert").filter({
          hasText: "The Gateway is not responding. Waiting for it to reconnect.",
        });
        await notice.waitFor();

        // The admitted wizard resumes; its URL stays reachable without the closed tab.
        await gateway.setOnline(true);
        await gateway.waitForRequest("wizard.next", { after: 1 });
        await gateway.deferNext("wizard.next", { answer: { stepId: "browser-note" } });
        await gateway.resolveDeferred("wizard.next", {
          done: false,
          status: "running",
          step: {
            id: "browser-note",
            type: "note",
            executor: "client",
            message: "Finish signing in in your browser.",
            externalUrl: "https://openrouter.example/auth",
          },
        });
        const openSignIn = dialog.getByRole("link", { name: "Open sign-in", exact: true });
        await openSignIn.waitFor();
        expect(await openSignIn.getAttribute("href")).toBe("https://openrouter.example/auth");
        expect(await notice.count()).toBe(0);
      },
    );
  });
});
