import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { buildAuthHealthSummary } from "../../../src/agents/auth-health.js";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { layoutBox, polledAttribute } from "./chat-presentation.test-support.ts";
import { configSnapshot, pageRunner } from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { expandProvider } from "./model-providers.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI model provider profile outcomes" });
const NOW = Date.now();
const withPage = pageRunner(suite, {
  locale: "en-US",
  serviceWorkers: "block",
  viewport: { height: 1000, width: 1280 },
});
const text = (root: Locator, selector: string) => root.locator(selector).textContent();
const statusText = async (card: Locator) =>
  (await text(card, ".model-providers__head .settings-status"))?.trim();
const config = { ...configSnapshot({}, "accounts"), sourceConfig: {} };

const usage = (usedPercent: number, amount?: number, plan?: string) => ({
  updatedAt: NOW,
  providers: [
    {
      provider: "openai",
      displayName: "OpenAI",
      plan,
      windows: [
        {
          label: "5h",
          usedPercent: Math.max(0, usedPercent - 20),
          resetAt: NOW + 3 * 3_600_000,
        },
        { label: "Week", usedPercent, resetAt: NOW + 5 * 86_400_000 },
      ],
      billing:
        amount === undefined
          ? [{ type: "balance", amount: 9, unit: "USD" }]
          : [{ type: "balance", amount, unit: "credits" }],
    },
  ],
});

const subscriptions = [
  { name: "personal", used: 100, credits: 0 },
  { name: "work+team", used: 0, credits: 0, plan: "Plus" },
  { name: "studio", used: 35, credits: 12.75, plan: "Business" },
  { name: "backup", used: 72, plan: "Pro" },
];

async function openAccounts(page: Page, withUsage: boolean) {
  const accounts = (withUsage ? subscriptions : subscriptions.slice(0, 2)).map(({ name }) => ({
    profileId: `openai:${name}`,
    email: `${name}@example.com`,
    type: "oauth",
    status: "ok",
  }));
  const ids = accounts.map((account) => account.profileId);
  const provider = {
    provider: "openai",
    displayName: "OpenAI",
    status: "ok",
    profiles: accounts,
    profileOrder: ids,
  };
  const gateway = await installMockGateway(page, {
    featureMethods: [
      ...defaultControlUiFeatureMethods,
      "models.authOrderSet",
      ...(withUsage ? ["codex.accountUsage"] : []),
    ],
    models: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true }],
    methodResponses: {
      "config.get": config,
      "models.authStatus": { ts: NOW, providers: [provider] },
      "usage.status": withUsage ? usage(100) : { updatedAt: NOW, providers: [] },
      "codex.accountUsage": {
        cases: subscriptions.map(({ name, used, credits, plan }) => ({
          match: { profileId: `openai:${name}` },
          response: usage(used, credits, plan),
        })),
      },
    },
  });
  await page.goto(`${suite.server.baseUrl}settings/model-providers`);
  return { gateway, card: await expandProvider(page, "openai"), ids, provider, accounts };
}

suite.define(() => {
  it("explains saved account health separately from catalog availability", async () => {
    const health = buildAuthHealthSummary({
      store: {
        version: 1,
        profiles: {
          "xai:opaque-account": {
            type: "oauth",
            provider: "xai",
            access: "synthetic-access",
            refresh: "synthetic-refresh",
            expires: Date.now() + 60 * 60_000,
          },
        },
      },
    });
    const xai = health.providers[0]!;
    await withPage(async ({ page }) => {
      await installMockGateway(page, {
        methodResponses: {
          "config.get": config,
          "models.authStatus": {
            ts: NOW,
            providers: [
              {
                ...xai,
                displayName: "xAI",
                profiles: xai.profiles.map((profile) =>
                  Object.assign({}, profile, { source: "saved" }),
                ),
              },
              {
                provider: "minimax",
                displayName: "MiniMax",
                status: "ok",
                profiles: [
                  {
                    profileId: "minimax:opaque-account",
                    type: "oauth",
                    status: "ok",
                    source: "saved",
                    displayName: "Work account",
                  },
                ],
              },
            ],
          },
          "models.list": {
            models: [{ id: "test-model", name: "Test model", provider: "xai", available: true }],
            providerOutcomes: [
              { provider: "xai", status: "ready" },
              { provider: "minimax", status: "unavailable" },
            ],
          },
          "usage.status": { updatedAt: NOW, providers: [] },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/model-providers`);
      const xaiCard = await expandProvider(page, "xai");
      const minimaxCard = await expandProvider(page, "minimax");
      await expect.poll(() => statusText(xaiCard)).toBe("Ready");
      expect(await text(xaiCard, ".model-providers__profile-copy strong")).toBe(
        "Signed-in account",
      );
      // The row already reads Ready, so the healthy account does not repeat it.
      expect((await text(xaiCard, ".model-providers__profile-status"))?.trim()).toBe("");
      expect(await statusText(minimaxCard)).toContain("Models unavailable");
      expect(await text(minimaxCard, ".model-providers__profile-copy strong")).toBe("Work account");
      // The profile id stays reachable as the identity's title, not a separate disclosure.
      expect(await xaiCard.locator("details").count()).toBe(0);
      expect(
        await xaiCard.locator(".model-providers__profile-copy strong").getAttribute("title"),
      ).toBe("xai:opaque-account");
    });
  });

  it("shows independent Codex allowances without reporting an exhausted provider", async () => {
    await withPage(async ({ page }) => {
      const { card, gateway, accounts, ids, provider } = await openAccounts(page, true);
      const weekly = card.getByRole("group", { name: "Week", exact: true });
      const segments = weekly.locator("[data-account-segment]");
      const order = () =>
        segments.evaluateAll((els) => els.map((el) => el.getAttribute("data-account-segment")));
      await expect.poll(order).toEqual(ids);
      const emailButton = (email: string) =>
        card.getByRole("button", { name: `Account details: ${email}@example.com` });
      const workName = emailButton("work+team");
      await polledAttribute(workName, "title").toBe("work+team@example.com · Plus");
      expect(await emailButton("personal").getAttribute("title")).toBe("personal@example.com");
      for (const [index, account] of accounts.entries()) {
        expect(await segments.nth(index).getAttribute("aria-label")).toContain(
          account.email + " · Week · " + (100 - subscriptions[index]!.used) + "% left",
        );
      }
      expect(await card.locator(".provider-row__summary").textContent()).not.toContain("0% left");
      const shortWindow = card.getByRole("group", { name: "5h", exact: true });
      expect(await shortWindow.getByRole("button").count()).toBe(4);
      const work = weekly.getByRole("button", { name: /work\+team@example/ });
      await work.click();
      expect(
        await card.getByRole("status").filter({ hasText: "work+team@example.com" }).textContent(),
      ).toContain("100% left");
      await work.click();
      await gateway.deferNext("models.authOrderSet");
      const src = await layoutBox(work);
      const dest = await layoutBox(segments.first());
      await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
      await page.mouse.down();
      // Stop between slots: the grabbed header and both allowance cells follow the
      // pointer, while the original first column moves into the vacated slot.
      const distance = (src.x - dest.x) * 0.72;
      const midX = src.x + src.width / 2 - distance;
      const midY = src.y + src.height / 2;
      const firstColumn = card.locator(".model-providers__usage-track > :first-child");
      const secondColumn = card.locator(".model-providers__usage-track > :nth-child(2)");
      const positions = (column: Locator) =>
        column.evaluateAll((cells) => cells.map((cell) => cell.getBoundingClientRect().x));
      await page.mouse.move(midX, midY, { steps: 8 });
      const columnAt = (x: number) => Array.from({ length: 4 }, () => expect.closeTo(x, 0));
      await expect.poll(() => positions(secondColumn)).toEqual(columnAt(src.x - distance));
      await expect.poll(() => positions(firstColumn)).toEqual(columnAt(src.x));
      expect(await order()).toEqual(ids);
      const neighborTransition = () =>
        firstColumn.last().evaluate((cell) => getComputedStyle(cell).transitionDuration);
      expect(await neighborTransition()).not.toBe("0s");
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(await neighborTransition()).toBe("0s");
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.keyboard.press("Escape");
      await page.mouse.up();
      await expect.poll(() => positions(secondColumn)).toEqual(columnAt(src.x));
      expect(await gateway.getRequests("models.authOrderSet")).toHaveLength(0);
      // Move the emulated mouse away before switching to touch input.
      await page.mouse.move(0, 0);
      const touch = await page.context().newCDPSession(page);
      await touch.send("Emulation.setTouchEmulationEnabled", { enabled: true });
      const finishX = dest.x + dest.width / 2;
      const point = { x: src.x + src.width / 2, y: midY, id: 1 };
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ ...point, x: finishX }],
      });
      expect(await gateway.getRequests("models.authOrderSet")).toHaveLength(0);
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await touch.detach();
      const preferred = [ids[1], ids[0], ...ids.slice(2)];
      expect((await gateway.waitForRequest("models.authOrderSet")).params).toEqual({
        provider: "openai",
        agentId: "main",
        profileIds: preferred,
      });
      await expect.poll(order).toEqual(preferred);
      expect(await workName.getAttribute("aria-description")).toBe("Plus");
      expect(await card.locator('[data-account-segment][aria-pressed="true"]').count()).toBe(0);
      // Reordering the display must not duplicate reads before the normal post-save refresh.
      expect(await gateway.getRequests("codex.accountUsage")).toHaveLength(4);
      const saved = { ...provider, profileOrder: preferred, profileOrderStored: true };
      await gateway.setMethodResponse("models.authStatus", { ts: NOW, providers: [saved] });
      await gateway.resolveDeferred("models.authOrderSet", {
        provider: "openai",
        profileIds: preferred,
      });
      await card.getByRole("button", { name: "Clear custom order" }).waitFor();
      await work.focus();
      await work.press("ArrowRight");
      await expect
        .poll(async () => (await gateway.getRequests("models.authOrderSet")).at(-1)?.params)
        .toEqual({ provider: "openai", agentId: "main", profileIds: ids });
      await page.setViewportSize({ width: 400, height: 840 });
      // The shell changes its sidebar geometry on resize; assert the settled mobile layout.
      await expect
        .poll(() =>
          segments.evaluateAll((nodes) => {
            const boxes = nodes.map((node) => node.getBoundingClientRect());
            return {
              rows: new Set(boxes.map((box) => box.top)).size,
              fits: boxes.every((box) => box.left >= 0 && box.right <= 400),
            };
          }),
        )
        .toEqual({ rows: 1, fits: true });
      const credits = card.getByRole("group", { name: "Credits" });
      expect(
        await credits.locator(".model-providers__credit > span:nth-child(2)").allTextContents(),
      ).toEqual(["0", "0", "12.75", "—"]);
      expect(await card.locator("[data-profile-id]").count()).toBe(0);
      await emailButton("backup").click();
      const backup = card.locator('[data-profile-id="openai:backup"]');
      expect(await backup.getByText("Pro", { exact: true }).isVisible()).toBe(true);
      expect(await backup.getByText("$9.00", { exact: true }).isVisible()).toBe(true);
      expect(await backup.getByRole("button", { name: /^Reorder / }).count()).toBe(0);
    });
  });

  it("moves the focused allowance left in a right-to-left chart", async () => {
    await withPage(async ({ page }) => {
      const { card, gateway, ids } = await openAccounts(page, true);
      await card.evaluate((el) => el.setAttribute("dir", "rtl"));
      const weekly = card.getByRole("group", { name: "Week", exact: true });
      const work = weekly.getByRole("button", { name: /work\+team@example/ });
      const studio = weekly.getByRole("button", { name: /studio@example/ });
      const slot = (await layoutBox(studio)).x;
      expect(slot).toBeLessThan((await layoutBox(work)).x);
      await gateway.deferNext("models.authOrderSet");
      await work.focus();
      await page.keyboard.press("ArrowLeft");
      const profileIds = [ids[0], ids[2], ids[1], ids[3]];
      expect((await gateway.waitForRequest("models.authOrderSet")).params).toEqual({
        agentId: "main",
        provider: "openai",
        profileIds,
      });
      await expect.poll(async () => (await layoutBox(work)).x).toBeCloseTo(slot, 0);
      expect(await work.evaluate((el) => el === document.activeElement)).toBe(true);
      await gateway.resolveDeferred("models.authOrderSet", { provider: "openai", profileIds });
    });
  });

  it("lifts an account, makes room during dragging, and saves its dropped priority", async () => {
    await withPage(async ({ page }) => {
      const { card, gateway, ids } = await openAccounts(page, false);
      const firstRow = card.locator(`[data-profile-id="${ids[0]}"]`);
      const secondRow = card.locator(`[data-profile-id="${ids[1]}"]`);
      const grip = firstRow.locator(".model-providers__profile-grip");
      await expect.poll(() => grip.isEnabled()).toBe(true);
      // The drag ends over the lower account, so keep both rows inside the viewport.
      await secondRow.scrollIntoViewIfNeeded();
      const start = await layoutBox(grip);
      const first = await layoutBox(firstRow);
      const second = await layoutBox(secondRow);
      await gateway.deferNext("models.authOrderSet");
      const x = start.x + start.width / 2;
      const y = start.y + start.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y + first.height * 0.75, { steps: 6 });
      await expect.poll(async () => (await firstRow.boundingBox())?.y).toBeGreaterThan(first.y);
      await expect.poll(async () => (await secondRow.boundingBox())?.y).toBeLessThan(second.y);
      expect(await gateway.getRequests("models.authOrderSet")).toHaveLength(0);
      await page.mouse.up();
      const request = await gateway.waitForRequest("models.authOrderSet");
      const profileIds = [ids[1], ids[0]];
      expect(request.params).toEqual({ agentId: "main", provider: "openai", profileIds });
      const visibleOrder = () =>
        card
          .locator(".model-providers__profile")
          .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-profile-id")));
      await expect.poll(visibleOrder).toEqual(profileIds);
      expect(await card.getByText("Saving", { exact: true }).count()).toBe(0);
      await gateway.resolveDeferred("models.authOrderSet", { provider: "openai", profileIds });
    });
  });
});
