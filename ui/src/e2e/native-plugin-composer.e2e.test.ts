import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Native plugin composer seams" });
const sessionKey = "agent:main:composer-seams";
const otherSessionKey = "agent:main:composer-seams-other";
const DRAFT = "first draft";
const PROPOSED = "A rewritten draft.";

// An icon composer action toggles a composer accessory, then proposes a replacement draft.
const fixture = `export default { id: "composer-fixture", activate(host) {
  const proof = globalThis.composerProof = { busy: false, outcomes: [], render: () => {} };
  host.ui.registerAction({
    id: "rewrite", label: "Rewrite", icon: "pencilSparkles", placement: "composer",
    resolve: () => ({ label: proof.busy ? "Stop rewrite" : "Rewrite", pressed: proof.busy }),
    async run({ composer, signal }) {
      proof.busy = true; proof.render(); host.ui.invalidate();
      await new Promise((resolve) => { proof.finish = resolve; signal.addEventListener("abort", resolve, { once: true }); });
      proof.busy = false; proof.render(); host.ui.invalidate();
      if (signal.aborted) return;
      proof.outcomes.push(await composer.propose(${JSON.stringify(PROPOSED)}, { title: "Fixture rewrite" }));
    },
  });
  host.ui.registerAction({
    id: "broken", label: "Broken", icon: "alertTriangle", placement: "composer",
    run() { throw new Error("Fixture action failed"); },
  });
  host.ui.registerAccessory({ id: "status", placement: "composer", mount(container) {
    const card = document.createElement("div");
    card.className = "composer-fixture-card";
    card.textContent = "Rewriting";
    container.append(card);
    proof.render = () => { card.hidden = !proof.busy; };
    proof.render();
    return { dispose: () => card.remove() };
  } });
} };`;

async function open(page: Page) {
  const gateway = await installMockGateway(page, {
    sessionKey,
    featureMethods: [
      ...defaultControlUiFeatureMethods,
      "plugins.controlUi.list",
      "plugins.controlUi.report",
    ],
    methodResponses: {
      "plugins.controlUi.list": {
        revision: "r1",
        diagnostics: [],
        plugins: [
          {
            pluginId: "composer-fixture",
            name: "Composer fixture",
            revision: "r1",
            entryUrl: "/__openclaw__/plugins/control-ui/composer-fixture/r1/index.js",
            styles: [],
          },
        ],
      },
      "plugins.controlUi.report": { ok: true },
    },
  });
  await page.route("**/__openclaw__/plugins/control-ui/composer-fixture/*/index.js", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: fixture }),
  );
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
  const textarea = page.locator(".agent-chat__composer-combobox textarea");
  await textarea.waitFor();
  await textarea.fill(DRAFT);
  return { gateway, textarea };
}

// Globals the fixture plugin and the mock Gateway install in the page.
type ComposerProofWindow = Window & {
  composerProof?: { finish?: () => void; outcomes: string[] };
  openclawControlUiE2eGateway: { findRequests: (method: string) => unknown[] };
};
const finish = (page: Page) =>
  page.evaluate(() => (window as unknown as ComposerProofWindow).composerProof?.finish?.());
const outcomes = (page: Page) =>
  page.evaluate(() => (window as unknown as ComposerProofWindow).composerProof?.outcomes ?? []);
const sendCount = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as ComposerProofWindow).openclawControlUiE2eGateway.findRequests(
        "chat.send",
      ).length,
  );

suite.define(() => {
  it("renders an icon action in the toolbar and an accessory in the composer float", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await open(page);
      const lead = page.locator(".agent-chat__composer-lead");
      const action = lead.getByRole("button", { name: "Rewrite", exact: true });
      await action.waitFor();
      expect(await action.getAttribute("aria-pressed")).toBe("false");
      // No text action bar above the composer, and an idle accessory adds no layout.
      expect(await page.locator(".chat-footer__context").isVisible()).toBe(false);
      await action.click();
      const card = page.locator(".composer-fixture-card");
      await card.waitFor();
      expect(await card.evaluate((el) => Boolean(el.closest(".agent-chat__composer-float")))).toBe(
        true,
      );
      expect(
        await lead.getByRole("button", { name: "Stop rewrite" }).getAttribute("aria-pressed"),
      ).toBe("true");
      await finish(page);
      await expect.poll(() => card.isHidden()).toBe(true);
    });
  });

  it("reports a failed toolbar action without resizing the composer", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await open(page);
      const input = page.locator(".agent-chat__input");
      const before = await input.boundingBox();
      await page
        .locator(".agent-chat__composer-lead")
        .getByRole("button", { name: "Broken" })
        .click();
      await page.getByRole("alert").filter({ hasText: "Fixture action failed" }).waitFor();
      expect(await input.boundingBox()).toEqual(before);
    });
  });

  it("offers a proposal that Tab accepts as one undoable edit, never sending", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const { textarea } = await open(page);
      await page.getByRole("button", { name: "Rewrite", exact: true }).click();
      await finish(page);
      const proposal = page.getByRole("region", { name: "Fixture rewrite" });
      await proposal.waitFor();
      expect(await textarea.inputValue()).toBe(DRAFT);
      await textarea.focus();
      await textarea.press("Tab");
      await expect.poll(() => textarea.inputValue()).toBe(PROPOSED);
      await expect.poll(() => outcomes(page)).toEqual(["accepted"]);
      await page.getByRole("button", { name: "Undo" }).click();
      await expect.poll(() => textarea.inputValue()).toBe(DRAFT);
      expect(await sendCount(page)).toBe(0);
    });
  });

  it("dismisses with Escape and when the chat changes", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const { gateway, textarea } = await open(page);
      const rewrite = page.getByRole("button", { name: "Rewrite", exact: true });
      await rewrite.click();
      await finish(page);
      await page.getByRole("region", { name: "Fixture rewrite" }).waitFor();
      await textarea.focus();
      await textarea.press("Escape");
      await expect.poll(() => outcomes(page)).toEqual(["dismissed"]);
      expect(await page.locator(".agent-chat__composer-proposal").count()).toBe(0);
      expect(await textarea.inputValue()).toBe(DRAFT);

      await rewrite.click();
      await finish(page);
      await page.getByRole("region", { name: "Fixture rewrite" }).waitFor();
      await gateway.setSessionsListResponse({
        sessions: [
          { key: sessionKey, kind: "direct", label: "First", updatedAt: 2 },
          { key: otherSessionKey, kind: "direct", label: "Second", updatedAt: 1 },
        ],
      });
      // In-app navigation keeps the pane and its composer state; only the chat changes.
      const other = controlUiSessionUrl(suite.server.baseUrl, otherSessionKey);
      await page.evaluate((url) => {
        history.pushState(null, "", url);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }, other);
      await page.waitForURL(other);
      await expect.poll(() => outcomes(page)).toEqual(["dismissed", "dismissed"]);
      expect(await page.locator(".agent-chat__composer-proposal").count()).toBe(0);
    });
  });
});
