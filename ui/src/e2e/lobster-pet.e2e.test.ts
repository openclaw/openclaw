// Control UI E2E tests cover real-browser lobster pet timing and pointer cancellation.
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
async function configureComposerPet(params: {
  mode: BrowserLobsterPet["mode"];
  outcome: BrowserLobsterPet["runOutcome"];
  seed: number;
}) {
  await page.evaluate(async (fixture) => {
    const pet = document.querySelector(
      ".new-session-page__composer openclaw-lobster-pet",
    ) as BrowserLobsterPet;
    if (!pet) {
      throw new Error("New Session composer critter not mounted");
    }
    pet.seed = fixture.seed;
    pet.mode = fixture.mode;
    pet.runOutcome = fixture.outcome;
    await pet.updateComplete;
  }, params);
}

async function settlePet() {
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

  afterEach(async () => {
    await context.close();
  });

  it("keeps a vigil-only failure present through droop and sweep before leaving", async () => {
    await configureComposerPet({ mode: "busy", outcome: "error", seed: 0 });
    const sprite = page.locator(".lobster-pet");
    await expect.poll(() => sprite.count()).toBe(0);

    await page.clock.fastForward(600_500);
    await settlePet();
    expect(await page.locator(".lobster-pet--vigil").count()).toBe(1);
    await page.evaluate(async () => {
      const pet = document.querySelector("openclaw-lobster-pet") as BrowserLobsterPet;
      pet.mode = "idle";
      await pet.updateComplete;
    });

    const droop = page.locator(".lobster-pet--act-droop");
    expect(await droop.count()).toBe(1);
    await page.clock.runFor(1_599);
    await settlePet();
    expect(await droop.count()).toBe(1);
    await page.clock.runFor(1);
    await settlePet();

    const sweep = page.locator(".lobster-pet--act-sweep");
    expect(await sweep.count()).toBe(1);
    await page.clock.runFor(1_799);
    await settlePet();
    expect(await sweep.count()).toBe(1);
    await page.clock.runFor(1);
    await settlePet();

    expect(await page.locator(".lobster-pet--away").count()).toBe(1);
    await page.clock.runFor(350);
    await expect.poll(() => sprite.count()).toBe(0);
  });

  it("does not pet after Chromium cancels a sub-threshold touch hold", async () => {
    await configureComposerPet({ mode: "offline", outcome: "ok", seed: 42 });
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
      await configureComposerPet({ mode: "offline", outcome: "ok", seed });
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
    await configureComposerPet({ mode: "offline", outcome: "ok", seed: 42 });
    expect(await page.locator("openclaw-app-sidebar openclaw-lobster-pet").count()).toBe(0);
    const pet = page.locator(".new-session-page__composer openclaw-lobster-pet");
    await expect.poll(() => pet.getAttribute("data-scene-ready")).not.toBeNull();
    await page.clock.runFor(1500);
    await page.screenshot({ path: suite.artifactDir + "/top-perch.png", animations: "disabled" });
    const hop = await pet.evaluate(async (element) => {
      const actor = element as HTMLElement & {
        geometry: {
          scene: {
            top: { start: number; end: number };
            floor: unknown;
            passage: [number, number] | null;
          };
        };
        spotPct: number;
        performAct: (act: string) => void;
        updateComplete: Promise<unknown>;
      };
      const scene = actor.geometry.scene;
      if (!scene.floor || !scene.passage) {
        throw new Error("Default composer has no safe floor or passage");
      }
      actor.spotPct =
        (((scene.passage[0] + scene.passage[1]) / 2 - scene.top.start) /
          (scene.top.end - scene.top.start)) *
        100;
      for (let i = 0; i < 10 && actor.getAttribute("data-spot") !== "floor"; i++) {
        actor.performAct("hop");
        await actor.updateComplete;
      }
      return {
        spot: actor.getAttribute("data-spot"),
        hops: actor.querySelectorAll(".lobster-pet__motion--hop").length,
      };
    });
    expect(hop).toEqual({ spot: "floor", hops: 1 });
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
    await page.screenshot({ path: suite.artifactDir + "/floor-visit.png", animations: "disabled" });
    const textarea = page.locator(".new-session-page__message");
    await textarea.fill("The prompt takes priority.");
    await expect.poll(() => pet.getAttribute("data-spot")).toBe("top");
    expect(await pet.getAttribute("data-floor-enabled")).toBeNull();
    await page.screenshot({
      path: suite.artifactDir + "/typing-priority.png",
      animations: "disabled",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: suite.artifactDir + "/mobile.png", animations: "disabled" });
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
      await configureComposerPet({ mode: "idle", outcome: "ok", seed });
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
      await page.screenshot({ path: suite.artifactDir + "/visitor-" + kind + ".png" });
    },
  );

  it("keeps the composer visitors stationary with reduced motion", async () => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await configureComposerPet({ mode: "offline", outcome: "ok", seed: 42 });
    await page.clock.runFor(1500);
    const motion = await page
      .locator("openclaw-lobster-pet")
      .evaluate(
        (element) =>
          element
            .getAnimations({ subtree: true })
            .filter((animation) => animation.playState === "running").length,
      );
    expect(motion).toBe(0);
  });
});
