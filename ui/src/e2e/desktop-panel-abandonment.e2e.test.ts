import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type {
  DesktopClient,
  DesktopConnectionHandle,
} from "../components/desktop/desktop-client.ts";
import { getControlUiContextHandle } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import {
  createRfbPngFrame,
  createRfbRawFrame,
  installScriptedRfbServer,
} from "./desktop-rfb-test-support.ts";
import { canvasPixel, desktopObservation, workerDesktop } from "./panel-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Desktop panel observation abandonment" });

suite.define(() => {
  it.each(["raw", "queued PNG"])(
    "waits for primary %s pixels after authentication, resize, cursor, name, and empty updates",
    async (encoding) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const environmentId = "worker-first-image";
        const environment = workerDesktop(environmentId);
        const gateway = await installMockGateway(page, {
          featureMethods: [
            "desktop.observe",
            "desktop.release",
            "environments.list",
            "environments.status",
          ],
          deferredMethods: ["desktop.observe"],
          methodResponses: {
            "environments.list": { environments: [environment] },
            "environments.status": environment,
            "desktop.observe": desktopObservation(
              "/desktop/observe?token=first-image-synthetic",
              true,
            ),
            "desktop.release": { released: true },
          },
        });
        await page.goto(`${suite.server.baseUrl}activity`);
        await waitForControlUiGatewayReady(page);
        const peer = await installScriptedRfbServer(page, { autoFirstImage: false });
        await page.evaluate(
          (target) =>
            window.dispatchEvent(
              new CustomEvent("openclaw:desktop-toggle", {
                detail: { open: true, environmentId: target },
              }),
            ),
          environmentId,
        );
        await gateway.waitForRequest("desktop.observe");
        const panel = page.locator("openclaw-desktop-panel");
        type ProbedPanel = HTMLElement & {
          desktopClientFactory: () => Pick<DesktopClient, "connect">;
          firstImageConnection: DesktopConnectionHandle;
        };
        await panel.evaluate((element) => {
          const host = element as ProbedPanel;
          host.dataset.firstImageReadies = "[]";
          const factory = host.desktopClientFactory;
          host.desktopClientFactory = () => {
            const client = factory.call(host);
            return {
              async connect(options) {
                host.firstImageConnection = await client.connect({
                  ...options,
                  onConnect() {
                    const canvas = options.target.querySelector("canvas");
                    const pixel = canvas?.getContext("2d")?.getImageData(0, 0, 1, 1).data;
                    const readies: unknown[] = JSON.parse(host.dataset.firstImageReadies ?? "[]");
                    readies.push({ pixel: pixel ? [...pixel] : null, at: performance.now() });
                    host.dataset.firstImageReadies = JSON.stringify(readies);
                    options.onConnect?.();
                  },
                });
                return host.firstImageConnection;
              },
            };
          };
        });
        await gateway.resolveDeferred("desktop.observe");
        await expect.poll(peer.events).toEqual(["authenticated:1"]);
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
            2,
            128,
            1,
            224,
            255,
            255,
            255,
            33, // DesktopSize 640x480.
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            0,
            0,
            1,
            0,
            1,
            255,
            255,
            255,
            17,
            0,
            0,
            255,
            0,
            128, // Real 1x1 cursor.
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            255,
            255,
            254,
            205,
            0,
            0,
            0,
            4,
            116,
            101,
            115,
            116, // DesktopName.
            0,
            0,
            0,
            0, // Empty FramebufferUpdate.
          ],
        ]);
        const canvas = panel.locator(".desktop-surface canvas");
        await expect
          .poll(() =>
            canvas.evaluate((element: HTMLCanvasElement) => [element.width, element.height]),
          )
          .toEqual([640, 480]);
        const readies = () =>
          panel.evaluate((element) =>
            JSON.parse((element as HTMLElement).dataset.firstImageReadies ?? "[]"),
          );
        const stage = process.env.OPENCLAW_FIRST_IMAGE_STAGE ?? "waiting";
        const save = async (name: string) => {
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
            return;
          }
          const frame = await takeControlUiScreenshotFrame(
            page,
            panel.locator("section[aria-label='Desktop']"),
            [],
            { animations: "disabled" },
          );
          await writeFile(
            path.join(suite.artifactDir, `${name}-${encoding.replace(" ", "-")}.png`),
            frame.png,
          );
        };
        await save(`first-image-${stage}`);
        await writeFile(
          path.join(suite.artifactDir, `first-image-${stage}-${encoding.replace(" ", "-")}.json`),
          JSON.stringify(
            {
              readies: await readies(),
              pixel: await canvasPixel(canvas),
              connections: await peer.connectionCount(),
            },
            null,
            2,
          ),
        );
        expect(await readies()).toEqual([]);
        await panel.evaluate((element) => {
          const handle = (element as ProbedPanel).firstImageConnection;
          handle.sendText("x");
          handle.sendBackspace();
        });
        expect(await peer.keyEvents()).toEqual([]);
        await panel.getByRole("status", { name: "Connecting to desktop…", exact: true }).waitFor();
        const frame = encoding === "raw" ? createRfbRawFrame() : createRfbPngFrame();
        await panel.evaluate((element, bytes) => {
          (element as HTMLElement).dataset.firstImageSentAt = String(performance.now());
          (window as typeof window & { desktopRfbSend(chunks: number[][]): void }).desktopRfbSend([
            bytes,
          ]);
        }, frame);
        await expect.poll(() => canvasPixel(canvas)).toEqual([24, 180, 160, 255]);
        await expect.poll(readies).toMatchObject([{ pixel: [24, 180, 160, 255] }]);
        await panel
          .getByRole("status", { name: "Connecting to desktop…", exact: true })
          .waitFor({ state: "hidden" });
        await panel.evaluate((element) =>
          (element as ProbedPanel).firstImageConnection.sendText("x"),
        );
        await expect.poll(peer.keyEvents).toEqual([
          { down: true, keysym: 120 },
          { down: false, keysym: 120 },
        ]);
        expect(await gateway.getRequests("desktop.observe")).toHaveLength(1);
        expect(await peer.connectionCount()).toBe(1);
        const timing = await panel.evaluate((element) => {
          const host = element as HTMLElement;
          const ready = JSON.parse(host.dataset.firstImageReadies ?? "[]")[0];
          return {
            firstImageSentAt: Number(host.dataset.firstImageSentAt),
            readyAt: ready.at,
            imageDeliveryToReadyMs: ready.at - Number(host.dataset.firstImageSentAt),
            readyPixel: ready.pixel,
          };
        });
        await writeFile(
          path.join(suite.artifactDir, `first-image-after-${encoding.replace(" ", "-")}.json`),
          JSON.stringify(timing, null, 2),
        );
        await save("first-image-after");
      });
    },
  );

  it("offers reconnect when a real noVNC handshake stalls, preserving its exact view-only target", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const environmentId = "worker-desktop-stalled";
      const environment = workerDesktop(environmentId);
      const gateway = await installMockGateway(page, {
        featureMethods: [
          "desktop.observe",
          "desktop.release",
          "environments.list",
          "environments.status",
        ],
        methodResponses: {
          "environments.list": { environments: [environment] },
          "environments.status": environment,
          "desktop.observe": desktopObservation(`/desktop/observe?token=${"c".repeat(48)}`),
          "desktop.release": { released: true },
        },
      });
      await page.goto(`${suite.server.baseUrl}activity`);
      await waitForControlUiGatewayReady(page);
      await page.clock.install();
      const rfb = await installScriptedRfbServer(page, { stallFirstHandshake: true });
      await page.evaluate((target) => {
        window.dispatchEvent(
          new CustomEvent("openclaw:desktop-toggle", {
            detail: { open: true, environmentId: target },
          }),
        );
      }, environmentId);
      const panel = page.locator("openclaw-desktop-panel");
      await expect.poll(rfb.events).toEqual(["handshake-stalled:1"]);
      const capture = async (name: string) => {
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
          return;
        }
        const frame = await takeControlUiScreenshotFrame(
          page,
          panel.locator("section[aria-label='Desktop']"),
          [],
          { animations: "disabled" },
        );
        await writeFile(path.join(suite.artifactDir, `${name}.png`), frame.png);
      };
      await capture("desktop-handshake-before");
      await page.clock.fastForward(30_000);
      await capture("desktop-handshake-after");
      await panel.getByRole("button", { name: "Reconnect", exact: true }).click();
      await expect.poll(rfb.events).toEqual(["handshake-stalled:1", "closed:1", "authenticated:2"]);
      const canvas = panel.locator(".desktop-surface canvas");
      await rfb.send([createRfbRawFrame()]);
      await expect.poll(() => canvasPixel(canvas)).toEqual([24, 180, 160, 255]);
      expect((await gateway.getRequests("desktop.observe")).map(({ params }) => params)).toEqual([
        { source: { kind: "environment", environmentId }, control: false },
        { source: { kind: "environment", environmentId }, control: false },
      ]);
      expect(await gateway.getRequests("desktop.release")).toHaveLength(1);
      await panel.getByRole("button", { name: "Take control", exact: true }).waitFor();
      expect(await panel.getByRole("status", { name: "Connecting to desktop…" }).count()).toBe(0);
    });
  });

  it("releases a late observation without opening RFB and reconnects on the same Gateway client", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const environmentId = "worker-desktop-abandonment";
      const discardedPath = `/desktop/observe?token=${"a".repeat(48)}`;
      const claimedPath = `/desktop/observe?token=${"b".repeat(48)}`;
      const environment = workerDesktop(environmentId);
      const gateway = await installMockGateway(page, {
        featureMethods: [
          "desktop.observe",
          "desktop.release",
          "environments.list",
          "environments.status",
        ],
        deferredMethods: ["desktop.observe"],
        methodResponses: {
          "environments.list": { environments: [environment] },
          "environments.status": environment,
          "desktop.observe": desktopObservation(discardedPath),
          "desktop.release": { released: true },
        },
      });
      await page.goto(`${suite.server.baseUrl}activity`);
      await waitForControlUiGatewayReady(page);
      const application = await getControlUiContextHandle(page);
      const requester = await application.evaluateHandle(
        (context) => context.gateway.snapshot.client,
      );
      const sameRequester = () =>
        application.evaluate((context, original) => {
          return context.gateway.snapshot.client === original && original?.connected === true;
        }, requester);
      // Only the RFB peer is scripted; the mounted viewer uses the real noVNC implementation.
      const rfb = await installScriptedRfbServer(page);
      const panel = page.locator("openclaw-desktop-panel");
      const open = () =>
        page.evaluate((target) => {
          window.dispatchEvent(
            new CustomEvent("openclaw:desktop-toggle", {
              detail: { open: true, environmentId: target },
            }),
          );
        }, environmentId);
      await open();
      await gateway.waitForRequest("desktop.observe");
      const pending = panel.getByRole("status", { name: "Connecting to desktop…" });
      await pending.waitFor();
      await panel.getByRole("button", { name: "Hide desktop panel", exact: true }).click();
      await panel.locator("section[aria-label='Desktop']").waitFor({ state: "hidden" });
      await gateway.resolveDeferred("desktop.observe");
      expect(await gateway.waitForRequest("desktop.release")).toMatchObject({
        params: { wsPath: discardedPath },
      });
      expect(await gateway.getRequests("desktop.release")).toHaveLength(1);
      expect(await sameRequester()).toBe(true);
      expect(await rfb.connectionCount()).toBe(0);
      expect(await rfb.events()).toEqual([]);

      await gateway.setMethodResponse("desktop.observe", desktopObservation(claimedPath));
      await open();
      await gateway.waitForRequest("desktop.observe", { after: 1 });
      const canvas = panel.locator(".desktop-surface canvas");
      await canvas.waitFor();
      await expect.poll(rfb.events).toEqual(["authenticated:1"]);
      await rfb.send([createRfbRawFrame()]);
      await expect.poll(() => canvasPixel(canvas)).toEqual([24, 180, 160, 255]);
      await expect.poll(() => pending.count()).toBe(0);
      expect(await sameRequester()).toBe(true);
      expect(await rfb.connectionCount()).toBe(1);
      expect(await gateway.getRequests("desktop.observe")).toHaveLength(2);

      await panel.getByRole("button", { name: "Hide desktop panel", exact: true }).click();
      await expect.poll(rfb.events).toEqual(["authenticated:1", "closed:1"]);
      expect((await gateway.getRequests("desktop.release")).map(({ params }) => params)).toEqual([
        { wsPath: discardedPath },
      ]);
      await requester.dispose();
      await application.dispose();
    });
  });
});
