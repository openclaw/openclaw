import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  installMockGateway,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { createSidebarCustomizationSuite } from "./sidebar-customization.test-support.ts";

const suite = createSidebarCustomizationSuite("Settings media permission lifetime");
type MediaEvent = {
  type: "enumerate" | "resolve" | "reject" | "probe" | "stop" | "pointer";
  route: string;
  id?: number;
  constraints?: MediaStreamConstraints;
  trusted?: boolean;
  kind?: string;
};
declare global {
  interface Window {
    settingsMediaProof: {
      events: MediaEvent[];
      settle: (id: number, reject?: boolean) => void;
    };
  }
}

async function installMediaBoundary(page: Page, holdRecoveryEnumeration: boolean) {
  await page.addInitScript(
    ({ holdRecovery }) => {
      const recordedEvents: MediaEvent[] = [];
      type Pending = { resolve: (devices: MediaDeviceInfo[]) => void; reject: () => void };
      const pending = new Map<number, Pending>();
      const granted = new Set<string>();
      let sequence = 0;
      const record = (event: Omit<MediaEvent, "route">) =>
        recordedEvents.push({ ...event, route: location.pathname });
      const devices = () =>
        [...granted].map((kind) => ({
          deviceId: `synthetic-${kind}`,
          groupId: "synthetic-media-proof",
          kind,
          label: kind === "audioinput" ? "Synthetic microphone" : "Synthetic camera",
          toJSON: () => ({}),
        })) as MediaDeviceInfo[];
      const media = new EventTarget();
      Object.assign(media, {
        enumerateDevices: () => {
          const id = ++sequence;
          record({ type: "enumerate", id });
          if (id <= 2 || (holdRecovery && id === 3)) {
            return new Promise<MediaDeviceInfo[]>((resolve, reject) => {
              pending.set(id, {
                resolve,
                reject: () =>
                  reject(new DOMException("Synthetic enumeration failure", "InvalidStateError")),
              });
            });
          }
          return Promise.resolve(devices());
        },
        getUserMedia: (constraints: MediaStreamConstraints) => {
          record({ type: "probe", constraints });
          const kind = constraints.audio ? "audioinput" : "videoinput";
          granted.add(kind);
          return Promise.resolve({
            getTracks: () => [{ stop: () => record({ type: "stop", kind }) }],
          });
        },
      });
      Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: media });
      document.addEventListener(
        "pointerdown",
        (event) => {
          const target = event.target;
          if (
            target instanceof HTMLSelectElement &&
            target.matches(".settings-select--media-device")
          ) {
            record({
              type: "pointer",
              trusted: event.isTrusted,
              kind: target.hasAttribute("data-settings-microphone") ? "audioinput" : "videoinput",
            });
          }
        },
        true,
      );
      window.settingsMediaProof = {
        events: recordedEvents,
        settle(id, reject = false) {
          const operation = pending.get(id);
          if (!operation) {
            throw new Error(`No pending media enumeration ${id}`);
          }
          pending.delete(id);
          record({ type: reject ? "reject" : "resolve", id });
          return reject ? operation.reject() : operation.resolve(devices());
        },
      };
    },
    { holdRecovery: holdRecoveryEnumeration },
  );
}
async function eventCount(page: Page, eventType: MediaEvent["type"]) {
  return page.evaluate(
    (type) => window.settingsMediaProof.events.filter((event) => event.type === type).length,
    eventType,
  );
}

async function settle(page: Page, enumerationId: number, rejectEnumeration = false) {
  return page.evaluate(
    ({ id, reject }) => {
      const owner = document.querySelector("openclaw-config-page");
      const surface = {
        route: location.pathname,
        ownerConnected: owner?.isConnected ?? false,
        pageTitle:
          owner?.querySelector(".content-header--settings .page-title")?.textContent?.trim() ??
          null,
        appearancePickerCount: document.querySelectorAll(".settings-select--media-device").length,
      };
      // Record the rendered owner in the same browser task that releases the held API.
      window.settingsMediaProof.settle(id, reject);
      return surface;
    },
    { id: enumerationId, reject: rejectEnumeration },
  );
}

function renderedAfterMediaSettlement(page: Page) {
  // Cross a rendered frame after the finite API microtask chain without changing state.
  return page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

suite.define(() => {
  for (const kind of ["microphone", "camera"] as const) {
    for (const transition of ["route leave", "disconnect", "second await", "stay"] as const) {
      it(`${kind}: ${transition}`, async () => {
        const context = await suite.newBrowserContext({
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 1000, width: 1440 },
        });
        const page = await context.newPage();
        try {
          await installMediaBoundary(page, transition === "second await");
          await installMockGateway(page);
          await page.goto(`${suite.server.baseUrl}new`);
          await page.locator(".new-session-page__message").waitFor({ state: "visible" });
          await page.keyboard.press("Control+Shift+,");
          let { sidebar } = await waitForControlUiSettingsTakeover(page);
          const configOwner = await page.locator("openclaw-config-page").elementHandle();
          expect(configOwner).not.toBeNull();
          expect(await configOwner!.evaluate((element) => element.isConnected)).toBe(true);
          await expect.poll(() => eventCount(page, "enumerate")).toBe(2);
          const picker = () => page.locator(`select[data-settings-${kind}]`);
          await picker().click();
          await page.keyboard.press("Escape");
          expect(new URL(page.url()).pathname).toBe("/settings/appearance");
          const target = kind === "microphone" ? 1 : 2;
          await settle(page, target === 1 ? 2 : 1);
          if (transition === "second await") {
            await settle(page, target, true);
            await expect.poll(() => eventCount(page, "enumerate")).toBe(3);
          }
          if (transition === "disconnect") {
            await sidebar.locator(".settings-sidebar__item").first().focus();
            await page.keyboard.press("Escape");
            await page.locator(".new-session-page__message").waitFor({ state: "visible" });
            expect(new URL(page.url()).pathname).toBe("/new");
          } else if (transition !== "stay") {
            await sidebar.locator('a[href="/settings/advanced"]').click();
            await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/advanced");
            // Wait for view retirement, not just history, before releasing enumeration.
            const pageTitle = page.locator(
              "openclaw-config-page .content-header--settings .page-title",
            );
            await pageTitle.waitFor({ state: "visible" });
            await expect.poll(() => pageTitle.textContent()).toBe("Advanced");
            await expect.poll(() => page.locator(".settings-select--media-device").count()).toBe(0);
          }
          const ownerConnectedAfterExit = await configOwner!.evaluate(
            (element) => element.isConnected,
          );
          if (transition !== "stay") {
            expect(ownerConnectedAfterExit).toBe(transition !== "disconnect");
          }
          const settlementSurface = await settle(page, transition === "second await" ? 3 : target);
          if (transition === "route leave" || transition === "second await") {
            expect(settlementSurface).toMatchObject({
              route: "/settings/advanced",
              ownerConnected: true,
              pageTitle: "Advanced",
              appearancePickerCount: 0,
            });
          }
          await renderedAfterMediaSettlement(page);
          const probesAfterSettlement = await eventCount(page, "probe");
          let probesBeforeFreshGesture = 0;
          if (transition !== "stay") {
            if (transition === "disconnect") {
              await page.keyboard.press("Control+Shift+,");
              ({ sidebar } = await waitForControlUiSettingsTakeover(page));
            } else {
              await sidebar.locator('a[href="/settings/appearance"]').click();
            }
            await picker().waitFor({ state: "visible" });
            await renderedAfterMediaSettlement(page);
            probesBeforeFreshGesture = await eventCount(page, "probe");
            await picker().click();
            await page.keyboard.press("Escape");
            await renderedAfterMediaSettlement(page);
          }
          const rows = await page.evaluate(() => [...window.settingsMediaProof.events]);
          const pointers = rows.filter((row) => row.type === "pointer");
          expect(pointers.map((row) => row.trusted)).toEqual(
            transition === "stay" ? [true] : [true, true],
          );
          expect(rows.filter((row) => row.type === "probe").map((row) => row.constraints)).toEqual([
            kind === "microphone" ? { audio: true } : { video: true },
          ]);
          expect(rows.filter((row) => row.type === "stop")).toHaveLength(1);
          expect(probesAfterSettlement).toBe(transition === "stay" ? 1 : 0);
          if (transition !== "stay") {
            expect(probesBeforeFreshGesture).toBe(0);
          }
          expect(new URL(page.url()).pathname).toBe("/settings/appearance");
        } finally {
          await suite.closeBrowserContext(context);
        }
      });
    }
  }
});
