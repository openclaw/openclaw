import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { persistColdLoadWarmState } from "../../../scripts/lib/control-ui-bench-warm-state.ts";
import { installPaneChromeProbe } from "../../../scripts/lib/control-ui-pane-chrome-probe.ts";
import { installWarmReloadBrowserProbe } from "../../../scripts/perf/warm-reload-browser-probe.ts";
import type { ChatMessageCache } from "../pages/chat/session-message-cache.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  pauseVirtualClock,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiTeamScaleFixture } from "../test-helpers/control-ui-team-scale-fixture.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Warm cached page visibility join" });
const viewport = { width: 1720, height: 1180 };

type Surface = {
  skeleton: boolean;
  sidebar: boolean;
  transcript: boolean;
  details: boolean;
  routeError: boolean;
};

// This samples the new document's visible DOM. Compositor old-page continuity
// is covered separately by the calibrated real-clock warm-reload filmstrip.
function installVisibleSurfaceProbe() {
  const samples: Surface[] = [];
  const read = (): Surface => {
    const visible = (selector: string) =>
      [...document.querySelectorAll(selector)].some((element) =>
        element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
      );
    return {
      skeleton: visible(".loading-skeleton, .connect-splash__sidebar"),
      sidebar: visible("openclaw-app-sidebar [data-session-key]"),
      transcript: visible(".chat-virtual-row .chat-text"),
      details: ["subagents", "outputs", "automations"].every((section) =>
        visible(`.chat-details [data-details-group="${section}"]`),
      ),
      routeError: visible('.lazy-view-error[role="alert"]'),
    };
  };
  Reflect.set(window, "warmJoinSurface", { samples, read });
  const sample = () => {
    const surface = read();
    if (Object.values(surface).some(Boolean)) samples.push(surface);
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
}

async function readSurface(page: Page): Promise<Surface> {
  return page.evaluate(() => Reflect.get(window, "warmJoinSurface").read());
}

async function releaseModule(page: Page, module: Awaited<ReturnType<typeof holdModuleResponse>>) {
  const response = page.waitForResponse(await module.request);
  module.release();
  await response;
}

async function readSurfaceAtAnimationTime(page: Page, time: number) {
  return page.evaluate((elapsed) => {
    const root = document.documentElement;
    for (const animation of root.getAnimations()) animation.currentTime = elapsed;
    // Read in this task: a queued animation finish callback cannot reveal the body for us.
    return {
      surface: Reflect.get(window, "warmJoinSurface").read() as Surface,
      warmFrame: root.getAttribute("data-openclaw-warm-frame"),
      now: performance.now(),
      composerVisible:
        document
          .querySelector("#openclaw-boot-composer")
          ?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ?? false,
    };
  }, time);
}

async function prepareWarmPage(page: Page) {
  const fixture = createControlUiTeamScaleFixture({
    baseUrl: suite.server.baseUrl,
    transcriptMessages: 240,
    paneChromeFacts: true,
    detailsSessionFacts: true,
  });
  await page.addInitScript(
    ({ key, settings, sidebarPrefs }) => {
      for (const [name, value] of Object.entries(sidebarPrefs)) localStorage.setItem(name, value);
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(settings));
    },
    {
      key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
      settings: { sessionKey: fixture.selectedSessionKey, sidebarAgentsMode: "roster" },
      sidebarPrefs: fixture.paneChromeSettings,
    },
  );
  await page.route("**/__openclaw__/**", (route) => {
    const asset = fixture.assets.get(new URL(route.request().url()).pathname);
    return asset ? route.fulfill(asset) : route.fallback();
  });
  const gateway = await installMockGateway(
    page,
    { ...fixture.scenario, deferredMethods: ["connect"] },
    {
      requestHandlers: {
        "cron.list": (params) => fixture.listCronJobs(isRecord(params) ? params : {}),
      },
    },
  );
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, fixture.selectedSessionKey, "chat"));
  await gateway.waitForRequest("connect");
  await gateway.resolveDeferred("connect");
  const pane = page.locator(".chat-pane-cache__pane--active");
  await pane.locator(".chat-virtual-row .chat-text").first().waitFor();
  await openChatDetails(page);
  await pane.locator('.chat-details [data-details-group="automations"]').waitFor();
  await pane.locator(".chat-details-subagents__summary").waitFor();
  await page.waitForFunction(
    ({ sessionKey, width }) => {
      const host = document.querySelector(".chat-pane-cache__pane--active");
      const state = host && Reflect.get(host, "state");
      const cache: ChatMessageCache | undefined = state?.chatMessagesBySession;
      const entry = cache && [...cache].find(([key]) => key.endsWith(`\u0000${sessionKey}`));
      const details = entry?.[1].snapshot.details;
      return (
        details?.docking?.wide &&
        JSON.parse(details.docking.layout)[0] === width &&
        details.automations &&
        details.subagents?.total === 18
      );
    },
    { sessionKey: fixture.selectedSessionKey, width: viewport.width },
  );
  await page.locator('aside.sidebar[data-snapshot-saved="true"]').waitFor();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const warm = await page.evaluate(persistColdLoadWarmState, {
    sessionKey: fixture.selectedSessionKey,
    sidebarView: "sessions",
  } satisfies Parameters<typeof persistColdLoadWarmState>[0]);
  const saved = warm.storage.records.snapshots.find((record) =>
    record.sessionKey.endsWith(`\u0000${fixture.selectedSessionKey}`),
  );
  expect(saved).toMatchObject({
    snapshot: {
      details: {
        docking: { wide: true, layout: expect.stringMatching(/^\[1720(?:,|\])/u) },
        automations: { rows: expect.any(Array) },
        subagents: { total: 18 },
      },
    },
  });
  expect(saved?.snapshot.details?.subagents?.rows).toHaveLength(4);
  expect(
    saved?.snapshot.details?.subagents?.counts.reduce((total, count) => total + count.count, 0),
  ).toBe(18);
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).some((key) => key.startsWith("openclaw.control.bootRecord.v1:")),
    ),
  ).toBe(true);
  await page.addInitScript({
    content: `globalThis.__name = (fn) => fn; Reflect.set(window, "__paneChrome", (${installPaneChromeProbe.toString()})()); (${installWarmReloadBrowserProbe.toString()})("chat");`,
  });
  await page.addInitScript(installVisibleSurfaceProbe);
  await page.addInitScript(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (keyframes, options) {
      const animation = animate.call(this, keyframes, options);
      if (this === document.documentElement) {
        // Native animation time is independent of Playwright's task/rAF clock.
        queueMicrotask(() => {
          animation.pause();
          animation.currentTime = 0;
        });
      }
      return animation;
    };
  });
  await page.clock.install();
  await pauseVirtualClock(page);
}

function expectComplete(surface: Surface) {
  expect(surface).toEqual({
    skeleton: false,
    sidebar: true,
    transcript: true,
    details: true,
    routeError: false,
  });
}

suite.define(() => {
  it("reveals cached sidebar, transcript and Details together after independent commits", async () => {
    await suite.withPage({ viewport, serviceWorkers: "block" }, async ({ page }) => {
      await prepareWarmPage(page);
      const pane = await holdModuleResponse(
        page,
        controlUiE2eBuiltModuleRequest("ui/src/pages/chat/route-entry.ts"),
      );
      const sidebar = await holdModuleResponse(
        page,
        controlUiE2eBuiltModuleRequest("ui/src/components/sidebar-agent-roster.tsx"),
      );
      try {
        await page.reload({ waitUntil: "domcontentloaded" });
        await Promise.all([pane.request, sidebar.request]);
        await releaseModule(page, pane);
        await page.clock.runFor(100);
        // Pane work must continue while the independent sidebar module is held.
        await page.locator(".chat-virtual-row").first().waitFor({ state: "attached" });
        expect(await readSurface(page)).toEqual({
          skeleton: false,
          sidebar: false,
          transcript: false,
          details: false,
          routeError: false,
        });
        await releaseModule(page, sidebar);
        await page.clock.runFor(300);
        expectComplete(await readSurface(page));
        const samples: Surface[] = await page.evaluate(
          () => Reflect.get(window, "warmJoinSurface").samples,
        );
        expect(samples.length).toBeGreaterThan(0);
        for (const surface of samples) expectComplete(surface);
        const probe = await page.evaluate(() => Reflect.get(window, "__warmReloadProof"));
        expect(probe.firstTranscriptDomMs).not.toBeNull();
        expect(probe.firstDetailsDomMs).not.toBeNull();
      } finally {
        pane.release();
        sidebar.release();
      }
    });
  });

  it("reveals the usable critical skeleton at the deadline, then hands off its draft", async () => {
    await suite.withPage({ viewport, serviceWorkers: "block" }, async ({ page }) => {
      await prepareWarmPage(page);
      const pane = await holdModuleResponse(
        page,
        controlUiE2eBuiltModuleRequest("ui/src/pages/chat/route-entry.ts"),
      );
      try {
        await page.reload({ waitUntil: "domcontentloaded" });
        await pane.request;
        await page.clock.runFor(449);
        expect((await readSurfaceAtAnimationTime(page, 449)).surface.skeleton).toBe(false);
        await page.clock.runFor(1);
        expect((await readSurfaceAtAnimationTime(page, 450)).surface.skeleton).toBe(true);
        expect((await readSurface(page)).transcript).toBe(false);
        const boot = page.locator("#openclaw-boot-composer");
        expect(
          await boot.evaluate((element) =>
            element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
          ),
        ).toBe(true);
        await boot.fill("Synthetic draft typed in the deadline fallback");
        await releaseModule(page, pane);
        await page.clock.runFor(400);
        expectComplete(await readSurface(page));
        expect(await page.locator(".agent-chat__composer-combobox textarea").inputValue()).toBe(
          "Synthetic draft typed in the deadline fallback",
        );
        expect(await page.locator("#openclaw-boot-composer").count()).toBe(0);
      } finally {
        pane.release();
      }
    });
  });

  it("reveals the deadline skeleton while JavaScript callback delivery is stalled", async () => {
    await suite.withPage({ viewport, serviceWorkers: "block" }, async ({ page }) => {
      await prepareWarmPage(page);
      const pane = await holdModuleResponse(
        page,
        controlUiE2eBuiltModuleRequest("ui/src/pages/chat/route-entry.ts"),
      );
      try {
        await page.reload({ waitUntil: "domcontentloaded" });
        await pane.request;
        await page.clock.runFor(430);
        const before = await readSurfaceAtAnimationTime(page, 449);
        expect(before.warmFrame).toBe("holding");
        expect(before.surface.skeleton).toBe(false);
        const deadline = await readSurfaceAtAnimationTime(page, 450);
        expect(deadline.now).toBe(before.now);
        expect(deadline.warmFrame).toBe("holding");
        expect(deadline.surface.skeleton).toBe(true);
        expect(deadline.surface.transcript).toBe(false);
        expect(deadline.composerVisible).toBe(true);
        await releaseModule(page, pane);
        await page.clock.runFor(400);
        expectComplete(await readSurface(page));
      } finally {
        pane.release();
      }
    });
  });

  it("shows a route failure before the fallback deadline", async () => {
    await suite.withPage({ viewport, serviceWorkers: "block" }, async ({ page }) => {
      await prepareWarmPage(page);
      await page.route(
        controlUiE2eBuiltModuleRequest("ui/src/pages/chat/route-entry.ts"),
        (route) =>
          route.fulfill({
            status: 200,
            contentType: "text/javascript",
            body: 'throw new Error("Synthetic warm route failure");',
          }),
      );
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator('.lazy-view-error[role="alert"]').waitFor({ state: "attached" });
      await page.clock.runFor(100);
      expect((await readSurface(page)).routeError).toBe(true);
      expect((await readSurface(page)).transcript).toBe(false);
    });
  });

  it("releases a missing sidebar cache before a pending pane or the deadline", async () => {
    await suite.withPage({ viewport, serviceWorkers: "block" }, async ({ page }) => {
      await prepareWarmPage(page);
      const cleared = await page.evaluate(async () => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const open = indexedDB.open("openclaw-chat-snapshots");
          open.onsuccess = () => resolve(open.result);
          open.onerror = () => reject(open.error);
        });
        try {
          const transaction = database.transaction("sidebarSnapshots", "readwrite");
          const store = transaction.objectStore("sidebarSnapshots");
          const count = store.count();
          store.clear();
          await new Promise<void>((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onabort = () => reject(transaction.error);
            transaction.onerror = () => reject(transaction.error);
          });
          return count.result;
        } finally {
          database.close();
        }
      });
      expect(cleared).toBeGreaterThan(0);
      const pane = await holdModuleResponse(
        page,
        controlUiE2eBuiltModuleRequest("ui/src/pages/chat/route-entry.ts"),
      );
      try {
        await page.reload({ waitUntil: "domcontentloaded" });
        await pane.request;
        await page.clock.runFor(100);
        expect((await readSurface(page)).skeleton).toBe(true);
        expect((await readSurface(page)).transcript).toBe(false);
      } finally {
        pane.release();
      }
    });
  });
});
