import path from "node:path";
import { expect, it } from "vitest";
import type { LobsterCatalogEntry } from "../../../../packages/gateway-protocol/src/lobsterdex.ts";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { catalog } from "../../e2e/native-plugin-ui.test-support.ts";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../../test-helpers/control-ui-e2e.ts";

const suite = createControlUiE2eSuite({
  name: "Lobster Packs and native consumer",
  startServerBeforeBrowser: true,
});
const mountPath = "/reef-console";
const coralId = "reef/reef/coral";
const dancerId = "reef/reef/dancer";

// This fixture consumes only the public plugin host, like an OpenClaw Pet integration.
const consumerModule = `export default {
  id: "ui-fixture",
  activate(host) {
    host.ui.registerPage({ id: "proof", label: "Lobster Pack consumer", mount(container) {
      const title = document.createElement("h1"); title.textContent = "Lobster Pack consumer";
      const description = document.createElement("p"); description.textContent = "Both original characters below are rendered by OpenClaw core.";
      const art = document.createElement("div"); art.style.cssText = "display:flex;gap:32px;padding:32px 0";
      const coral = document.createElement("div"); coral.dataset.consumer = "coral";
      const dancer = document.createElement("div"); dancer.dataset.consumer = "dancer";
      art.append(coral, dancer);
      const inventory = document.createElement("output"); inventory.setAttribute("aria-label", "Shared inventory"); inventory.style.display = "block";
      const report = document.createElement("button"); report.textContent = "Meet Coral";
      const busy = document.createElement("button"); busy.textContent = "Make Dancer busy";
      container.append(title, description, art, report, busy, inventory);
      const first = host.components.mountClawmoji(coral, {clawmojiId: "${coralId}", label: "Coral", size: 96});
      const second = host.components.mountClawmoji(dancer, {clawmojiId: "${dancerId}", label: "Dancer", size: 96});
      const update = () => { inventory.textContent = JSON.stringify(host.lobsterdex.listInventory()); };
      const stop = host.lobsterdex.subscribe(update); update();
      report.onclick = () => host.lobsterdex.recordEncounter("${coralId}", {name: "Coral", shiny: true});
      busy.onclick = () => second.update({clawmojiId: "${dancerId}", pose: "busy", label: "Dancer", size:96});
      return { dispose() { stop(); first.dispose(); second.dispose(); } };
    }});
  }
};`;

suite.define(() => {
  it("shares original artwork and encounter history across the Dex and a native plugin", async () => {
    await suite.withPage(
      { viewport: { width: 1100, height: 760 }, serviceWorkers: "block", locale: "en-US" },
      async ({ page }) => {
        const proof =
          process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
            ? createControlUiE2eArtifactDir("lobsterdex-packs")
            : undefined;
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.addInitScript(() => {
          if (localStorage.getItem("openclaw.control.lobsterdex.v1") === null) {
            localStorage.setItem("openclaw.control.lobsterdex.v1", '["crimson"]');
          }
        });
        const gateway = await installMockGateway(page, {
          basePath: mountPath,
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "lobsterdex.catalog",
            "plugins.controlUi.list",
            "plugins.controlUi.report",
          ],
          methodResponses: {
            "plugins.controlUi.list": {
              ...catalog("one"),
              plugins: catalog("one").plugins.map((plugin) =>
                Object.assign(plugin, { entryUrl: `${mountPath}${plugin.entryUrl}` }),
              ),
            },
            "plugins.controlUi.report": { ok: true },
            "lobsterdex.catalog": { entries: [] },
          },
        });
        await page.route("**/__openclaw__/plugins/control-ui/ui-fixture/one/index.js", (route) =>
          route.fulfill({ status: 200, contentType: "text/javascript", body: consumerModule }),
        );
        const atlasUrl = await page.evaluate(() => {
          const canvas = document.createElement("canvas");
          canvas.width = 64;
          canvas.height = 32;
          const context = canvas.getContext("2d");
          if (!context) {
            throw new Error("Canvas unavailable");
          }
          context.fillStyle = "coral";
          context.fillRect(2, 2, 28, 28);
          context.fillStyle = "teal";
          context.beginPath();
          context.arc(48, 16, 14, 0, Math.PI * 2);
          context.fill();
          return canvas.toDataURL();
        });
        const artworkRequests: Array<{ path: string; authorized: boolean }> = [];
        await page.route("**/__openclaw__/plugin-lobster-art/**", async (route) => {
          const request = route.request();
          const pathname = new URL(request.url()).pathname;
          const authorized = request.headers().authorization === "Bearer e2e-device-token";
          artworkRequests.push({ path: pathname, authorized });
          if (!authorized) {
            await route.fulfill({ status: 401, body: "Bearer authentication required" });
            return;
          }
          if (!pathname.startsWith(`${mountPath}/__openclaw__/plugin-lobster-art/`)) {
            await route.fulfill({ status: 404, body: "Wrong resource base path" });
            return;
          }
          if (pathname.endsWith("/coral")) {
            await route.fulfill({
              status: 200,
              contentType: "image/svg+xml",
              body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80"><path d="M10 40L40 5L70 40L40 75Z" fill="coral"/><circle cx="30" cy="32" r="4"/><circle cx="50" cy="32" r="4"/></svg>',
            });
          } else {
            await route.fulfill({
              status: 200,
              contentType: "image/png",
              body: Buffer.from(atlasUrl.split(",")[1] ?? "", "base64"),
            });
          }
        });
        const entries: LobsterCatalogEntry[] = [
          {
            id: coralId,
            pluginId: "reef",
            packId: "reef",
            packName: "Reef Lobsters",
            source: "plugin",
            name: "Coral",
            description: "Original vector character",
            appearance: {
              kind: "svg",
              url: "/__openclaw__/plugin-lobster-art/reef/reef/coral",
              anchor: { x: 0.5, y: 1 },
            },
          },
          {
            id: dancerId,
            pluginId: "reef",
            packId: "reef",
            packName: "Reef Lobsters",
            source: "plugin",
            name: "Dancer",
            description: "Original animated atlas",
            appearance: {
              kind: "sprite-atlas",
              url: "/__openclaw__/plugin-lobster-art/reef/reef/dancer",
              anchor: { x: 0.5, y: 1 },
              frameWidth: 32,
              frameHeight: 32,
              animations: {
                idle: { frames: [0], fps: 1, loop: false },
                busy: { frames: [0, 1], fps: 12, loop: false },
              },
              reducedMotionFrame: 0,
            },
          },
        ];
        await page.goto(`${suite.server.baseUrl}reef-console/plugin?plugin=ui-fixture&id=proof`);
        await page.getByRole("heading", { name: "Lobster Pack consumer" }).waitFor();
        await gateway.waitForRequest("lobsterdex.catalog");
        await page.locator('[data-consumer="coral"] [data-state="unavailable"]').waitFor();
        if (proof) {
          await page.screenshot({ path: path.join(proof, "01-before-pack.png") });
        }
        await gateway.setMethodResponse("lobsterdex.catalog", { entries });
        await gateway.emitGatewayEvent("plugins.changed", {});
        const coral = page.locator('[data-consumer="coral"] img');
        const dancer = page.locator('[data-consumer="dancer"] img');
        await expect
          .poll(() => coral.evaluate((image: HTMLImageElement) => image.naturalWidth))
          .toBe(80);
        await expect
          .poll(() => dancer.evaluate((image: HTMLImageElement) => image.naturalWidth))
          .toBe(64);
        const readInventory = async () =>
          JSON.parse((await page.getByLabel("Shared inventory").textContent()) ?? "[]") as Array<{
            id: string;
            firstSeenAt: number | null;
            available: boolean;
          }>;
        expect(await readInventory()).toEqual([
          { id: "crimson", firstSeenAt: null, name: null, shinySeenAt: null, available: true },
        ]);
        await page.getByRole("button", { name: "Make Dancer busy" }).click();
        await expect
          .poll(() => dancer.evaluate((image: HTMLImageElement) => image.style.transform))
          .toBe("translate(-96px, 0px)");
        if (proof) {
          await page.screenshot({ path: path.join(proof, "02-custom-art-and-animation.png") });
        }
        await page.emulateMedia({ reducedMotion: "reduce" });
        await expect
          .poll(() => dancer.evaluate((image: HTMLImageElement) => image.style.transform))
          .toBe("translate(0px, 0px)");
        await page.getByRole("button", { name: "Meet Coral" }).click();
        await expect.poll(readInventory).toHaveLength(2);
        const firstSeenAt = (await readInventory()).find(
          (entry) => entry.id === coralId,
        )?.firstSeenAt;
        expect(firstSeenAt).toBeTypeOf("number");
        await page.goto(`${suite.server.baseUrl}reef-console/settings/lobsterdex`);
        const pack = page.locator('[data-lobster-pack="reef/reef"]');
        await pack.getByRole("heading", { name: "Reef Lobsters" }).waitFor();
        await expect
          .poll(() =>
            pack
              .getByRole("img", { name: "Coral", exact: true })
              .locator("img")
              .evaluate((image: HTMLImageElement) => image.naturalWidth),
          )
          .toBe(80);
        expect(await pack.textContent()).toContain("1/2 visited");
        const overlaps = await page.locator(".lobsterdex-page__card").evaluateAll((cards) =>
          cards.map((card) => {
            const artwork = card.querySelector(".clawmoji");
            const heading = card.querySelector("h3");
            if (!artwork || !heading) {
              throw new Error("Missing card artwork or heading");
            }
            return artwork.getBoundingClientRect().bottom - heading.getBoundingClientRect().top;
          }),
        );
        expect(Math.max(...overlaps)).toBeLessThanOrEqual(0);
        expect(await page.locator("#lobsterdex-crimson").getAttribute("class")).not.toContain(
          "unseen",
        );
        await pack.scrollIntoViewIfNeeded();
        if (proof) {
          await page.screenshot({ path: path.join(proof, "03-dex-shared-collection.png") });
        }
        await page.reload();
        await pack.waitFor();
        const persisted = await page.evaluate(() =>
          JSON.parse(localStorage.getItem("openclaw.control.lobsterdex.v1") ?? "{}"),
        );
        expect(persisted[coralId].firstSeenAt).toBe(firstSeenAt);
        expect(persisted.crimson).toEqual({});
        await gateway.setMethodResponse("lobsterdex.catalog", { entries: [] });
        await gateway.emitGatewayEvent("plugins.changed", {});
        await expect.poll(() => pack.count()).toBe(0);
        await page
          .getByRole("heading", { name: "Unavailable packs · collection history retained" })
          .scrollIntoViewIfNeeded();
        if (proof) {
          await page.screenshot({ path: path.join(proof, "04-removed-pack-history.png") });
        }
        expect(
          await page.evaluate(
            () =>
              JSON.parse(localStorage.getItem("openclaw.control.lobsterdex.v1") ?? "{}")[
                "reef/reef/coral"
              ].firstSeenAt,
          ),
        ).toBe(firstSeenAt);
        expect(artworkRequests.length).toBeGreaterThanOrEqual(4);
        expect(
          artworkRequests.every(
            (request) =>
              request.authorized &&
              request.path.startsWith(`${mountPath}/__openclaw__/plugin-lobster-art/`),
          ),
        ).toBe(true);
        expect(errors).toEqual([]);
      },
    );
  });
});
