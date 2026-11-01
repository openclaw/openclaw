import { expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { createRequireRecord } from "../../../test/helpers/record.js";
import type { ConfigSnapshot } from "../api/types.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { pickerValue } from "../test-helpers/select-picker-e2e.ts";
import { connectChatGateway } from "./chat-real-gateway.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const record = createRequireRecord("record", "expected-object-value");
const models = [
  "anchor",
  "aurora-large",
  "aurora-small",
  "birch",
  "cedar",
  "delta",
  "elm",
  "forest",
  "granite",
].map((id) => ({ id, name: id }));
let owner: OpenClawTestInstance;
let client: Awaited<ReturnType<typeof connectChatGateway>> | undefined;
const suite = createControlUiE2eSuite({
  name: "Model picker search with a real Gateway",
  startServerBeforeBrowser: true,
  resources: {
    async run(signal) {
      client = await connectChatGateway(owner, signal);
    },
    async close() {
      await client?.stopAndWait();
    },
  },
  async startServer() {
    owner = await createOpenClawTestInstance({
      name: "model-picker-search",
      env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined, NODE_ENV: undefined },
      config: {
        gateway: { controlUi: { enabled: true } },
        plugins: { enabled: false },
        cron: { enabled: false },
        agents: { defaults: { model: "fixture/anchor", modelPolicy: { allow: ["fixture/*"] } } },
        models: {
          catalogRefresh: { enabled: false },
          providers: {
            fixture: {
              api: "openai-completions",
              apiKey: "synthetic-catalog-key",
              baseUrl: "http://127.0.0.1:9/v1",
              models: models.slice(0, 1),
            },
          },
        },
      },
    });
    try {
      await owner.startGateway();
      return {
        baseUrl: `http://127.0.0.1:${owner.port}/`,
        close: () => owner.cleanup(),
      };
    } catch (error) {
      await owner.cleanup();
      throw error;
    }
  },
});

suite.define(() => {
  it("keeps an unsaved search current through real Gateway catalog replacement without writing the draft", async () => {
    const gateway = client;
    if (!gateway) {
      throw new Error("Gateway fixture client is not connected");
    }
    const mutations: string[] = [];
    const cli = async (args: string[]) => {
      const result = await owner.cli(args);
      expect(result.code, result.stderr).toBe(0);
      return result.stdout;
    };
    const publish = async (nextModels: typeof models) => {
      const current = await gateway.request<ConfigSnapshot>("config.get", {});
      expect(typeof current.hash).toBe("string");
      await gateway.request("config.patch", {
        raw: JSON.stringify({ models: { providers: { fixture: { models: nextModels } } } }),
        baseHash: current.hash,
        replacePaths: ["models.providers.fixture.models"],
        response: "summary",
      });
    };
    const handoff = record(JSON.parse(await cli(["dashboard", "--json"])));
    if (typeof handoff.browserUrl !== "string") {
      throw new Error("Dashboard browser handoff missing");
    }
    const issued = new URL(handoff.browserUrl);
    const url = new URL("cron", issued);
    url.hash = issued.hash;
    await suite.withPage(
      { serviceWorkers: "block", locale: "en-US", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        page.on("websocket", (socket) => {
          socket.on("framesent", ({ payload }) => {
            const frame = record(JSON.parse(payload.toString()));
            if (
              frame.type === "req" &&
              typeof frame.id === "string" &&
              typeof frame.method === "string" &&
              [
                "config.patch",
                "config.set",
                "cron.add",
                "cron.update",
                "cron.run",
                "cron.scratch.set",
                "sessions.patch",
              ].includes(frame.method)
            ) {
              mutations.push(frame.method);
            }
          });
        });
        const press = (key: string) => page.keyboard.press(key);
        await page.goto(url.toString());
        await waitForControlUiGatewayReady(page);
        await page.locator('[data-test-id="cron-new-task"]').click();
        const picker = page.locator("openclaw-select-picker:has(#cron-payload-model-picker)");
        const trigger = picker.locator(".picker-select__trigger");
        await trigger.click();
        await expect.poll(() => picker.locator('[data-value="fixture/anchor"]').count()).toBe(1);
        await picker.getByRole("listbox").waitFor({ state: "visible" });
        await trigger.click();
        await publish(models);
        await trigger.click();
        await expect
          .poll(() => picker.locator('[data-value="fixture/aurora-large"]').count())
          .toBe(1);
        await trigger.click();
        await page.locator("#cron-name").fill("Keep this draft");
        await page.locator("#cron-payload-text").fill("Do not submit this automation");
        const writesBeforeSearch = mutations.length;
        await trigger.focus();
        await press("ArrowDown");
        const search = picker.locator(".picker-select__search");
        await picker.locator('[data-value="__openclaw_custom_model__"]').click();
        await page.locator("#cron-payload-model").fill("fixture/not-in-catalog");
        expect(await pickerValue(picker)).toBe("fixture/not-in-catalog");

        await trigger.click();
        await picker.locator(".header-search__toggle").click();
        await search.fill("granite");
        expect(await picker.locator('[data-value="fixture/granite"]').count()).toBe(1);
        await publish(models.filter((model) => model.id !== "granite"));
        await expect.poll(() => picker.locator('[data-value="fixture/granite"]').count()).toBe(0);
        expect(await search.inputValue()).toBe("granite");
        await press("Enter");
        expect(await trigger.getAttribute("aria-label")).toBe("Model: fixture/not-in-catalog");
        await press("Escape");
        expect(await page.locator("#cron-name").inputValue()).toBe("Keep this draft");
        expect(await page.locator("#cron-payload-text").inputValue()).toBe(
          "Do not submit this automation",
        );
        expect(mutations).toHaveLength(writesBeforeSearch);
        expect(JSON.parse(await cli(["config", "get", "agents.defaults.model", "--json"]))).toBe(
          "fixture/anchor",
        );
      },
    );
  }, 120_000);
});
