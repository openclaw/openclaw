import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { buildControlUiFocusPath } from "@openclaw/session-url-contract";
import type { Locator, Page } from "playwright";
import { createServer } from "vite";
import { expect, it } from "vitest";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { captureControlUiE2eFailureDiagnostics } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  createDesktopResizeGuest,
  observeDesktopFilterPackets,
  readDesktopResizeFixture,
  resizeSources,
  seedDesktopResizeSources,
  writeDesktopResizeProvider,
} from "./desktop-resize-real.test-support.ts";

const fixturePath = process.env.OPENCLAW_DESKTOP_REAL_FIXTURE;
let gatewayPort: number;
const suite = createControlUiE2eSuite({
  name: "Desktop resize real Gateway",
  browserLaunchOptions: { args: ["--window-size=1440,1000"] },
  startServerBeforeBrowser: true,
  // The suite owns the authenticated proxy; the scenario owns its real Gateway.
  startServer: async () => {
    gatewayPort = await getFreePort();
    const proxyPort = await getFreePort();
    const proxy = await createServer({
      configFile: false,
      envFile: false,
      appType: "custom",
      logLevel: "error",
      server: {
        host: "127.0.0.1",
        port: proxyPort,
        strictPort: true,
        proxy: {
          "/": {
            target: `http://127.0.0.1:${gatewayPort}`,
            ws: true,
            headers: {
              "x-forwarded-for": "192.0.2.10",
              "x-forwarded-proto": "http",
              "x-forwarded-user": "resize-operator@example.test",
            },
          },
        },
      },
    });
    try {
      await proxy.listen();
      return { baseUrl: `http://127.0.0.1:${proxyPort}/`, close: () => proxy.close() };
    } catch (error) {
      await proxy.close();
      throw error;
    }
  },
});

async function framebuffer(canvas: Locator) {
  return await canvas.evaluate((element) => {
    const surface = element as HTMLCanvasElement;
    return { width: surface.width, height: surface.height };
  });
}

async function resizeWindow(page: Page, width: number, height: number) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { width, height } });
    await expect.poll(() => page.evaluate(() => window.outerWidth)).toBe(width);
    await expect.poll(() => page.evaluate(() => window.outerHeight)).toBe(height);
  } finally {
    await cdp.detach();
  }
}

async function captureDesktopSockets(page: Page) {
  // Observe native sockets so forbidden messages exercise the production filter.
  // No connection, RFB authentication, RPC, or bridge is replaced.
  await page.addInitScript(() => {
    localStorage.setItem(
      "openclaw:control-ui:community-invite",
      JSON.stringify({ dismissedAtMs: 1770000000000 }),
    );
    const NativeSocket = window.WebSocket;
    const sockets: WebSocket[] = [];
    Object.assign(window, { desktopProofSockets: sockets });
    // noVNC checks the immediate raw-channel prototype. Observe construction
    // without subclassing or changing the native socket/prototype it receives.
    window.WebSocket = new Proxy(NativeSocket, {
      construct(target, args) {
        const socket = Reflect.construct(target, args) as WebSocket;
        if (new URL(socket.url).pathname === "/desktop/observe") {
          sockets.push(socket);
          socket.addEventListener("close", (event) =>
            console.info("Desktop proof socket closed", event.code, event.reason),
          );
          socket.addEventListener("error", () => console.error("Desktop proof socket error"));
        }
        return socket;
      },
    });
  });
}

suite.define(() => {
  it.skipIf(!fixturePath)(
    "matches a real XFCE display through the production observer and preserves controller ownership",
    async (context) => {
      const fixture = await readDesktopResizeFixture(fixturePath!);
      const baseUrl = suite.server.baseUrl;
      const state = await createOpenClawTestState({
        label: "desktop-resize-real-gateway",
        layout: "home",
        env: {
          OPENCLAW_GATEWAY_PASSWORD: undefined,
          OPENCLAW_GATEWAY_TOKEN: undefined,
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
          VITEST: "1",
        },
      });
      let gateway: GatewayServer | undefined;
      let guest: Awaited<ReturnType<typeof createDesktopResizeGuest>> | undefined;
      const packetProbe = observeDesktopFilterPackets(context.signal);
      const samples: Array<{ stage: string; width: number; height: number }> = [];
      await suite.runScenario(context, {
        retainedState: () => state.root,
        run: async () => {
          const pluginDir = await writeDesktopResizeProvider(
            state.workspaceDir,
            fixture.identityPath,
          );
          const trustedProxy = {
            allowLoopback: true,
            allowUsers: ["resize-operator@example.test"],
            deviceAutoApprove: {
              enabled: true,
              scopes: ["operator.admin", "operator.read", "operator.write"],
            },
            requiredHeaders: ["x-forwarded-proto"],
            userHeader: "x-forwarded-user",
          };
          await state.writeConfig({
            agents: {
              defaults: {
                workspace: state.workspaceDir,
                model: { primary: "openai/gpt-4.1" },
                models: { "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } } },
              },
            },
            cloudWorkers: {
              desktop: true,
              profiles: { "resize-fixture": { provider: "desktop-resize-fixture", settings: {} } },
            },
            plugins: {
              allow: ["desktop-resize-fixture"],
              load: { paths: [pluginDir] },
              entries: { "desktop-resize-fixture": { enabled: true } },
            },
            gateway: {
              auth: { mode: "trusted-proxy", trustedProxy },
              controlUi: {
                enabled: true,
                root: path.resolve(fixture.controlUiRoot ?? "dist/control-ui"),
                allowedOrigins: [baseUrl.slice(0, -1)],
              },
              port: gatewayPort,
              trustedProxies: ["127.0.0.1", "::1"],
            },
          });
          const { startGatewayServer } = await import("../../../src/gateway/server.js");
          gateway = await startGatewayServer(gatewayPort, {
            bind: "loopback",
            sidecarStartup: "start",
          });
          await gateway.startupSettled;
          seedDesktopResizeSources(fixture);
          guest = await createDesktopResizeGuest(fixture);
          const browserContext = await suite.newBrowserContext({
            viewport: null,
            locale: "en-US",
            serviceWorkers: "block",
          });
          const page = await browserContext.newPage();
          const pageErrors: string[] = [];
          const observations: Array<Record<string, unknown>> = [];
          page.on("websocket", (socket) => {
            if (new URL(socket.url()).pathname === "/desktop/observe") {
              return;
            }
            const requests = new Set<string>();
            socket.on("framesent", ({ payload }) => {
              const frame = asNullableRecord(JSON.parse(String(payload)));
              if (
                frame?.type === "req" &&
                frame.method === "desktop.observe" &&
                typeof frame.id === "string"
              ) {
                requests.add(frame.id);
              }
            });
            socket.on("framereceived", ({ payload }) => {
              const frame = asNullableRecord(JSON.parse(String(payload)));
              if (frame?.type === "res" && typeof frame.id === "string" && requests.has(frame.id)) {
                const observed = asNullableRecord(frame.payload);
                observations.push({
                  ok: frame.ok,
                  auth: observed?.auth ?? null,
                  passwordPresent: Boolean(observed?.vncPassword),
                  preauthenticated: observed?.preauthenticated === true,
                  control: observed?.control,
                  canResize: observed?.canResize,
                });
              }
            });
          });
          const pageEvents: NonNullable<
            Parameters<typeof captureControlUiE2eFailureDiagnostics>[1]["pageEvents"]
          > = [];
          const recordEvent = (event: (typeof pageEvents)[number]) => {
            pageEvents.push(event);
            if (pageEvents.length > 200) {
              pageEvents.shift();
            }
          };
          page.on("pageerror", (error) => pageErrors.push(error.message));
          page.on("console", (message) =>
            recordEvent({
              at: new Date().toISOString(),
              source: "console",
              details: { type: message.type(), text: message.text() },
            }),
          );
          page.on("requestfailed", (request) =>
            recordEvent({
              at: new Date().toISOString(),
              source: "requestfailed",
              details: {
                path: new URL(request.url()).pathname,
                failure: request.failure(),
              },
            }),
          );
          await captureDesktopSockets(page);
          const assets = new Map<string, string>();
          const assetReads: Promise<unknown>[] = [];
          page.on("response", (response) => {
            if (/\/assets\/(?:index|desktop)[^/]*\.js$/u.test(new URL(response.url()).pathname)) {
              assetReads.push(
                response.body().then(
                  (bytes) =>
                    assets.set(
                      path.basename(new URL(response.url()).pathname),
                      createHash("sha256").update(bytes).digest("hex"),
                    ),
                  () => {},
                ),
              );
            }
          });
          await page.goto(new URL("activity", baseUrl).href);
          await waitForControlUiGatewayReady(page);
          await page.evaluate(() => {
            window.dispatchEvent(
              new CustomEvent("openclaw:desktop-toggle", {
                detail: { open: true, environmentId: "desktop-resize-dynamic" },
              }),
            );
          });
          const panel = page.locator("openclaw-desktop-panel");
          const canvas = panel.locator(".desktop-surface canvas");
          try {
            await canvas.waitFor();
          } catch (error) {
            await writeFile(
              path.join(suite.artifactDir, "connection-diagnostics.json"),
              JSON.stringify(
                {
                  panel: await panel.evaluate((element) => ({
                    html: element.shadowRoot?.innerHTML,
                    bounds: element.getBoundingClientRect().toJSON(),
                    canvases: [...(element.shadowRoot?.querySelectorAll("canvas") ?? [])].map(
                      (surface) => ({
                        width: surface.width,
                        height: surface.height,
                        bounds: surface.getBoundingClientRect().toJSON(),
                      }),
                    ),
                  })),
                  sockets: await page.evaluate(() =>
                    (
                      window as unknown as { desktopProofSockets: WebSocket[] }
                    ).desktopProofSockets.map((socket) => ({
                      path: new URL(socket.url).pathname,
                      readyState: socket.readyState,
                    })),
                  ),
                  pageErrors,
                  pageEvents,
                  observations,
                },
                null,
                2,
              ),
            );
            await captureControlUiE2eFailureDiagnostics(page, {
              error: error instanceof Error ? error : new Error(String(error)),
              label: "desktop-resize-connection",
              pageErrors,
              pageEvents,
            });
            throw error;
          }
          const initial = await guest.geometry();
          await expect.poll(() => framebuffer(canvas)).toEqual(initial);
          const originalCanvas = await canvas.elementHandle();
          await panel.getByRole("button", { name: "Take control", exact: true }).click();
          const menu = panel.getByRole("combobox", { name: "Desktop size", exact: true });
          await expect
            .poll(() => originalCanvas!.evaluate((element) => element.isConnected))
            .toBe(false);
          await expect.poll(() => canvas.count()).toBe(1);
          await expect.poll(() => framebuffer(canvas)).toEqual(initial);
          await page.screenshot({ path: path.join(suite.artifactDir, "01-fit.png") });
          await resizeWindow(page, 1200, 850);
          await expect.poll(() => framebuffer(canvas)).toEqual(initial);
          expect(await guest.geometry()).toEqual(initial);
          // Let a base UI without Match reach the geometry assertion: the regression
          // must be an unchanged guest framebuffer, not merely a missing selector.
          const matchOffered = (await menu.locator('option[value="match"]').count()) === 1;
          if (matchOffered) {
            await menu.selectOption("match");
          }
          await Promise.all(assetReads);
          expect(assets.size).toBeGreaterThan(0);
          await writeFile(
            path.join(suite.artifactDir, "served-assets.json"),
            JSON.stringify(Object.fromEntries(assets), null, 2),
          );

          const verifyMatch = async (stage: string, target = canvas) => {
            const expected = await target.evaluate((element) => {
              const bounds = element.parentElement!.getBoundingClientRect();
              return { width: Math.floor(bounds.width), height: Math.floor(bounds.height) };
            });
            await writeFile(
              path.join(suite.artifactDir, `${stage}-geometry.json`),
              JSON.stringify(
                {
                  stage,
                  expected,
                  guest: await guest!.geometry(),
                  canvas: await framebuffer(target),
                  matchOffered,
                },
                null,
                2,
              ),
            );
            await target.page().screenshot({ path: path.join(suite.artifactDir, `${stage}.png`) });
            await expect.poll(() => guest!.geometry()).toEqual(expected);
            await expect.poll(() => framebuffer(target)).toEqual(expected);
            samples.push({ stage, ...expected });
            await writeFile(
              path.join(suite.artifactDir, `${stage}-geometry.json`),
              JSON.stringify(
                {
                  stage,
                  expected,
                  guest: await guest!.geometry(),
                  canvas: await framebuffer(target),
                  matchOffered,
                },
                null,
                2,
              ),
            );
            await target.page().screenshot({ path: path.join(suite.artifactDir, `${stage}.png`) });
          };
          await verifyMatch("02-panel");
          expect(matchOffered).toBe(true);
          const resizer = panel.locator(".bp-resizer");
          const bounds = await resizer.boundingBox();
          if (!bounds) {
            throw new Error("Desktop panel resize handle is missing");
          }
          await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
          await page.mouse.down();
          await page.mouse.move(bounds.x - 130, bounds.y + bounds.height / 2);
          await page.mouse.up();
          await verifyMatch("03-panel-resized");
          await panel.locator(".desktop-fullscreen-button").click();
          await expect
            .poll(() => page.evaluate(() => document.fullscreenElement !== null))
            .toBe(true);
          await verifyMatch("04-fullscreen");
          await panel.locator(".desktop-fullscreen-button").click();
          await menu.selectOption("fit");
          const fitted = await guest.geometry();
          await resizeWindow(page, 1350, 950);
          expect(await guest.geometry()).toEqual(fitted);
          await menu.selectOption("actual");
          expect(await guest.geometry()).toEqual(fitted);

          const observerContext = await suite.newBrowserContext({
            viewport: null,
            serviceWorkers: "block",
          });
          const observer = await observerContext.newPage();
          await captureDesktopSockets(observer);
          await observer.goto(
            new URL(
              buildControlUiFocusPath({
                kind: "desktop",
                source: resizeSources.dynamic,
              }),
              baseUrl,
            ).href,
          );
          const observerPanel = observer.locator("openclaw-desktop-panel");
          const observerCanvas = observerPanel.locator("canvas");
          await expect.poll(() => framebuffer(observerCanvas)).toEqual(fitted);
          expect(await observerPanel.locator('option[value="match"]').count()).toBe(0);
          const resizeAttempt = await observer.evaluate(() => {
            const sockets = (window as unknown as { desktopProofSockets: WebSocket[] })
              .desktopProofSockets;
            const packet = new Uint8Array(24);
            const view = new DataView(packet.buffer);
            packet[0] = 251;
            packet[6] = 1;
            view.setUint16(2, 701);
            view.setUint16(4, 509);
            view.setUint16(16, 701);
            view.setUint16(18, 509);
            return { socketUrl: sockets.at(-1)!.url, bytes: Array.from(packet) };
          });
          const resized = packetProbe.expectPacket(resizeAttempt.socketUrl, resizeAttempt.bytes);
          await observer.evaluate(({ socketUrl, bytes }) => {
            const sockets = (window as unknown as { desktopProofSockets: WebSocket[] })
              .desktopProofSockets;
            sockets.find((socket) => socket.url === socketUrl)!.send(Uint8Array.from(bytes));
          }, resizeAttempt);
          expect(await resized).toEqual({ forward: Buffer.alloc(0) });
          await resizeWindow(observer, 700, 700);
          expect(await guest.geometry()).toEqual(fitted);
          await observerPanel.getByRole("button", { name: "Take control", exact: true }).click();
          await expect.poll(() => observerPanel.locator('option[value="match"]').count()).toBe(1);
          await expect.poll(() => panel.locator('option[value="match"]').count()).toBe(0);
          await observerPanel.getByRole("combobox", { name: "Desktop size" }).selectOption("match");
          for (const [stage, width, height] of [
            ["05-portrait", 390, 900],
            ["06-landscape", 900, 500],
          ] as const) {
            // Chromium clamps native windows below 500px. Only the outer UI
            // viewport is emulated; guest geometry and framebuffer remain real.
            await observer.setViewportSize({ width, height });
            await verifyMatch(stage, observerCanvas);
            expect(
              await observerPanel.locator(".desktop-touch-action, .desktop-sizing").count(),
            ).toBe(4);
          }
          const colorCount = await observerCanvas.evaluate((element) => {
            const surface = element as HTMLCanvasElement;
            const pixels = surface
              .getContext("2d")!
              .getImageData(0, 0, surface.width, surface.height).data;
            const colors = new Set<number>();
            for (let index = 0; index < pixels.length; index += 128) {
              colors.add((pixels[index]! << 16) | (pixels[index + 1]! << 8) | pixels[index + 2]!);
            }
            return colors.size;
          });
          expect(colorCount).toBeGreaterThan(8);
          await guest.run(["rm", "-f", "/tmp/openclaw-desktop-resize-input"]);
          await guest.run([
            "env",
            "DISPLAY=:99",
            "xdotool",
            "search",
            "--name",
            "^OpenClaw resize proof$",
            "windowactivate",
            "--sync",
          ]);
          await observerCanvas.click({ position: { x: 80, y: 90 } });
          await observer.keyboard.type("printf controller > /tmp/openclaw-desktop-resize-input");
          await observer.keyboard.press("Enter");
          await expect
            .poll(() => guest!.run(["cat", "/tmp/openclaw-desktop-resize-input"]))
            .toBe("controller");
          await expect.poll(() => framebuffer(canvas)).toEqual(await guest.geometry());
          await expect
            .poll(() =>
              page.evaluate(() => {
                const sockets = (window as unknown as { desktopProofSockets: WebSocket[] })
                  .desktopProofSockets;
                return sockets.at(-1)?.readyState;
              }),
            )
            .toBe(1);
          const inputAttempt = await page.evaluate(() => {
            const sockets = (window as unknown as { desktopProofSockets: WebSocket[] })
              .desktopProofSockets;
            const socket = sockets.at(-1)!;
            const keys = Array.from("printf observer > /tmp/openclaw-desktop-resize-input", (key) =>
              key.codePointAt(0)!,
            );
            keys.push(0xff0d);
            const packet = new Uint8Array(keys.length * 16);
            const view = new DataView(packet.buffer);
            keys.forEach((keysym, index) => {
              const offset = index * 16;
              packet[offset] = 4;
              packet[offset + 1] = 1;
              view.setUint32(offset + 4, keysym);
              packet[offset + 8] = 4;
              view.setUint32(offset + 12, keysym);
            });
            return { socketUrl: socket.url, bytes: Array.from(packet) };
          });
          const inputProcessed = packetProbe.expectPacket(
            inputAttempt.socketUrl,
            inputAttempt.bytes,
          );
          await page.evaluate(({ socketUrl, bytes }) => {
            const sockets = (window as unknown as { desktopProofSockets: WebSocket[] })
              .desktopProofSockets;
            sockets.find((socket) => socket.url === socketUrl)!.send(Uint8Array.from(bytes));
          }, inputAttempt);
          expect(await inputProcessed).toEqual({ forward: Buffer.alloc(0) });
          expect(await guest.run(["cat", "/tmp/openclaw-desktop-resize-input"])).toBe("controller");
          expect(await panel.locator('option[value="match"]').count()).toBe(0);
          expect(await observerPanel.locator('option[value="match"]').count()).toBe(1);
          await suite.closeBrowserContext(observerContext);

          for (const source of [resizeSources.fixed, resizeSources.unmanaged]) {
            await page.goto(
              new URL(
                buildControlUiFocusPath({
                  kind: "desktop",
                  source,
                  control: true,
                }),
                baseUrl,
              ).href,
            );
            const current = page.locator("openclaw-desktop-panel");
            const currentCanvas = current.locator("canvas");
            const geometry = await guest.geometry(source === resizeSources.fixed ? ":100" : ":99");
            await expect.poll(() => framebuffer(currentCanvas)).toEqual(geometry);
            const sizing = current.getByRole("combobox", { name: "Desktop size" });
            if (source === resizeSources.fixed) {
              await sizing.selectOption("match");
            } else {
              expect(await sizing.locator('option[value="match"]').count()).toBe(0);
            }
            await resizeWindow(page, 1100, 800);
            await expect.poll(() => framebuffer(currentCanvas)).toEqual(geometry);
            expect(await guest.geometry(source === resizeSources.fixed ? ":100" : ":99")).toEqual(
              geometry,
            );
            await sizing.selectOption("actual");
            await sizing.selectOption("fit");
          }
          await Promise.all(assetReads);
          expect(assets.size).toBeGreaterThan(0);
          await writeFile(
            path.join(suite.artifactDir, "resize-proof.json"),
            JSON.stringify(
              {
                crabboxCommit: fixture.crabboxCommit,
                installerSha256: fixture.installerSha256,
                provisioning:
                  "fixture provider and durable worker records; production Gateway observation, SSH, registry, and RFB filter",
                instrumentation:
                  "instrumented production-path proof: exact observer socket and complete injected packets, unchanged stateful filter results",
                carrier: "SSH only; node ticket preauthentication is not exercised",
                viewports: "native desktop windows; viewport-emulated mobile, not a physical phone",
                observer: { keyboardForwardedBytes: 0, resizeForwardedBytes: 0 },
                assets: Object.fromEntries(assets),
                samples,
                pixels: { distinctSampledColors: colorCount },
              },
              null,
              2,
            ),
          );
        },
        close: async () => {
          try {
            await gateway?.close({ reason: "desktop resize proof cleanup" });
            await guest?.close();
          } finally {
            packetProbe.close();
          }
        },
        release: () => state.cleanup(),
      });
    },
    120_000,
  );
});
