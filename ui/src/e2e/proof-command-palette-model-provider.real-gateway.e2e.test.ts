import path from "node:path";
import { expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { createRequireRecord } from "../../../test/helpers/record.js";
import {
  waitForControlUiGatewayReady,
  waitForControlUiInitialRoster,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const captureEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const requireRecord = createRequireRecord("record", "expected-object-value");
const fixtureModels = [
  { id: "anchor", name: "Anchor" },
  { id: "palette-route-check", name: "Palette route check" },
];
let instance: OpenClawTestInstance;

const suite = createControlUiE2eSuite({
  name: "command palette model provider navigation with a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    instance = await createOpenClawTestInstance({
      name: "palette-model-provider-route",
      env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined },
      config: {
        gateway: { controlUi: { enabled: true } },
        cron: { enabled: false },
        agents: {
          ownership: "explicit",
          defaults: {
            model: "fixture/anchor",
            modelPolicy: { allow: ["fixture/*"] },
          },
          entries: { main: { identity: { name: "Main fixture" } } },
        },
        models: {
          catalogRefresh: { enabled: false },
          providers: {
            fixture: {
              api: "openai-completions",
              apiKey: "synthetic-catalog-key",
              baseUrl: "http://127.0.0.1:9/v1",
              models: fixtureModels,
            },
          },
        },
      },
    });
    try {
      await instance.startGateway();
      return {
        baseUrl: `http://127.0.0.1:${instance.port}/`,
        close: () => runQaGatewayFixture(() => instance.cleanup()),
      };
    } catch (error) {
      await instance.cleanup();
      throw error;
    }
  },
});

suite.define(() => {
  it("passes the selected provider to Models and keeps generic navigation unfiltered", async () => {
    const handoff = await instance.cli(["dashboard", "--json"]);
    expect(handoff.code, handoff.stderr).toBe(0);
    const browserUrl = requireRecord(JSON.parse(handoff.stdout)).browserUrl;
    if (typeof browserUrl !== "string") {
      throw new Error("Dashboard did not return a browser handoff");
    }

    const frames: Array<Record<string, unknown>> = [];
    await suite.withPage(
      {
        serviceWorkers: "block",
        locale: "en-US",
        viewport: { width: 1440, height: 1000 },
      },
      async ({ page }) => {
        await page.routeWebSocket(`ws://127.0.0.1:${instance.port}/**`, (socket) => {
          const server = socket.connectToServer();
          socket.onMessage((message) => {
            const frame = requireRecord(JSON.parse(message.toString()));
            if (frame.type === "req" && frame.method !== "connect") {
              frames.push({ direction: "sent", method: frame.method });
            }
            server.send(message);
          });
          server.onMessage((message) => {
            const frame = requireRecord(JSON.parse(message.toString()));
            if (frame.type === "res" && typeof frame.id === "string") {
              frames.push({ direction: "received", ok: frame.ok });
            }
            socket.send(message);
          });
        });
        await page.goto(browserUrl);
        await waitForControlUiGatewayReady(page);
        await waitForControlUiInitialRoster(page);
        expect(new URL(page.url()).searchParams.has("provider")).toBe(false);
        await page.keyboard.press("ControlOrMeta+K");
        const input = page.locator(".cmd-palette__input");
        await input.fill("palette-route-check");
        const result = page.getByRole("option", {
          name: "Palette route check fixture",
          exact: true,
        });
        await result.waitFor({ state: "visible" });
        if (captureEnabled) {
          await page.locator(".cmd-palette").screenshot({
            path: path.join(suite.artifactDir, "model-provider-search.png"),
          });
        }
        await result.click();

        const settings = page.locator("openclaw-model-providers-page");
        await settings.waitFor({ state: "visible" });
        const providerSearch = settings.locator(".model-providers__search input");
        const selected = {
          url: page.url(),
          providerFilter: await providerSearch.inputValue(),
        };
        if (captureEnabled) {
          console.log("model-provider-selection-proof", JSON.stringify(selected));
          await settings.locator(".model-providers__search").screenshot({
            path: path.join(suite.artifactDir, "model-provider-filter.png"),
          });
          await page.screenshot({
            path: path.join(suite.artifactDir, "model-provider-selected.png"),
            clip: { x: 300, y: 0, width: 1140, height: 950 },
          });
        }
        expect(new URL(page.url()).pathname).toBe("/settings/model-providers");
        expect(new URL(page.url()).search).toBe("?provider=fixture");
        expect(selected.providerFilter).toBe("fixture");

        await page.goBack();
        await settings.waitFor({ state: "hidden" });
        await page.keyboard.press("ControlOrMeta+K");
        await input.waitFor({ state: "visible" });
        await input.fill("Models");
        const genericModels = page.getByRole("option", { name: /^Models/ });
        await genericModels.waitFor({ state: "visible" });
        await genericModels.click();
        await settings.waitFor({ state: "visible" });
        const generic = {
          url: page.url(),
          providerFilter: await providerSearch.inputValue(),
          configPatches: frames.filter(
            (frame) => frame.direction === "sent" && frame.method === "config.patch",
          ).length,
        };
        if (captureEnabled) {
          console.log("model-provider-generic-proof", JSON.stringify(generic));
          await page.screenshot({
            path: path.join(suite.artifactDir, "model-provider-generic.png"),
            clip: { x: 300, y: 0, width: 1140, height: 950 },
          });
        }
        expect(new URL(page.url()).pathname).toBe("/settings/model-providers");
        expect(new URL(page.url()).search).toBe("");
        expect(generic.providerFilter).toBe("");
        expect(generic.configPatches).toBe(0);
      },
    );
  }, 120_000);
});
