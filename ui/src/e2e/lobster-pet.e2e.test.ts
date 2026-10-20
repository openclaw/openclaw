import type { BrowserContext, Page } from "playwright";
import { afterEach, beforeEach, expect, it } from "vitest";
import { planLobsterPasser } from "../components/lobster-pet-plans.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installMockGateway } from "./new-session-page.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI lobster pet",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium cannot start at ${executablePath}`,
});

type BrowserLobsterPet = HTMLElement & {
  mode: "idle" | "busy" | "offline";
  runOutcome: "ok" | "error" | "aborted";
  seed: number;
  updateComplete: Promise<unknown>;
};

let context: BrowserContext;
let page: Page;
async function configureComposerPet(
  seed: number,
  mode: BrowserLobsterPet["mode"] = "offline",
  runOutcome: BrowserLobsterPet["runOutcome"] = "ok",
) {
  const composerPet = page.locator(".new-session-page__composer openclaw-lobster-pet");
  await composerPet.evaluate(
    async (element, fixture) => {
      const pet = Object.assign(element as BrowserLobsterPet, fixture);
      await pet.updateComplete;
    },
    { seed, mode, runOutcome },
  );
}

async function advancePet(ms: number, fast = false) {
  await page.clock[fast ? "fastForward" : "runFor"](ms);
  await page.evaluate(
    () => (document.querySelector("openclaw-lobster-pet") as BrowserLobsterPet).updateComplete,
  );
}

suite.define(() => {
  beforeEach(async () => {
    context = await suite.browser.newContext({
      hasTouch: true,
      viewport: { width: 1440, height: 900 },
    });
    page = await context.newPage();
    await page.clock.install({ time: new Date("2026-07-09T12:00:00") });
    await installMockGateway(page, {
      agentModel: "openai/demo",
      models: [{ id: "demo", name: "Demo model", provider: "openai" }],
    });
    await page.goto(`${suite.server.baseUrl}new`);
    await page.waitForFunction(() => Boolean(customElements.get("openclaw-lobster-pet")));
    const loadedAt = await page.evaluate(() => Date.now());
    await page.clock.pauseAt(loadedAt + 1_000);
  });

  afterEach(() => context.close());

  it("keeps a vigil-only failure present through droop and sweep before leaving", async () => {
    await configureComposerPet(0, "busy", "error");
    const sprite = page.locator(".lobster-pet");
    await expect.poll(() => sprite.count()).toBe(0);

    await advancePet(600_500, true);
    expect(await page.locator(".lobster-pet--vigil").count()).toBe(1);
    await page.evaluate(async () => {
      const pet = document.querySelector("openclaw-lobster-pet") as BrowserLobsterPet;
      pet.mode = "idle";
      await pet.updateComplete;
    });

    for (const [act, duration] of [
      ["droop", 1_599],
      ["sweep", 1_799],
    ] as const) {
      const animation = page.locator(`.lobster-pet--act-${act}`);
      expect(await animation.count()).toBe(1);
      await advancePet(duration);
      expect(await animation.count()).toBe(1);
      await advancePet(1);
    }

    expect(await page.locator(".lobster-pet--away").count()).toBe(1);
    await page.clock.runFor(350);
    await expect.poll(() => sprite.count()).toBe(0);
  });

  it("does not pet after Chromium cancels a sub-threshold touch hold", async () => {
    await configureComposerPet(42);
    const sprite = page.locator(".lobster-pet");
    await sprite.waitFor();

    await sprite.dispatchEvent("pointerdown", { pointerId: 1, pointerType: "touch" });
    await page.clock.runFor(300);
    await sprite.dispatchEvent("pointercancel", { pointerId: 1, pointerType: "touch" });
    await page.clock.runFor(400);

    await expect.poll(() => page.locator(".lobster-pet--act-pet").count()).toBe(0);
  });

  it("keeps resting visitors proportionate and aligned with their perch", async () => {
    for (const seed of [0, 42, 77, 1234]) {
      await configureComposerPet(seed);
      await page.clock.runFor(1600);
      const shape = await page.locator("openclaw-lobster-pet").evaluate((pet) => {
        for (const animation of pet.getAnimations({ subtree: true })) {
          animation.pause();
          animation.currentTime = Number(animation.effect?.getTiming().delay) || 0;
        }
        const sprite = pet.querySelector(
          ".lobster-pet__motion > .lobster-pet:not(.lobster-pet--twin)",
        )!;
        const svg = sprite.querySelector<SVGSVGElement>(".lobster-pet__svg")!;
        const matrix = svg.getScreenCTM()!;
        const foot = new DOMPoint(60, 105).matrixTransform(matrix);
        return {
          aspect: Math.hypot(matrix.a, matrix.b) / Math.hypot(matrix.c, matrix.d),
          footOffset: foot.y - sprite.getBoundingClientRect().bottom,
        };
      });
      expect(shape.aspect).toBeCloseTo(1, 2);
      expect(Math.abs(shape.footOffset)).toBeLessThan(0.2);
    }
  });

  it("uses the composer ledge and floor, then clears the floor as soon as typing starts", async () => {
    await configureComposerPet(108);
    expect(await page.locator("openclaw-app-sidebar openclaw-lobster-pet").count()).toBe(0);
    const pet = page.locator(".new-session-page__composer openclaw-lobster-pet");
    await expect.poll(() => pet.getAttribute("data-scene-ready")).not.toBeNull();
    await page.clock.runFor(1500);
    for (let frame = 0; frame < 30 && (await pet.getAttribute("data-spot")) !== "floor"; frame++) {
      await advancePet(500, true);
    }
    expect({
      spot: await pet.getAttribute("data-spot"),
      hops: await pet.locator(".lobster-pet__motion--hop").count(),
    }).toEqual({ spot: "floor", hops: 1 });
    const landings = await pet.evaluate((element) => {
      const sprite = element.querySelector<HTMLElement>(
        ".lobster-pet__motion > .lobster-pet:not(.lobster-pet--twin)",
      )!;
      const body = sprite.querySelector<HTMLElement>(".lobster-pet__body")!;
      const animation = body
        .getAnimations()
        .find((entry) => (entry as CSSAnimation).animationName === "lobster-pet-landing")!;
      animation.pause();
      const frames = [0.14, 0.86].map((fraction) => {
        animation.currentTime = Number(animation.effect!.getTiming().duration) * fraction;
        const box = body.getBoundingClientRect();
        const parent = sprite.getBoundingClientRect();
        return {
          width: box.width / parent.width,
          height: box.height / parent.height,
          footOffset: box.bottom - parent.bottom,
        };
      });
      animation.play();
      return frames;
    });
    for (const landing of landings) {
      expect(landing.width).toBeLessThanOrEqual(1.06);
      expect(landing.height).toBeGreaterThanOrEqual(0.939);
      expect(Math.abs(landing.footOffset)).toBeLessThan(0.2);
    }
    await page.clock.runFor(1300);
    const textarea = page.locator(".new-session-page__message");
    await textarea.fill("The prompt takes priority.");
    await expect.poll(() => pet.getAttribute("data-spot")).toBe("top");
    expect(await pet.getAttribute("data-floor-enabled")).toBeNull();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });

  it.each(["crab", "snail", "duck", "jellyfish", "stranger"] as const)(
    "keeps %s visits in the new composer",
    async (kind) => {
      let seed = 0;
      while (planLobsterPasser(seed)?.kind !== kind && seed < 10000) {
        seed++;
      }
      const plan = planLobsterPasser(seed)!;
      expect(plan.kind).toBe(kind);
      await configureComposerPet(seed, "idle");
      await page.clock.runFor(plan.atMs + 100);
      const passer = page.locator(".new-session-page__composer .lobster-pet--passer");
      await expect.poll(() => passer.count()).toBe(1);
      const box = await passer.evaluate((element) => {
        for (const animation of element.getAnimations()) {
          animation.pause();
          animation.currentTime = Number(animation.effect?.getTiming().duration) / 2;
        }
        const rect = element.getBoundingClientRect();
        const composer = element.closest(".agent-chat__input")!.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          composerLeft: composer.left,
          composerRight: composer.right,
        };
      });
      expect(box.left).toBeGreaterThanOrEqual(box.composerLeft);
      expect(box.right).toBeLessThanOrEqual(box.composerRight);
    },
  );

  it("keeps the composer visitors stationary with reduced motion", async () => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await configureComposerPet(42);
    await page.clock.runFor(1500);
    const pet = page.locator("openclaw-lobster-pet");
    const motion = await pet.evaluate(
      (element) =>
        element
          .getAnimations({ subtree: true })
          .filter((animation) => animation.playState === "running").length,
    );
    expect(motion).toBe(0);
  });
});
