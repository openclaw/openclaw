import path from "node:path";
import type { Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { desktopObservation, workerDesktop } from "./desktop-panel-fixtures.test-support.ts";
import { installScriptedRfbServer } from "./desktop-rfb-test-support.ts";

const realVncWsUrl = process.env.OPENCLAW_DESKTOP_REAL_VNC_WS_URL?.trim() || null;
const suite = createControlUiE2eSuite({
  name: "desktop fullscreen",
  browserLaunchOptions: realVncWsUrl
    ? { args: ["--disable-web-security", "--allow-running-insecure-content"] }
    : undefined,
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
});
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofStage = process.env.OPENCLAW_DESKTOP_FULLSCREEN_PROOF_STAGE ?? "after";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("desktop-fullscreen");
  }
});

function sessionsList() {
  return {
    count: 1,
    defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
    path: "",
    sessions: [
      {
        key: "main",
        kind: "direct",
        label: "Main",
        placement: { state: "active" },
        updatedAt: Date.now(),
      },
    ],
    ts: Date.now(),
  };
}

const workerDesktopEnvironment = workerDesktop(
  "worker-desktop-1",
  ["agent:main:release-operations"],
  ["browser", "terminal"],
);

async function installDesktopGateway(page: Page) {
  return installMockGateway(page, {
    featureMethods: ["desktop.observe", "environments.list"],
    methodResponses: {
      "sessions.list": sessionsList(),
      "environments.list": { environments: [] },
    },
  });
}

async function openDesktopPanel(page: Page) {
  await page.goto(`${suite.server.baseUrl}activity`);
  await waitForControlUiGatewayReady(page);
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("openclaw:command-palette-open"));
  });
  await page
    .locator("openclaw-command-palette")
    .getByRole("textbox", { name: "Search or start a task…" })
    .waitFor();
  await page.getByRole("option", { name: "Desktop", exact: true }).click();
  const panel = page.locator("openclaw-desktop-panel");
  await panel.locator("section[aria-label='Desktop']").waitFor();
  return panel;
}

async function setTheme(page: Page, theme: "dark" | "light") {
  await page.emulateMedia({ colorScheme: theme });
  await page.evaluate((nextTheme) => {
    document.documentElement.dataset.themeMode = nextTheme;
    document.documentElement.dataset.themeResolved = nextTheme;
    document.documentElement.style.colorScheme = nextTheme;
  }, theme);
}

async function captureDesktopProof(page: Page, panel: import("playwright").Locator, name: string) {
  if (!captureUiProof) {
    return;
  }
  const capture = (target: Page | import("playwright").Locator, suffix: string) =>
    target.screenshot({
      animations: "disabled",
      path: path.join(proofDir, `${proofStage}-${name}-${suffix}.png`),
    });
  await capture(page, "context");
  await capture(panel.locator(".bp-header"), "header");
  const connectionToolbar = panel.locator(".desktop-toolbar--connection");
  if ((await connectionToolbar.count()) > 0) {
    await capture(connectionToolbar, "controls");
  }
}

suite.define(() => {
  it.each(["dark", "light"] as const)(
    "keeps the production noVNC canvas mounted through fullscreen entry and exit in %s mode",
    async (theme) => {
      await suite.withPage(
        {
          colorScheme: theme,
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 900, width: 1440 },
        },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            featureMethods: ["desktop.observe", "environments.list"],
            webSocketPassthroughPrefixes: realVncWsUrl ? [realVncWsUrl] : [],
            methodResponses: {
              "sessions.list": sessionsList(),
              "environments.list": { environments: [workerDesktopEnvironment] },
              "desktop.observe": {
                cases: [false, true].map((control) => ({
                  match: {
                    source: { kind: "environment", environmentId: "worker-desktop-1" },
                    control,
                  },
                  response: desktopObservation(
                    realVncWsUrl ?? `/desktop/observe?token=${control ? "control" : "view"}`,
                    control,
                  ),
                })),
              },
            },
          });
          const panel = await openDesktopPanel(page);
          const panelButton = (name: string) => panel.getByRole("button", { name, exact: true });
          const takeControl = panelButton("Take control");
          const disconnect = panelButton("Disconnect");
          const fullscreenActive = () => page.evaluate(() => document.fullscreenElement !== null);
          const capture = (state: string) => captureDesktopProof(page, panel, `${theme}-${state}`);
          await setTheme(page, theme);
          await gateway.waitForRequest("environments.list");
          if (!realVncWsUrl) {
            // CI uses the canonical scripted RFB endpoint. Visual proof sets
            // OPENCLAW_DESKTOP_REAL_VNC_WS_URL to a genuine VNC desktop.
            await installScriptedRfbServer(page);
          }
          await panelButton("Connect").click();
          const screen = panel.locator(".desktop-surface canvas");
          await screen.waitFor();
          if (realVncWsUrl) {
            await expect
              .poll(
                () =>
                  screen.evaluate((canvas: HTMLCanvasElement) => {
                    const context = canvas.getContext("2d");
                    if (!context || canvas.width === 0 || canvas.height === 0) {
                      return false;
                    }
                    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
                    for (let i = 0; i < pixels.length; i += 128) {
                      if ((pixels[i] ?? 0) + (pixels[i + 1] ?? 0) + (pixels[i + 2] ?? 0) > 0) {
                        return true;
                      }
                    }
                    return false;
                  }),
                { timeout: 15_000 },
              )
              .toBe(true);
          }

          await capture("default");
          expect(
            await page.evaluate(() => ({
              enabled: document.fullscreenEnabled,
              requestType: typeof Element.prototype.requestFullscreen,
            })),
          ).toEqual({ enabled: true, requestType: "function" });
          const fullscreenButton = panel.locator(".desktop-fullscreen-button");
          expect(await fullscreenButton.getAttribute("aria-label")).toBe("Enter fullscreen");
          await fullscreenButton.hover();
          await capture("hover");
          await fullscreenButton.focus();
          await capture("focus");

          const screenHandle = await screen.elementHandle();
          await fullscreenButton.press("Enter");
          await expect
            .poll(() => fullscreenButton.getAttribute("aria-label"))
            .toBe("Exit fullscreen");
          expect(await fullscreenActive()).toBe(true);
          expect(
            await screen.evaluate((element, original) => element === original, screenHandle),
          ).toBe(true);
          expect(await gateway.getRequests("desktop.observe")).toHaveLength(1);
          expect(await takeControl.isVisible()).toBe(true);
          expect(await disconnect.isVisible()).toBe(true);
          const [stageBox, screenBox] = await Promise.all([
            panel.locator(".desktop-stage").boundingBox(),
            screen.boundingBox(),
          ]);
          if (!stageBox || !screenBox) {
            throw new Error("Desktop fullscreen geometry is unavailable");
          }
          const framebuffer = await screen.evaluate((canvas: HTMLCanvasElement) => ({
            height: canvas.height,
            width: canvas.width,
          }));
          expect(framebuffer.width).toBeGreaterThan(0);
          expect(framebuffer.height).toBeGreaterThan(0);
          expect(
            Math.abs(screenBox.width / screenBox.height - framebuffer.width / framebuffer.height),
          ).toBeLessThan(0.02);
          expect(screenBox.x).toBeGreaterThanOrEqual(stageBox.x);
          expect(screenBox.y).toBeGreaterThanOrEqual(stageBox.y);
          expect(screenBox.x + screenBox.width).toBeLessThanOrEqual(stageBox.x + stageBox.width);
          expect(screenBox.y + screenBox.height).toBeLessThanOrEqual(stageBox.y + stageBox.height);
          expect(
            stageBox.width - screenBox.width > 20 || stageBox.height - screenBox.height > 20,
          ).toBe(true);
          await capture("fullscreen");

          await takeControl.click();
          await expect
            .poll(async () => (await gateway.getRequests("desktop.observe")).length)
            .toBe(2);
          expect(await fullscreenActive()).toBe(true);
          // The authenticated handoff keeps both canvases until the replacement connects.
          await expect
            .poll(() => screenHandle?.evaluate((element) => element.isConnected))
            .toBe(false);
          await screen.waitFor();
          await expect.poll(() => takeControl.count()).toBe(0);

          // Escape and browser controls both exit through the fullscreenchange path.
          await page.evaluate(() => document.exitFullscreen());
          await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
          await expect
            .poll(() => fullscreenButton.getAttribute("aria-label"))
            .toBe("Enter fullscreen");
          expect(
            await fullscreenButton.evaluate(
              (button) => button === (button.getRootNode() as ShadowRoot).activeElement,
            ),
          ).toBe(true);
          await capture("exit");

          await fullscreenButton.click();
          await disconnect.click();
          await panel.getByText("Desktop sources", { exact: true }).waitFor();
          expect(await fullscreenActive()).toBe(true);
          await capture("disconnected-fullscreen");
          await fullscreenButton.click();
          await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
        },
      );
    },
  );

  it.each(["unavailable", "denied"])("reports %s fullscreen requests", async (mode) => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      if (mode === "unavailable") {
        await page.addInitScript(() => {
          Object.defineProperty(document, "fullscreenEnabled", {
            configurable: true,
            value: false,
          });
        });
      }
      await installDesktopGateway(page);
      const panel = await openDesktopPanel(page);
      const button = panel.locator(".desktop-fullscreen-button");
      if (mode === "denied") {
        await panel.locator("section.bp").evaluate((element) => {
          element.requestFullscreen = () =>
            Promise.reject(new DOMException("Fullscreen permission denied", "NotAllowedError"));
        });
        await button.click();
      } else {
        expect(await button.getAttribute("aria-label")).toBe(
          "Fullscreen is unavailable in this browser",
        );
        expect(await button.getAttribute("aria-disabled")).toBe("true");
        await button.focus();
        await button.press("Enter");
      }
      await panel
        .getByRole("alert")
        .filter({
          hasText:
            mode === "denied"
              ? "Could not change fullscreen mode: Fullscreen permission denied"
              : "Fullscreen is unavailable in this browser",
        })
        .waitFor();
    });
  });

  it("exits fullscreen when the desktop panel unmounts", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      await installDesktopGateway(page);
      const panel = await openDesktopPanel(page);
      await panel.locator(".desktop-fullscreen-button").click();
      await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
      await panel.evaluate((element) => element.remove());
      await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
    });
  });
});
