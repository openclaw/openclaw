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

// An icon composer action runs a host task: working with steps, then a proposal or a failure.
const fixture = `export default { id: "composer-fixture", activate(host) {
  const proof = globalThis.composerProof = { outcomes: [], runs: 0, mode: "propose" };
  host.ui.registerAction({
    id: "rewrite", label: "Rewrite", icon: "pencilSparkles", placement: "composer",
    async run({ composer }) {
      proof.runs += 1;
      const task = composer.startTask({ title: "Rewriting" });
      proof.cancelled = false;
      task.signal.addEventListener("abort", () => { proof.cancelled = true; }, { once: true });
      task.update({ summary: "2 steps", steps: [{ label: "read notes.md", state: "done" }, { label: "ls src", state: "running" }] });
      await new Promise((resolve) => { proof.finish = () => (resolve(), true); task.signal.addEventListener("abort", resolve, { once: true }); });
      if (task.signal.aborted) return;
      if (proof.mode === "fail") { task.fail("Fixture model unavailable"); return; }
      proof.outcomes.push(await task.propose(${JSON.stringify(PROPOSED)}, { title: "Fixture rewrite" }));
    },
  });
  host.ui.registerAction({
    id: "insert", label: "Insert rewrite", icon: "wandSparkles", placement: "composer",
    resolve: ({ draft }) => ({ disabled: !draft?.trim() }),
    async run({ composer }) {
      const task = composer.startTask({ title: "Inserting" });
      proof.outcomes.push(await task.propose(${JSON.stringify(PROPOSED)}, { title: "Fixture insert", insert: true }));
    },
  });
  // Work that outlives the chat on screen: leaving retires the card, attach shows it again.
  const resume = async (composer, startedAt) => {
    const task = composer.startTask({ title: "Resuming", startedAt });
    task.update({ steps: [{ label: "read notes.md", state: "running" }] });
    await new Promise((resolve) => { proof.finishResume = () => (resolve(), true); task.signal.addEventListener("abort", resolve, { once: true }); });
    if (task.signal.aborted) return;
    proof.resumeStartedAt = undefined;
    await task.propose(${JSON.stringify(PROPOSED)}, { title: "Fixture resume", insert: true });
  };
  host.ui.registerAction({
    id: "resume", label: "Resumable rewrite", icon: "rocket", placement: "composer",
    async run({ composer, sessionKey }) { proof.resumeIn = sessionKey; proof.resumeStartedAt = Date.now() - 60000; await resume(composer, proof.resumeStartedAt); },
    async attach({ composer, sessionKey }) { if (proof.resumeStartedAt && proof.resumeIn === sessionKey) await resume(composer, proof.resumeStartedAt); },
  });
  host.ui.registerAction({
    id: "send", label: "Rewrite and send", icon: "rocket", placement: "composer",
    async run({ composer }) {
      const task = composer.startTask({ title: "Sending" });
      proof.outcomes.push(await task.propose(${JSON.stringify(PROPOSED)}, { title: "Fixture send", send: true }));
    },
  });
  host.ui.registerAction({
    id: "replace", label: "Replace draft", icon: "pencil", placement: "composer",
    run({ composer }) { composer.setDraft("written by another action"); },
  });
  host.ui.registerAction({
    id: "restore", label: "Restore rewrite", icon: "rotateCcw", placement: "composer",
    run({ composer }) { composer.setDraft(${JSON.stringify(PROPOSED)}); },
  });
  host.ui.registerAction({
    id: "replace-broken", label: "Replace and break", icon: "sparkles", placement: "composer",
    async run({ composer }) {
      const first = composer.startTask({ title: "First" });
      composer.startTask({ title: "Second" });
      proof.firstAborted = first.signal.aborted;
      await Promise.resolve();
      throw new Error("Second task failed");
    },
  });
  host.ui.registerAction({
    id: "after-propose", label: "Propose then break", icon: "pencilSparkles", placement: "composer",
    async run({ composer }) {
      const task = composer.startTask({ title: "Proposing" });
      await task.propose("Proposed text", { title: "Fixture proposal" });
      throw new Error("Follow-up failed");
    },
  });
  host.ui.registerAction({
    id: "slow-broken", label: "Slow broken", icon: "pencilLine", placement: "composer",
    async run() {
      await new Promise((resolve) => { proof.failSlow = resolve; });
      throw new Error("Slow fixture failed");
    },
  });
  host.ui.registerAction({
    id: "broken", label: "Broken", icon: "alertTriangle", placement: "composer",
    run() { throw new Error("Fixture action failed"); },
  });
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
  composerProof?: {
    finish?: () => boolean;
    outcomes: string[];
    runs: number;
    mode: string;
    cancelled?: boolean;
    failSlow?: () => void;
    firstAborted?: boolean;
    finishResume?: () => boolean;
  };
  openclawControlUiE2eGateway: { findRequests: (method: string) => unknown[] };
};
const finish = (page: Page) =>
  page.waitForFunction(() => (window as unknown as ComposerProofWindow).composerProof?.finish?.());
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
  it("runs a task in one composer card; the pressed icon cancels it", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await open(page);
      const lead = page.locator(".agent-chat__composer-lead");
      const action = lead.getByRole("button", { name: "Rewrite", exact: true });
      await action.waitFor();
      expect(await action.getAttribute("aria-pressed")).toBe("false");
      // Idle: no card and no text action bar above the composer.
      expect(await page.locator(".chat-footer__context").isVisible()).toBe(false);
      await action.click();
      const card = page.locator('.agent-chat__composer-task[data-state="working"]');
      await card.waitFor();
      expect(await card.evaluate((el) => Boolean(el.closest(".agent-chat__composer-float")))).toBe(
        true,
      );
      await card.getByText("ls src").waitFor();
      await expect.poll(() => action.getAttribute("aria-pressed")).toBe("true");
      await action.click();
      await expect.poll(() => card.count()).toBe(0);
      expect(
        await page.evaluate(
          () => (window as unknown as ComposerProofWindow).composerProof?.cancelled,
        ),
      ).toBe(true);
      expect(await action.getAttribute("aria-pressed")).toBe("false");
    });
  });

  it("shows a failure in place and Try again runs the action again", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const { textarea } = await open(page);
      await page.evaluate(() => {
        (window as unknown as ComposerProofWindow).composerProof!.mode = "fail";
      });
      await page.getByRole("button", { name: "Rewrite", exact: true }).click();
      await finish(page);
      const failed = page.locator('.agent-chat__composer-task[data-state="failed"]');
      await failed.getByText("Fixture model unavailable").waitFor();
      expect(await textarea.inputValue()).toBe(DRAFT);
      await failed.getByRole("button", { name: "Try again" }).click();
      await page.locator('.agent-chat__composer-task[data-state="working"]').waitFor();
      expect(
        await page.evaluate(() => (window as unknown as ComposerProofWindow).composerProof?.runs),
      ).toBe(2);
    });
  });

  it("reports a failed toolbar action without resizing the composer", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await open(page);
      const input = page.locator(".agent-chat__input");
      const before = await input.boundingBox();
      await page
        .locator(".agent-chat__composer-lead")
        .getByRole("button", { name: "Broken", exact: true })
        .click();
      await page
        .locator('.agent-chat__composer-task[data-state="failed"]')
        .getByText("Fixture action failed")
        .waitFor();
      expect(await input.boundingBox()).toEqual(before);
    });
  });

  it("aborts a replaced task at once and fails the latest one on rejection", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await open(page);
      const action = page.getByRole("button", { name: "Replace and break", exact: true });
      await action.click();
      const failed = page.locator('.agent-chat__composer-task[data-state="failed"]');
      await failed.getByText("Second task failed").waitFor();
      expect(
        await page.evaluate(
          () => (window as unknown as ComposerProofWindow).composerProof?.firstAborted,
        ),
      ).toBe(true);
      expect(await action.getAttribute("aria-pressed")).toBe("false");
    });
  });

  it("reports a rejection after the task settles, keeping an Undo receipt", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const { textarea } = await open(page);
      const action = page.getByRole("button", { name: "Propose then break", exact: true });
      const proposal = page.getByRole("region", { name: "Fixture proposal" });
      const failed = page.locator('.agent-chat__composer-task[data-state="failed"]');
      await action.click();
      await proposal.waitFor();
      await textarea.focus();
      await textarea.press("Escape");
      await failed.getByText("Follow-up failed").waitFor();
      await action.click();
      await proposal.waitFor();
      await textarea.press("Tab");
      await expect.poll(() => textarea.inputValue()).toBe("Proposed text");
      await page.getByRole("alert").filter({ hasText: "Follow-up failed" }).waitFor();
      await page.getByRole("button", { name: "Undo" }).waitFor();
      expect(await failed.count()).toBe(0);
    });
  });

  it("does not let a late toolbar failure take over another action's task", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await open(page);
      await page.getByRole("button", { name: "Slow broken", exact: true }).click();
      await page.getByRole("button", { name: "Rewrite", exact: true }).click();
      const working = page.locator('.agent-chat__composer-task[data-state="working"]');
      await working.waitFor();
      await page.evaluate(() =>
        (window as unknown as ComposerProofWindow).composerProof?.failSlow?.(),
      );
      await page.getByRole("alert").filter({ hasText: "Slow fixture failed" }).waitFor();
      expect(await working.count()).toBe(1);
      expect(
        await page.evaluate(
          () => (window as unknown as ComposerProofWindow).composerProof?.cancelled,
        ),
      ).toBe(false);
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

  it("groups phone toolbar actions by plugin and keeps the invoked task alive after closing +", async () => {
    const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
    await suite.withPage(phone, async ({ page }) => {
      const { textarea } = await open(page);
      const plus = page.getByRole("button", { name: "Add attachment" });
      const group = page.getByRole("menuitem", { name: "Composer fixture", exact: true });
      await page.route("**/__openclaw__/plugin-icon/composer-fixture", (route) =>
        route.fulfill({ path: "extensions/knowledge/assets/icon.png", contentType: "image/png" }),
      );
      await textarea.fill("");
      await page.mouse.click(100, 80);
      await page.locator('.agent-chat__composer-shell[data-composer-resting="true"]').waitFor();
      await plus.click();
      const artwork = group.locator("img");
      await expect
        .poll(() =>
          artwork.evaluate((image) => image instanceof HTMLImageElement && image.naturalWidth > 0),
        )
        .toBe(true);
      await group.click();
      expect(
        await page.getByRole("menuitem", { name: "Insert rewrite", exact: true }).isDisabled(),
      ).toBe(true);
      await page.keyboard.press("Escape");
      await textarea.fill(DRAFT);
      expect(await page.locator(".agent-chat__composer-action").count()).toBe(0);
      await plus.click();
      await group.click();
      expect(
        await page.getByRole("menuitem", { name: "Insert rewrite", exact: true }).isEnabled(),
      ).toBe(true);
      await page.getByRole("menuitem", { name: "Rewrite", exact: true }).click();
      await page.locator('.agent-chat__composer-task[data-state="working"]').waitFor();
      expect(await plus.getAttribute("aria-expanded")).toBe("false");
      await finish(page);
      await page.getByRole("button", { name: "Use", exact: true }).click();
      await expect.poll(() => textarea.inputValue()).toBe(PROPOSED);
      expect(await sendCount(page)).toBe(0);
    });
  });

  it("needs a draft, then inserts its result at once with an Undo receipt", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const { textarea } = await open(page);
      const action = page.getByRole("button", { name: "Insert rewrite", exact: true });
      await textarea.fill("");
      await expect.poll(() => action.isDisabled()).toBe(true);
      await textarea.fill(DRAFT);
      await expect.poll(() => action.isDisabled()).toBe(false);
      await action.click();
      await expect.poll(() => textarea.inputValue()).toBe(PROPOSED);
      expect(await outcomes(page)).toEqual(["accepted"]);
      expect(await page.getByRole("region", { name: "Fixture insert" }).count()).toBe(0);
      await page.getByRole("button", { name: "Undo" }).click();
      await expect.poll(() => textarea.inputValue()).toBe(DRAFT);
      expect(await sendCount(page)).toBe(0);
    });
  });

  it("sends an inserted result through the composer's own send", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const { textarea } = await open(page);
      await page.getByRole("button", { name: "Rewrite and send", exact: true }).click();
      await expect.poll(() => sendCount(page)).toBe(1);
      const sent = await page.evaluate(
        () =>
          (window as unknown as ComposerProofWindow).openclawControlUiE2eGateway.findRequests(
            "chat.send",
          )[0] as { params?: { message?: string } },
      );
      expect(sent.params?.message).toBe(PROPOSED);
      await expect.poll(() => textarea.inputValue()).toBe("");
      expect(await page.getByRole("button", { name: "Undo" }).count()).toBe(0);
    });
  });

  it("retires the Undo receipt when the draft changes outside the textarea", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const { textarea } = await open(page);
      await page.getByRole("button", { name: "Rewrite", exact: true }).click();
      await finish(page);
      await page.getByRole("region", { name: "Fixture rewrite" }).waitFor();
      await textarea.focus();
      await textarea.press("Tab");
      await expect.poll(() => textarea.inputValue()).toBe(PROPOSED);
      await page.getByRole("button", { name: "Undo" }).waitFor();
      await page.getByRole("button", { name: "Replace draft", exact: true }).click();
      await expect.poll(() => textarea.inputValue()).toBe("written by another action");
      await expect.poll(() => page.getByRole("button", { name: "Undo" }).count()).toBe(0);
      await page.getByRole("button", { name: "Restore rewrite", exact: true }).click();
      await expect.poll(() => textarea.inputValue()).toBe(PROPOSED);
      await page.waitForTimeout(300);
      expect(await page.getByRole("button", { name: "Undo" }).count()).toBe(0);
    });
  });

  it("shows a chat's running task again when the user comes back", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const { gateway } = await open(page);
      await page.getByRole("button", { name: "Resumable rewrite", exact: true }).click();
      const working = page.locator('.agent-chat__composer-task[data-state="working"]');
      await working.getByText("Resuming").waitFor();
      await gateway.setSessionsListResponse({
        sessions: [
          { key: sessionKey, kind: "direct", label: "First", updatedAt: 2 },
          { key: otherSessionKey, kind: "direct", label: "Second", updatedAt: 1 },
        ],
      });
      const go = (url: string) =>
        page.evaluate((target) => {
          history.pushState(null, "", target);
          window.dispatchEvent(new PopStateEvent("popstate"));
        }, url);
      await go(controlUiSessionUrl(suite.server.baseUrl, otherSessionKey));
      await expect.poll(() => working.count()).toBe(0);
      await go(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await working.getByText("Resuming").waitFor();
      // The clock continues from the original start, not from the return.
      await working.getByText(/^1m 0\ds$/).waitFor();
      await page.waitForFunction(() =>
        (window as unknown as ComposerProofWindow).composerProof?.finishResume?.(),
      );
      // The other chat's pane stays mounted, hidden; the result lands in this chat's composer.
      const shown = page.locator(".agent-chat__composer-combobox textarea:visible");
      await expect.poll(() => shown.inputValue()).toBe(PROPOSED);
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
      expect(await page.locator(".agent-chat__composer-task").count()).toBe(0);
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
      expect(await page.locator(".agent-chat__composer-task").count()).toBe(0);
    });
  });
});
