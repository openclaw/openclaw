import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type {
  DesktopClient,
  DesktopConnectionHandle,
} from "../components/desktop/desktop-client.ts";
import type { DesktopSizingMode } from "../components/desktop/desktop-panel-state.ts";
import {
  takeControlUiScreenshotFrame,
  takeControlUiViewportScreenshot,
} from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { activateChatHeaderPanelAction } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  credentialsRequired,
  desktopGateway,
  observationCases,
  observe,
  openDesktopPanel,
  openPalette,
  sessionsList,
  unavailable,
  workerDesktopEnvironment,
  workerEnvironment,
} from "./desktop-panel.test-support.ts";
import {
  createRfbClipboardProvide,
  createRfbRawFrame,
  installDesktopClientFake,
  installScriptedRfbServer,
} from "./desktop-rfb-test-support.ts";

const suite = createControlUiE2eSuite({
  name: "desktop source panel",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
});

const button = (root: Page | Locator, name: string) =>
  root.getByRole("button", { name, exact: true });
const text = (root: Page | Locator, name: string) => root.getByText(name, { exact: true });
const withDesktopPage = (run: (page: Page) => Promise<void>) =>
  suite.withPage({ serviceWorkers: "block" }, ({ page }) => run(page));
const environmentSource = { kind: "environment", environmentId: "worker-desktop-1" };
const hostEnvironment = { id: "gateway", type: "local", status: "available", desktop: true };
const noSourcePicker = async (panel: Locator) => {
  expect(await text(panel, "Desktop sources").count()).toBe(0);
  expect(await text(panel, "This machine").count()).toBe(0);
};
const expectObservation = (params: unknown, control = false) =>
  expect(params).toEqual({ source: environmentSource, control });
const requestCount = async (
  gateway: Awaited<ReturnType<typeof desktopGateway>>,
  method: string,
  params?: Record<string, unknown>,
) => (await gateway.getRequests(method, params)).length;

async function openDirectDesktop(page: import("playwright").Page, environmentId: string) {
  await page.evaluate((targetEnvironmentId) => {
    window.dispatchEvent(
      new CustomEvent("openclaw:desktop-toggle", {
        detail: { open: true, environmentId: targetEnvironmentId },
      }),
    );
  }, environmentId);
}

async function openScriptedDesktop(
  page: import("playwright").Page,
  options: { disconnectAfterLastPeer?: boolean } = {},
) {
  const gateway = await desktopGateway(page, [workerDesktopEnvironment], observationCases(), {
    methodResponses: { "sessions.list": sessionsList("active") },
  });
  await page.goto(`${suite.server.baseUrl}activity`);
  // DesktopClient owns the real noVNC parser; only its RFB wire peer is scripted.
  const rfb = await installScriptedRfbServer(page, options);
  await openDirectDesktop(page, "worker-desktop-1");
  const panel = page.locator("openclaw-desktop-panel");
  await panel.locator(".desktop-surface canvas").waitFor();
  await expect.poll(rfb.events).toEqual(["authenticated:1"]);
  return { gateway, rfb, panel };
}

// Only this scenario needs both overlay and space-consuming scrollbars.
const sizingSuite = createControlUiE2eSuite({
  name: "desktop axis sizing",
  startServerBeforeBrowser: true,
  browserLaunchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
});
sizingSuite.define(() => {
  it("fits either axis with real noVNC scaling, scroll and pointer coordinates", () =>
    sizingSuite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      await page.setViewportSize({ width: 1000, height: 900 });
      const gateway = await desktopGateway(
        page,
        [hostEnvironment],
        observe("sizing", true, { canResize: true }),
        {
          deferredMethods: ["desktop.observe"],
        },
      );
      await page.goto(`${sizingSuite.server.baseUrl}focus/desktop/control/source/gateway`);
      const overlayScrollbars = await page.addStyleTag({
        content: ".desktop-surface * { scrollbar-width: none; }",
      });
      await gateway.waitForRequest("desktop.observe");
      const peer = await installScriptedRfbServer(page);
      const panel = page.locator("openclaw-desktop-panel");
      type SizingPanel = HTMLElement & {
        desktopClientFactory: () => Pick<DesktopClient, "connect">;
        sizingConnection: DesktopConnectionHandle;
        sizingPackets: number[][];
      };
      await panel.evaluate((element) => {
        const host = element as SizingPanel;
        host.sizingPackets = [];
        // Observe the existing wire fixture; neither transport nor noVNC is replaced here.
        window.WebSocket = new Proxy(window.WebSocket, {
          construct(Socket, args) {
            const socket = Reflect.construct(Socket, args) as WebSocket;
            const send = socket.send.bind(socket);
            socket.send = (data) => {
              if (ArrayBuffer.isView(data)) {
                host.sizingPackets.push(
                  Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
                );
              }
              send(data);
            };
            return socket;
          },
        });
        const factory = host.desktopClientFactory;
        host.desktopClientFactory = () => {
          const client = factory.call(host);
          const connect = client.connect.bind(client);
          client.connect = async (options) => {
            host.sizingConnection = await connect(options);
            return host.sizingConnection;
          };
          return client;
        };
      });
      await gateway.resolveDeferred("desktop.observe");
      await expect.poll(peer.events).toEqual(["authenticated:1"]);
      await panel
        .getByRole("status", { name: "Connecting to desktop…" })
        .waitFor({ state: "hidden" });
      const surface = panel.locator(".desktop-surface");
      const canvas = surface.locator("canvas");
      const bounds = await surface.boundingBox();
      if (!bounds) {
        throw new Error("Desktop surface must be visible");
      }
      const dimensions = () =>
        canvas.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return [Math.round(rect.width), Math.round(rect.height)];
        });
      // The focus document keeps its native selector; axis geometry uses the shared connection API.
      const selectAxis = (mode: DesktopSizingMode) =>
        panel.evaluate((element, next) => {
          (element as SizingPanel).sizingConnection.setSizingMode(next);
        }, mode);
      const sizing = panel.getByRole("combobox", { name: "Desktop size", exact: true });
      const scroll = (axis: "left" | "top", amount: number) =>
        canvas.evaluate(
          (element, value) => {
            for (let owner = element.parentElement; owner; owner = owner.parentElement) {
              if (
                value.axis === "left"
                  ? owner.scrollWidth > owner.clientWidth
                  : owner.scrollHeight > owner.clientHeight
              ) {
                if (value.axis === "left") {
                  owner.scrollLeft = value.amount;
                } else {
                  owner.scrollTop = value.amount;
                }
                return value.axis === "left" ? owner.scrollLeft : owner.scrollTop;
              }
            }
            return 0;
          },
          { axis, amount },
        );
      const pointer = () =>
        panel.evaluate((element) => {
          const packet = (element as SizingPanel).sizingPackets.findLast(
            (bytes) => bytes[0] === 5 && bytes[1] === 1,
          );
          return packet ? [packet[2]! * 256 + packet[3]!, packet[4]! * 256 + packet[5]!] : null;
        });
      const capture = async (name: string) => {
        const frame = await takeControlUiScreenshotFrame(page, surface, [canvas], {
          elements: [surface],
          animations: "disabled",
        });
        await writeFile(path.join(sizingSuite.artifactDir, `${name}.png`), frame.png);
        await writeFile(
          path.join(sizingSuite.artifactDir, `${name}-surface.png`),
          frame.elements[0]!.png,
        );
      };
      const marker = createRfbRawFrame();
      // A second wire-rendered landmark stays visible after scrolling either axis.
      marker[5] = 240;
      marker[6] = 1;
      marker[7] = 44;
      await peer.send([createRfbRawFrame(), marker]);
      await expect.poll(dimensions).toEqual([1000, 750]);
      await capture("fit-before-axis");
      await selectAxis("fit-height");
      await expect.poll(dimensions).toEqual([Math.round((bounds.height * 4) / 3), bounds.height]);
      expect(await scroll("top", 100)).toBe(0);
      expect(await scroll("left", 100)).toBe(100);
      await page.mouse.click(bounds.x + 100, bounds.y + 100);
      await expect
        .poll(pointer)
        .toEqual([
          Math.floor((200 * 600) / bounds.height),
          Math.floor((100 * 600) / bounds.height),
        ]);
      await capture("fit-height-scrolled");
      // Real DesktopSize changes the framebuffer; the current axis must react before switching modes.
      await peer.send([[0, 0, 0, 1, 0, 0, 0, 0, 2, 88, 4, 176, 255, 255, 255, 33]]);
      await expect.poll(dimensions).toEqual([Math.round(bounds.height / 2), bounds.height]);
      await peer.send([marker]);
      await selectAxis("fit-width");
      await expect.poll(dimensions).toEqual([1000, 2000]);
      expect(await scroll("left", 100)).toBe(0);
      expect(await scroll("top", 200)).toBe(200);
      await page.mouse.click(bounds.x + 100, bounds.y + 100);
      await expect.poll(pointer).toEqual([60, 180]);
      await capture("fit-width-scrolled");
      await page.setViewportSize({ width: 500, height: 900 });
      await expect.poll(dimensions).toEqual([500, 1000]);
      await sizing.selectOption("actual");
      await expect.poll(dimensions).toEqual([600, 1200]);
      expect(await scroll("left", 100)).toBe(100);
      expect(await scroll("top", 100)).toBe(100);
      await sizing.selectOption("fit");
      await expect.poll(dimensions).toEqual([Math.round(bounds.height / 2), bounds.height]);
      await sizing.selectOption("match");
      await expect.poll(dimensions).toEqual([Math.round(bounds.height / 2), bounds.height]);

      // The launch flag must also be absent; CSS alone cannot override --hide-scrollbars.
      await overlayScrollbars.evaluate((element) => element.parentNode?.removeChild(element));
      // Custom Chromium scrollbars consume real layout space even on overlay-scrollbar hosts.
      await page.addStyleTag({
        content:
          ".desktop-surface * { scrollbar-width: auto; scrollbar-color: auto; } .desktop-surface *::-webkit-scrollbar { width: 16px; height: 16px; }",
      });
      await page.setViewportSize({ width: 800, height: 600 });
      const feedback = [];
      for (const [mode, width, height] of [
        ["fit-height", 804, 600],
        ["fit-width", 800, 604],
      ] as const) {
        await peer.send([
          [
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            0,
            width >> 8,
            width & 255,
            height >> 8,
            height & 255,
            255,
            255,
            255,
            33,
          ],
        ]);
        await expect
          .poll(() =>
            canvas.evaluate((element: HTMLCanvasElement) => [element.width, element.height]),
          )
          .toEqual([width, height]);
        await selectAxis(mode);
        const samples = await canvas.evaluate(async (element, axis) => {
          const viewport = [...element.closest(".desktop-surface")!.querySelectorAll("div")].find(
            (owner) =>
              ["auto", "scroll"].includes(
                axis === "fit-height"
                  ? getComputedStyle(owner).overflowX
                  : getComputedStyle(owner).overflowY,
              ),
          )!;
          const frames = [];
          // Observe consecutive rendered frames; a single settled-looking sample misses feedback.
          for (let frame = 0; frame < 32; frame++) {
            await new Promise<void>((resolve) => {
              requestAnimationFrame(() => resolve());
            });
            const rect = element.getBoundingClientRect();
            frames.push({
              width: rect.width,
              height: rect.height,
              clientWidth: viewport.clientWidth,
              clientHeight: viewport.clientHeight,
              gutterX: viewport.offsetHeight - viewport.clientHeight,
              gutterY: viewport.offsetWidth - viewport.clientWidth,
            });
          }
          return frames;
        }, mode);
        feedback.push({ mode, framebuffer: [width, height], samples });
        await writeFile(
          path.join(sizingSuite.artifactDir, `classic-${mode}.png`),
          await takeControlUiViewportScreenshot(page, surface, [canvas]),
        );
      }
      await writeFile(
        path.join(sizingSuite.artifactDir, "scrollbar-feedback.json"),
        JSON.stringify(feedback, null, 2),
      );
      for (const { mode, samples } of feedback) {
        expect(
          samples.some(
            (sample) => (mode === "fit-height" ? sample.gutterX : sample.gutterY) === 16,
          ),
          `${mode} must exercise a measured classic gutter`,
        ).toBe(true);
        expect(
          new Set(samples.slice(-16).map((sample) => JSON.stringify(sample))).size,
          `${mode} must stop resizing once the viewport and framebuffer stop changing`,
        ).toBe(1);
      }
      expect(await peer.connectionCount()).toBe(1);
      expect(await gateway.getRequests("desktop.observe")).toHaveLength(1);
      // Provider permission alone cannot negotiate remote resizing with this wire peer.
      expect(
        await panel.evaluate((element) =>
          (element as SizingPanel).sizingPackets.some((bytes) => bytes[0] === 251),
        ),
      ).toBe(false);
      const mountedSurface = await surface.elementHandle();
      await panel.evaluate((element) => (element as SizingPanel).sizingConnection.disconnect());
      await expect.poll(peer.events).toContain("closed:1");
      expect(await mountedSurface?.evaluate((element) => element.childElementCount)).toBe(0);
    }));
});

suite.define(() => {
  it("hides the desktop command without the method or operator.admin", async () => {
    for (const testCase of [
      {
        featureMethods: ["environments.list"],
        methodResponses: { "sessions.list": sessionsList("active") },
      },
      {
        featureMethods: ["environments.list", "desktop.observe"],
        methodResponses: { "sessions.list": sessionsList("active") },
        operatorScopes: ["operator.read"],
      },
    ]) {
      await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
        await installMockGateway(page, testCase);
        await page.goto(`${suite.server.baseUrl}chat`);
        await openPalette(page);
        expect(await page.getByRole("option", { name: "Desktop", exact: true }).count()).toBe(0);
      });
    }
  });

  it.each(["local", "active"] as const)(
    "opens only the assigned desktop on a %s chat session",
    async (placement) => {
      await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
        const environments = [hostEnvironment, workerDesktopEnvironment];
        const environment = environments[placement === "local" ? 0 : 1];
        const gateway = await desktopGateway(
          page,
          environments,
          observe("palette-session", false, { auth: "vnc-password" }),
          {
            methodResponses: {
              "sessions.list": sessionsList(placement),
              "environments.status": environment,
            },
          },
        );
        await page.goto(`${suite.server.baseUrl}chat`);
        await openPalette(page);
        expect(await page.getByRole("option", { name: "Desktop", exact: true }).count()).toBe(1);

        await gateway.deferNext("environments.status");
        await page.getByRole("option", { name: "Desktop", exact: true }).click();
        const panel = page.locator("openclaw-desktop-panel");
        await panel.locator("section[aria-label='Desktop']").waitFor();
        const target = await gateway.waitForRequest("environments.status");
        expect(target.params).toEqual({
          environmentId: placement === "local" ? "gateway" : workerDesktopEnvironment.id,
        });
        expect(await text(panel, "Desktop sources").count()).toBe(0);
        expect(await button(panel, "Connect").count()).toBe(0);
        expect(await gateway.getRequests("desktop.observe")).toHaveLength(0);
        await gateway.resolveDeferred("environments.status", environment);
        await panel.getByLabel("VNC password", { exact: true }).waitFor();
        const observation = await gateway.waitForRequest("desktop.observe");
        expect(observation.params).toEqual({
          source: placement === "local" ? { kind: "host" } : environmentSource,
          control: false,
        });

        const password = panel.getByLabel("VNC password", { exact: true });
        await password.fill("synthetic-unsent-password");
        const passwordInput = await password.elementHandle();
        const inventoryReads = await gateway.getRequests("environments.status");
        await gateway.setMethodResponse(
          "environments.status",
          unavailable("desktop inventory temporarily unavailable"),
        );
        await openPalette(page);
        await page.getByRole("option", { name: "Desktop", exact: true }).click();
        await page
          .locator("openclaw-command-palette")
          .getByRole("textbox", { name: "Search or start a task…" })
          .waitFor({ state: "hidden" });
        expect(await passwordInput?.evaluate((element) => element.isConnected)).toBe(true);
        expect(await password.inputValue()).toBe("synthetic-unsent-password");
        expect(await gateway.getRequests("environments.status")).toEqual(inventoryReads);

        await button(page, "Close Desktop").click();
        await panel.waitFor({ state: "detached" });
        await openPalette(page);
        await page.getByRole("option", { name: "Desktop", exact: true }).click();
        await gateway.waitForRequest("environments.status", { after: inventoryReads.length });
        await panel.getByRole("alert").filter({ hasText: "inventory" }).waitFor();
        await gateway.setMethodResponse("environments.status", environment);
        await button(panel, "Retry").click();
        await panel.getByLabel("VNC password", { exact: true }).waitFor();
        expect(await gateway.getRequests("desktop.observe")).toHaveLength(2);
        expect(await text(panel, "Desktop sources").count()).toBe(0);

        await button(page, "Close Desktop").click();
        await panel.waitFor({ state: "detached" });
        await activateChatHeaderPanelAction(page, "Desktop");
        await panel.getByLabel("VNC password", { exact: true }).waitFor();
        expect(await gateway.getRequests("desktop.observe")).toHaveLength(3);
      });
    },
  );

  it("reports an unavailable target without fallback", () =>
    withDesktopPage(async (page) => {
      const gateway = await desktopGateway(
        page,
        [hostEnvironment],
        unavailable("requested worker desktop is temporarily unavailable"),
        { methodResponses: { "sessions.list": sessionsList("active") } },
      );
      await page.goto(`${suite.server.baseUrl}chat`);

      await openDirectDesktop(page, "missing-worker");

      const observeRequest = await gateway.waitForRequest("desktop.observe");
      expect(observeRequest.params).toEqual({
        source: { kind: "environment", environmentId: "missing-worker" },
        control: false,
      });
      const panel = page.locator("openclaw-desktop-panel");
      await panel.getByText(/requested worker desktop is temporarily unavailable/).waitFor();
      await noSourcePicker(panel);
    }));

  it("fails status without observation or fallback", () =>
    withDesktopPage(async (page) => {
      const sessions = sessionsList("active");
      const [session] = sessions.sessions;
      const gateway = await desktopGateway(page, null, observe("degraded", false), {
        deferredMethods: ["environments.status"],
        methodResponses: {
          "sessions.list": {
            ...sessions,
            sessions: [
              { ...session, placement: { state: "active", environmentId: "other-worker" } },
            ],
          },
          "environments.status": unavailable("desktop inventory is temporarily unavailable"),
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      // Settle automatic discovery of the chat's worker before opening another target.
      await gateway.waitForRequest("environments.status", {
        match: { environmentId: "other-worker" },
      });
      await gateway.rejectDeferred("environments.status", {
        code: "UNAVAILABLE",
        message: "session desktop is unavailable",
      });
      await openDirectDesktop(page, "worker-desktop-1");

      const panel = page.locator("openclaw-desktop-panel");
      await panel.getByRole("alert").filter({ hasText: "inventory" }).waitFor();
      expect(await gateway.getRequests("desktop.observe")).toHaveLength(0);
      await noSourcePicker(panel);

      await gateway.setMethodResponse("environments.status", workerDesktopEnvironment);
      await installDesktopClientFake(panel);
      const requestsBeforeRetry = (await gateway.getRequests()).length;
      await button(panel, "Retry").click();

      await expect
        .poll(() =>
          requestCount(gateway, "environments.status", { environmentId: "worker-desktop-1" }),
        )
        .toBe(2);
      const observeRequest = await gateway.waitForRequest("desktop.observe");
      expectObservation(observeRequest.params);
      expect(
        (await gateway.getRequests())
          .slice(requestsBeforeRetry)
          .filter((request) =>
            ["environments.status", "environments.list", "desktop.observe"].includes(
              request.method,
            ),
          )
          .map((request) => request.method),
      ).toEqual(["environments.status", "desktop.observe"]);
      await button(panel, "Desktop actions").click();
      await panel.getByRole("menuitem", { name: "Browser", exact: true }).waitFor();
      await panel.getByRole("menuitem", { name: "Terminal", exact: true }).waitFor();
      await page.keyboard.press("Escape");
      expect(await panel.getAttribute("data-connect-count")).toBe("1");
      expect(await text(panel, "Desktop sources").count()).toBe(0);
    }));

  it("does not observe after closing a status refresh", () =>
    withDesktopPage(async (page) => {
      const gateway = await desktopGateway(page, [], observe("stale", false));
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.deferNext("environments.status");
      const inventoryCount = await requestCount(gateway, "environments.status");

      await openDirectDesktop(page, "worker-desktop-1");
      await expect
        .poll(() => requestCount(gateway, "environments.status"))
        .toBe(inventoryCount + 1);
      await page
        .locator("openclaw-desktop-panel")
        .getByRole("status")
        .filter({ hasText: "Connecting to desktop…" })
        .waitFor();
      expect(await gateway.getRequests("desktop.observe")).toHaveLength(0);
      await button(page, "Close Desktop").click();
      await page.locator("openclaw-desktop-panel").waitFor({ state: "detached" });
      await gateway.resolveDeferred("environments.status", workerDesktopEnvironment);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );

      expect(
        await page.locator("openclaw-desktop-panel section[aria-label='Desktop']").count(),
      ).toBe(0);
      expect(await gateway.getRequests("desktop.observe")).toHaveLength(0);
    }));

  it("keeps the current desktop target and control mode in the mobile overflow link", () =>
    withDesktopPage(async (page) => {
      await page.setViewportSize({ width: 390, height: 844 });
      const gateway = await desktopGateway(page, [workerDesktopEnvironment], observationCases(), {
        deferredMethods: ["desktop.observe"],
        methodResponses: {
          "sessions.list": sessionsList("active"),
          "sessions.describe": { session: sessionsList("active").sessions[0] },
          "environments.status": workerDesktopEnvironment,
        },
      });
      await page.goto(`${suite.server.baseUrl}chat/main`);
      await activateChatHeaderPanelAction(page, "Desktop");
      const panel = page.locator("openclaw-desktop-panel").filter({ visible: true });
      await gateway.waitForRequest("desktop.observe");
      const rfb = await installScriptedRfbServer(page);
      await gateway.resolveDeferred("desktop.observe");
      await expect.poll(rfb.events).toEqual(["authenticated:1"]);
      await button(panel, "Desktop actions").click();
      const menu = panel.locator(".desktop-rail__menu:visible");
      await menu.waitFor();
      const link = menu.locator("a").filter({ hasText: "Open desktop in new window" });
      expect(await link.count()).toBe(1);
      expect(await link.getAttribute("href")).toBe("/focus/desktop/session/agent%3Amain%3Amain");
      expect(await link.getAttribute("target")).toBe("_blank");
      expect(await link.getAttribute("rel")).toContain("noopener");
      const icon = link.locator(".oc-menu-item__icon > svg");
      expect(
        await icon.evaluate((element) => {
          const style = getComputedStyle(element);
          return [style.width, style.height];
        }),
      ).toEqual(["18px", "18px"]);
      expect(await icon.isVisible()).toBe(true);
      for (const item of [link, menu.getByRole("menuitem", { name: "Disconnect", exact: true })]) {
        const alignment = await item.evaluate((element) => {
          const reference = element
            .closest(".desktop-rail__menu")!
            .querySelector(".desktop-toolbar-action")!;
          const iconLeft = (row: Element) => row.querySelector("svg")!.getBoundingClientRect().left;
          const labelLeft = (row: Element) =>
            row.querySelector(".oc-menu-item__label,.desktop-audio-label")!.getBoundingClientRect()
              .left;
          return [
            Math.abs(iconLeft(element) - iconLeft(reference)),
            Math.abs(labelLeft(element) - labelLeft(reference)),
          ];
        });
        expect(alignment[0]).toBeLessThan(0.5);
        expect(alignment[1]).toBeLessThan(0.5);
      }
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        await writeFile(
          path.join(suite.artifactDir, "desktop-mobile-window.png"),
          await takeControlUiViewportScreenshot(page, menu, [link]),
        );
      }
      expectObservation((await gateway.getRequests("desktop.observe"))[0]?.params, false);
      expect(await gateway.getRequests("desktop.observe")).toHaveLength(1);
      await page.keyboard.press("Escape");
      await panel.locator(".desktop-rail__control").click();
      await expect.poll(() => requestCount(gateway, "desktop.observe")).toBe(2);
      await expect.poll(rfb.events).toEqual(["authenticated:1", "authenticated:2", "closed:1"]);
      expectObservation((await gateway.getRequests("desktop.observe"))[1]?.params, true);
      await button(panel, "View only").waitFor();
      await button(panel, "Desktop actions").click();
      await menu.waitFor();
      expect(await link.getAttribute("href")).toBe(
        "/focus/desktop/control/session/agent%3Amain%3Amain",
      );
      expect(await link.getAttribute("target")).toBe("_blank");
      expect(await gateway.getRequests("desktop.observe")).toHaveLength(2);
    }));

  it("opens the focused desktop picker and keeps a right dock above bottom panels", () =>
    withDesktopPage(async (page) => {
      await desktopGateway(page);
      const panel = await openDesktopPanel(page, suite.server.baseUrl);
      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        button(page, "Open desktop in new window").click(),
      ]);
      await popup.waitForLoadState("domcontentloaded");
      expect(new URL(popup.url()).pathname).toBe("/focus/desktop");
      await popup.close();
      await button(panel, "Dock to right").click();
      const bottom = await panel.evaluate((element) => {
        document.documentElement.style.setProperty("--oc-terminal-reserve-bottom", "40px");
        document.documentElement.style.setProperty("--oc-browser-reserve-bottom", "80px");
        const section = element.querySelector<HTMLElement>(".bp--right");
        return section ? getComputedStyle(section).bottom : null;
      });
      expect(bottom).toBe("120px");
    }));

  it.each(["machine", "node"])(
    "connects the %s source with an in-memory VNC password",
    async (target) => {
      await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
        const isHost = target === "machine";
        const password = isHost ? "memory-only-test-password" : "node-password";
        const source = isHost ? { kind: "host" } : { kind: "node", nodeId: "paired-node" };
        const environments = isHost
          ? [
              hostEnvironment,
              {
                id: "legacy-nested-worker",
                type: "worker",
                status: "available",
                worker: {
                  providerId: "crabbox",
                  state: "ready",
                  ageMs: 1_000,
                  attachedSessionIds: [],
                  tunnelStatus: "connected",
                  desktop: true,
                },
              },
            ]
          : [
              {
                id: "node:paired-node",
                type: "node",
                status: "available",
                desktop: true,
                capabilities: ["desktop.stream"],
              },
              {
                id: "node:plain-node",
                type: "node",
                status: "available",
                capabilities: ["screen.snapshot"],
              },
            ];
        const gateway = await desktopGateway(page, environments, {
          sequence: [
            credentialsRequired(target),
            observe(isHost ? "host" : "node", false, {
              auth: "vnc-password",
              ...(!isHost && { preauthenticated: true }),
            }),
          ],
        });
        const panel = await openDesktopPanel(page, suite.server.baseUrl);
        await gateway.waitForRequest("environments.list");
        await text(panel, isHost ? "This machine" : "node:paired-node").waitFor();
        expect(await text(panel, isHost ? "legacy-nested-worker" : "node:plain-node").count()).toBe(
          0,
        );
        await installDesktopClientFake(panel);
        await button(panel, "Connect").click();
        if (isHost) {
          expect((await gateway.waitForRequest("desktop.observe")).params).toEqual({
            source,
            control: false,
          });
          await text(panel, "Enter the VNC password for this machine.").waitFor();
          expect(await panel.getAttribute("data-connect-count")).toBeNull();
        }
        await panel.getByLabel("VNC password", { exact: true }).fill(password);
        await button(panel, "Connect").click();
        await expect.poll(() => panel.getAttribute("data-connect-count")).toBe("1");
        expect(await panel.getAttribute("data-used-credentials")).toBe(String(isHost));
        const requests = await gateway.getRequests("desktop.observe");
        expect(requests.at(-1)?.params).toEqual({
          source,
          control: false,
          credentials: { password },
        });
        if (isHost) {
          expect(requests).toHaveLength(2);
          expect(await button(panel, "Browser").count()).toBe(0);
          expect(await button(panel, "Terminal").count()).toBe(0);
          expect(await gateway.getRequests("desktop.launch")).toHaveLength(0);
        }
      });
    },
  );

  it("settles desktop app launches across takeover and source changes", () =>
    withDesktopPage(async (page) => {
      const gateway = await desktopGateway(
        page,
        [workerEnvironment({ attachedSessionIds: ["agent:main:desktop"] })],
        observationCases(),
        {
          featureMethods: ["desktop.launch", "desktop.observe", "environments.list"],
          methodResponses: {
            "sessions.list": sessionsList("active"),
            "desktop.launch": { app: "browser", status: "ready" },
          },
        },
      );

      const panel = await openDesktopPanel(page, suite.server.baseUrl);
      await gateway.waitForRequest("environments.list");
      await text(panel, "worker-desktop-1").waitFor();
      await text(panel, "agent:main:desktop").waitFor();
      const rfb = await installScriptedRfbServer(page);
      await gateway.deferNext("desktop.observe");

      await button(panel, "Connect").click();
      const viewRequest = await gateway.waitForRequest("desktop.observe");
      expectObservation(viewRequest.params);
      await panel.getByRole("status", { name: "Connecting to desktop…" }).waitFor();
      await button(panel, "Browser").waitFor();
      await button(panel, "Terminal").waitFor();
      expect(await text(panel, "View only").count()).toBe(0);
      expect(await panel.getByText(/Controlling/).count()).toBe(0);

      const browserButton = button(panel, "Browser");
      const terminalButton = button(panel, "Terminal");
      expect(
        await browserButton.evaluate((element) => getComputedStyle(element).backgroundColor),
      ).toBe("rgba(0, 0, 0, 0)");
      const layout = await panel.evaluate((element) => {
        const surface = element.querySelector<HTMLElement>(".desktop-surface");
        const stage = element.querySelector<HTMLElement>(".desktop-stage");
        const overlay = element.querySelector<HTMLElement>(".desktop-stage__take-control");
        const reference = document.createElement("div");
        reference.style.background = "var(--bg)";
        element.append(reference);
        const background =
          surface !== null &&
          getComputedStyle(surface).backgroundColor === getComputedStyle(reference).backgroundColor;
        reference.remove();
        const stageRect = stage?.getBoundingClientRect();
        const overlayRect = overlay?.getBoundingClientRect();
        const coversStage =
          stageRect !== undefined &&
          overlayRect !== undefined &&
          Math.abs(stageRect.width - overlayRect.width) < 1 &&
          Math.abs(stageRect.height - overlayRect.height) < 1;
        return { background, coversStage };
      });
      expect(layout).toEqual({ background: true, coversStage: true });
      const takeControl = button(panel, "Take control");
      expect(await takeControl.isEnabled()).toBe(false);
      await gateway.resolveDeferred("desktop.observe");
      await expect.poll(rfb.events).toContain("authenticated:1");
      await expect.poll(() => takeControl.isEnabled()).toBe(true);
      expect(await text(panel, "View only").count()).toBe(1);
      for (const outcome of ["success", "failure"] as const) {
        const launchesBefore = await requestCount(gateway, "desktop.launch");
        await gateway.deferNext("desktop.launch");
        await browserButton.click();
        const launchRequest = await gateway.waitForRequest("desktop.launch", {
          after: launchesBefore,
        });
        expect(launchRequest.params).toEqual({
          source: environmentSource,
          app: "browser",
        });
        await expect.poll(() => browserButton.getAttribute("aria-busy")).toBe("true");
        expect(await terminalButton.isEnabled()).toBe(true);

        const observationsBefore = await requestCount(gateway, "desktop.observe");
        const connectionsBefore = await rfb.connectionCount();
        await gateway.deferNext("desktop.observe");
        await takeControl.click();
        const controlRequest = await gateway.waitForRequest("desktop.observe", {
          after: observationsBefore,
        });
        expectObservation(controlRequest.params, true);
        // Launch completion belongs to the machine while its replacement viewer is pending.
        if (outcome === "success") {
          await gateway.resolveDeferred("desktop.launch", { app: "browser", status: "ready" });
        } else {
          await gateway.rejectDeferred("desktop.launch", {
            message: "worker desktop app launch unavailable; try again",
          });
        }
        await expect.poll(() => browserButton.getAttribute("aria-busy")).toBe("false");
        expect(await browserButton.isEnabled()).toBe(true);
        if (outcome === "failure") {
          await panel
            .getByRole("alert")
            .filter({ hasText: "worker desktop app launch unavailable; try again" })
            .waitFor();
        } else {
          expect(await panel.getByRole("alert").count()).toBe(0);
        }
        await gateway.resolveDeferred("desktop.observe");
        await expect.poll(rfb.connectionCount).toBe(connectionsBefore + 1);
        expect(await takeControl.count()).toBe(0);

        await button(panel, "Disconnect").click();
        await text(panel, "Desktop sources").waitFor();
        expect(await panel.getByRole("alert").count()).toBe(0);
        await button(panel, "Connect").click();
        await browserButton.waitFor();
      }

      const launchesBeforeSwitch = await requestCount(gateway, "desktop.launch");
      await gateway.deferNext("desktop.launch");
      await browserButton.click();
      await gateway.waitForRequest("desktop.launch", { after: launchesBeforeSwitch });
      await button(panel, "Disconnect").click();
      await text(panel, "Desktop sources").waitFor();
      await gateway.setMethodResponse("environments.list", {
        environments: [{ ...workerDesktopEnvironment, id: "worker-desktop-2" }],
      });
      await gateway.setMethodResponse("desktop.observe", {
        transport: "rfb",
        wsPath: "/desktop/observe?token=replacement",
        control: false,
      });
      await button(panel, "Refresh").click();
      await text(panel, "worker-desktop-2").waitFor();
      await button(panel, "Connect").click();
      await browserButton.waitFor();
      await gateway.rejectDeferred("desktop.launch", { message: "stale desktop launch failure" });
      expect(await panel.getByRole("alert").count()).toBe(0);
      expect(await browserButton.getAttribute("aria-busy")).toBe("false");
      expect(await browserButton.isEnabled()).toBe(true);

      await button(panel, "Disconnect").click();
      await text(panel, "Desktop sources").waitFor();
      await expect
        .poll(
          async () => (await rfb.events()).filter((event) => event.startsWith("closed:")).length,
        )
        .toBe(await rfb.connectionCount());
    }));

  it("takes control by clicking a real noVNC-mounted desktop", () =>
    withDesktopPage(async (page) => {
      const { gateway, rfb, panel } = await openScriptedDesktop(page, {
        disconnectAfterLastPeer: true,
      });
      const canvas = panel.locator(".desktop-surface canvas");
      const canvasHandle = await canvas.elementHandle();
      await button(panel, "Enter fullscreen").click();
      await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
      expect(await canvas.evaluate((element, original) => element === original, canvasHandle)).toBe(
        true,
      );
      expect(await gateway.getRequests("desktop.observe")).toHaveLength(1);

      const takeControl = button(panel, "Take control");
      await takeControl.waitFor();
      // A successful click proves the overlay hit-tests above the real canvas.
      await takeControl.click();
      await expect.poll(() => requestCount(gateway, "desktop.observe")).toBe(2);
      const observeRequests = await gateway.getRequests("desktop.observe");
      expectObservation(observeRequests[1]?.params, true);
      await expect.poll(rfb.events).toEqual(["authenticated:1", "authenticated:2", "closed:1"]);
      await expect.poll(() => panel.locator(".desktop-surface canvas").count()).toBe(1);
      expect(await panel.getByRole("status", { name: "Connecting to desktop…" }).count()).toBe(0);
      expect(await takeControl.count()).toBe(0);
      expect(await page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
      await button(panel, "Exit fullscreen").click();
      await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
    }));

  it.each([
    { name: "view-only text", control: false, format: 1 as const },
    { name: "controlling unsupported format", control: true, format: 2 as const },
    { name: "controlling text", control: true, format: 1 as const },
  ])(
    "renders the next RFB frame after coalesced and fragmented $name Provide",
    async ({ control, format }) => {
      await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
        const { gateway, rfb, panel } = await openScriptedDesktop(page);
        if (control) {
          await button(panel, "Take control").click();
          await expect.poll(rfb.events).toEqual(["authenticated:1", "authenticated:2", "closed:1"]);
        }
        for (const [delivery, red] of [
          ["coalesced", 24],
          ["fragmented", 25],
        ] as const) {
          const provide = createRfbClipboardProvide(format);
          const frame = createRfbRawFrame();
          // The previous delivery's frame must not satisfy this delivery's wait.
          frame[16] = red;
          await rfb.send(
            delivery === "coalesced"
              ? [[...provide, ...frame]]
              : [...provide.map((byte) => [byte]), frame],
          );
          // Observe both terminal outcomes so the broken stream fails without waiting for a missing frame.
          const outcome = () =>
            panel.evaluate((element, expectedRed) => {
              if (element.textContent?.includes("Desktop disconnected:")) {
                return "disconnected";
              }
              const canvas = element.querySelector<HTMLCanvasElement>(".desktop-surface canvas");
              const pixel = canvas?.getContext("2d")?.getImageData(0, 0, 1, 1).data;
              return pixel && [...pixel].join(",") === `${expectedRed},180,160,255`
                ? "frame"
                : null;
            }, red);
          await expect.poll(outcome).not.toBeNull();
          expect(await outcome(), delivery).toBe("frame");
          expect(await gateway.getRequests("desktop.observe")).toHaveLength(control ? 2 : 1);
          expect(await button(panel, "Reconnect").count()).toBe(0);
        }
      });
    },
  );

  it.each([
    {
      kind: "invalid server message",
      expected: "Reconnect. If it fails again,",
    },
    { kind: "server close", expected: "synthetic desktop service stopped" },
  ])("explains real RFB $kind failures", async ({ kind, expected }) => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") {
          consoleErrors.push(message.text());
        }
      });
      const { rfb, panel } = await openScriptedDesktop(page);
      if (kind === "server close") {
        await rfb.disconnect(expected);
      } else {
        await rfb.send([[120]]);
      }
      await button(panel, "Reconnect").waitFor();
      const message = await panel.locator(".desktop-status").textContent();
      expect(message).toContain(expected);
      expect(message).not.toContain("unknown reason");
      await expect.poll(rfb.events).toEqual(["authenticated:1", "closed:1"]);
      expect(consoleErrors).not.toContain("Tried changing state of a disconnected RFB object");
    });
  });

  it("shows only apps advertised by the selected environment", () =>
    withDesktopPage(async (page) => {
      const gateway = await desktopGateway(
        page,
        [
          workerEnvironment(
            { state: "ready", attachedSessionIds: [], desktopApps: ["terminal"] },
            "terminal-only-worker",
          ),
        ],
        observe("view", false),
        {
          featureMethods: ["desktop.launch", "desktop.observe", "environments.list"],
          methodResponses: { "sessions.list": sessionsList("active") },
        },
      );

      const panel = await openDesktopPanel(page, suite.server.baseUrl);
      await gateway.waitForRequest("environments.list");
      await installDesktopClientFake(panel);
      await button(panel, "Connect").click();
      await button(panel, "Terminal").waitFor();
      expect(await button(panel, "Browser").count()).toBe(0);
    }));
});
