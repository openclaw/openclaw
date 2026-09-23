import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createSidebarFooterProofSuite } from "./sidebar-footer-proof.test-support.ts";

const suite = createSidebarFooterProofSuite("Sidebar identity name overflow");
const longName = "Riley Morgan and the extraordinarily long research workspace";
const names: Array<{
  kind: string;
  name: string;
  overflow: boolean;
  rtl: boolean;
  workspace?: boolean;
}> = [
  { kind: "short", name: "Riley", overflow: false, rtl: false },
  { kind: "long", name: longName, overflow: true, rtl: false },
  { kind: "workspace", name: longName, overflow: true, rtl: false, workspace: true },
  { kind: "very long", name: `${longName} · ${longName}`, overflow: true, rtl: false },
  { kind: "emoji", name: `🧑🏽‍🚀 Riley 🔬 ${longName}`, overflow: true, rtl: false },
  {
    kind: "RTL",
    name: "فريق البحث والتطوير والتعاون في المشاريع العلمية الطويلة",
    overflow: true,
    rtl: true,
  },
];

async function openNames(page: Page, name: string, workspace = false) {
  await page.addInitScript(
    ({ key, name: displayName, workspace: workspaceMode }) => {
      localStorage.setItem(
        key,
        JSON.stringify({ sidebarAgentsMode: workspaceMode ? "roster" : "chip" }),
      );
      if (workspaceMode) {
        Object.assign(window, {
          __OPENCLAW_NATIVE_GATEWAYS__: {
            currentId: "marquee-fixture",
            gateways: [
              {
                id: "marquee-fixture",
                name: displayName,
                kind: "local",
                isPrimary: false,
                canPromote: false,
                health: "ok",
              },
            ],
          },
        });
      }
    },
    { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), name, workspace },
  );
  const agentsList = {
    defaultId: "main",
    mainKey: "main",
    scope: "per-sender",
    agents: [{ id: "main", name }],
  };
  await installMockGateway(page, {
    presenceUsers: [{ self: true, id: "riley", name }],
    methodResponses: {
      "agents.list": agentsList,
      "agent.identity.get": { agentId: "main", name },
      "chat.startup": {
        agentsList,
        messages: [],
        metadata: { models: [] },
        sessionId: "marquee-session",
        thinkingLevel: null,
      },
    },
  });
  await page.goto(`${suite.server.baseUrl}chat`);
  const sidebar = page.locator("openclaw-app-sidebar");
  const labels = [
    sidebar.locator(".sidebar-identity-card__name"),
    sidebar.locator(".sidebar-agent-card__name-text"),
  ];
  for (const label of labels) {
    await expect.poll(() => label.textContent()).toBe(name);
  }
  return labels;
}

function readName(label: Locator) {
  return label.evaluate((element) => {
    const nodes = [element, ...element.querySelectorAll("*")];
    const moving = nodes.find((node) => getComputedStyle(node).transform !== "none");
    const text = document.createRange();
    text.selectNodeContents(element);
    return {
      mask: getComputedStyle(element).maskImage,
      overflow: element.scrollWidth > element.clientWidth,
      distance: text.getBoundingClientRect().width - element.clientWidth,
      x: moving ? new DOMMatrixReadOnly(getComputedStyle(moving).transform).m41 : 0,
      animating: element
        .getAnimations({ subtree: true })
        .some(
          (animation) =>
            animation.effect instanceof KeyframeEffect &&
            animation.effect.getKeyframes().some((frame) => "transform" in frame),
        ),
    };
  });
}

async function seekName(label: Locator, iteration: number) {
  await label.evaluate((element, progress) => {
    const animations = element.getAnimations({ subtree: true });
    const movement = animations.find(
      (animation) =>
        animation.effect instanceof KeyframeEffect &&
        animation.effect.getKeyframes().some((frame) => "transform" in frame),
    );
    if (!movement?.effect) {
      throw new Error("Overflowing identity name has no translation animation");
    }
    const timing = movement.effect.getTiming();
    const time = Number(timing.delay) + Number(timing.duration) * progress;
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = time;
    }
  }, iteration);
}

suite.define(() => {
  it.each(names)(
    "reveals the $kind name without moving either identity control",
    async ({ name, overflow, rtl, workspace }) => {
      await suite.withPage(
        { viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference" },
        async ({ page }) => {
          const labels = await openNames(page, name, workspace);
          for (const label of labels) {
            await page.mouse.move(1400, 850);
            const button = label.locator("xpath=ancestor::button[1]");
            await expect.poll(async () => (await readName(label)).overflow).toBe(overflow);
            await expect.poll(async () => (await readName(label)).mask !== "none").toBe(overflow);
            expect((await readName(label)).animating).toBe(false);
            expect(await button.getAttribute("aria-label")).toContain(name);
            const bounds = await button.boundingBox();
            await button.hover();
            if (!overflow) {
              expect((await readName(label)).animating).toBe(false);
              continue;
            }
            await expect.poll(async () => (await readName(label)).animating).toBe(true);
            await page.mouse.move(1400, 850);
            await expect.poll(async () => (await readName(label)).animating).toBe(false);
            expect((await readName(label)).x).toBe(0);
            await button.hover();
            await expect.poll(async () => (await readName(label)).animating).toBe(true);
            await seekName(label, 0);
            expect((await readName(label)).x).toBeCloseTo(0, 1);
            await seekName(label, 0.5);
            const end = await readName(label);
            expect(rtl ? end.x : -end.x).toBeGreaterThan(0);
            expect(Math.abs(end.x)).toBeGreaterThanOrEqual(end.distance - 1);
            expect(await button.boundingBox()).toEqual(bounds);
            await seekName(label, 1);
            expect((await readName(label)).x).toBeCloseTo(0, 1);
          }
        },
      );
    },
  );

  it("reveals names for keyboard focus and keeps reduced-motion names static and accessible", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference" },
      async ({ page }) => {
        const labels = await openNames(page, longName);
        await page.mouse.move(1400, 850);
        for (const label of labels) {
          const button = label.locator("xpath=ancestor::button[1]");
          await page.keyboard.press("Tab");
          await button.focus();
          expect(await button.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
          await expect.poll(async () => (await readName(label)).animating).toBe(true);
          await page.emulateMedia({ reducedMotion: "reduce" });
          await expect.poll(async () => (await readName(label)).animating).toBe(false);
          expect((await readName(label)).x).toBe(0);
          expect(await button.getAttribute("aria-label")).toContain(longName);
          await page.emulateMedia({ reducedMotion: "no-preference" });
        }
      },
    );
  });

  it("stops touch name animations when the mobile drawer closes and restores them on reopening", async () => {
    await suite.withPage(
      { viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: "no-preference" },
      async ({ page }) => {
        const labels = await openNames(page, `${longName} · ${longName}`);
        for (const label of labels) {
          const button = label.locator("xpath=ancestor::button[1]");
          const toggle = page
            .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
            .first();
          await toggle.tap();
          await expect
            .poll(() => button.evaluate((element) => element.getBoundingClientRect().left >= 0))
            .toBe(true);
          await expect.poll(async () => (await readName(label)).overflow).toBe(true);
          await button.tap();
          await expect.poll(() => button.getAttribute("aria-expanded")).toBe("true");
          await expect.poll(async () => (await readName(label)).animating).toBe(true);
          await page.keyboard.press("Escape");
          await expect.poll(() => button.getAttribute("aria-expanded")).toBe("false");
          await expect
            .poll(() => button.evaluate((element) => element.getBoundingClientRect().right <= 0))
            .toBe(true);
          await expect.poll(async () => (await readName(label)).animating).toBe(false);
          expect((await readName(label)).x).toBe(0);
          await toggle.tap();
          await button.tap();
          await expect.poll(async () => (await readName(label)).animating).toBe(true);
          await page.keyboard.press("Escape");
          await expect
            .poll(() => button.evaluate((element) => element.getBoundingClientRect().right <= 0))
            .toBe(true);
          await expect.poll(async () => (await readName(label)).animating).toBe(false);
        }
      },
    );
  });

  it("uses the existing account-menu tap to reveal an overflowing name on touch", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, hasTouch: true, reducedMotion: "no-preference" },
      async ({ page }) => {
        const [label] = await openNames(page, longName);
        const button = label!.locator("xpath=ancestor::button[1]");
        expect((await readName(label!)).animating).toBe(false);
        await button.tap();
        await expect.poll(() => button.getAttribute("aria-expanded")).toBe("true");
        await expect.poll(async () => (await readName(label!)).animating).toBe(true);
        await page.keyboard.press("Escape");
        await expect.poll(() => button.getAttribute("aria-expanded")).toBe("false");
      },
    );
  });
});
