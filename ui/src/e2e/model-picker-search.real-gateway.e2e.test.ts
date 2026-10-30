import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { listKnownProviderAuthEnvVarNamesAsync } from "../../../src/secrets/provider-env-vars.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { createRequireRecord } from "../../../test/helpers/record.js";
import type { ConfigSnapshot, CronJob } from "../api/types.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
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
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        VITEST: undefined,
        NODE_ENV: undefined,
        // This fixture talks only to its owned loopback Gateway and synthetic provider.
        NO_PROXY: [process.env.NO_PROXY, "127.0.0.1", "localhost", "::1"].filter(Boolean).join(","),
        no_proxy: [process.env.no_proxy, "127.0.0.1", "localhost", "::1"].filter(Boolean).join(","),
      },
      config: {
        update: { checkOnStart: false },
        logging: { file: "${OPENCLAW_STATE_DIR}/model-picker-proof.log" },
        gateway: { controlUi: { enabled: true } },
        plugins: { enabled: false },
        cron: { enabled: false },
        agents: {
          defaults: {
            model: "fixture/anchor",
            modelPolicy: { allow: ["fixture/*"] },
          },
        },
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
      // Keep broker/proxy attribution, but no ambient provider account may enter this fixture.
      for (const name of await listKnownProviderAuthEnvVarNamesAsync({
        env: owner.env,
        config: {},
      })) {
        delete owner.env[name];
      }
      await owner.state.writeAuthProfiles({
        version: 1,
        profiles: {
          "fixture:automation-proof": {
            type: "api_key",
            provider: "fixture",
            key: "synthetic-automation-proof-key",
          },
        },
      });
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

  it("previews automation impact through the real Gateway before cancel or config-only acceptance", async () => {
    const gateway = client;
    if (!gateway) {
      throw new Error("Gateway fixture client is not connected");
    }
    expect(await gateway.request("cron.status", {})).toMatchObject({ enabled: false });
    const initial = await gateway.request<ConfigSnapshot>("config.get", {});
    await gateway.request("config.patch", {
      baseHash: initial.hash,
      raw: JSON.stringify({
        agents: {
          defaults: {
            model: "fixture/anchor",
            modelPolicy: { allow: ["fixture/*", "alternate-fixture/*"] },
          },
        },
        models: {
          providers: {
            "alternate-fixture": {
              api: "openai-completions",
              apiKey: "synthetic-alternate-key",
              baseUrl: "http://127.0.0.1:9/v1",
              models: [{ id: "next", name: "Alternate model" }],
            },
          },
        },
      }),
      response: "summary",
    });
    await gateway.request("models.list", { agentId: "main", view: "configured" });
    for (const [name, model] of [
      ["Daily briefing", undefined],
      ["Pinned weekly report", "fixture/anchor"],
    ] as const) {
      await gateway.request("cron.add", {
        name,
        agentId: "main",
        enabled: true,
        schedule: { kind: "every", everyMs: 86_400_000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message: "Synthetic proof; do not execute.",
          ...(model ? { model } : {}),
        },
        delivery: { mode: "none" },
      });
    }
    const list = async () =>
      (
        await gateway.request<{ jobs: CronJob[] }>("cron.list", {
          includeDisabled: true,
          includeDeliveryPreviews: false,
        })
      ).jobs;
    const beforeJobs = await list();
    const beforeConfig = await gateway.request<ConfigSnapshot>("config.get", {});
    const handoff = await owner.cli(["dashboard", "--json"]);
    expect(handoff.code, handoff.stderr).toBe(0);
    const browserUrl = record(JSON.parse(handoff.stdout)).browserUrl;
    if (typeof browserUrl !== "string") {
      throw new Error("Dashboard browser handoff missing");
    }
    const url = new URL("settings/model-providers", browserUrl);
    url.hash = new URL(browserUrl).hash;
    const requests: Array<{ method: string; params: unknown }> = [];
    const impactRequests = new Set<string>();
    const previews: unknown[] = [];
    await suite.withPage(
      { serviceWorkers: "block", locale: "en-US", viewport: { width: 1280, height: 1000 } },
      async ({ page }) => {
        page.on("websocket", (socket) => {
          socket.on("framesent", ({ payload }) => {
            const frame = record(JSON.parse(payload.toString()));
            if (frame.type !== "req" || typeof frame.method !== "string") {
              return;
            }
            if (frame.method === "cron.modelImpact" && typeof frame.id === "string") {
              impactRequests.add(frame.id);
            }
            if (
              [
                "cron.modelImpact",
                "config.patch",
                "config.set",
                "cron.add",
                "cron.update",
                "cron.run",
                "cron.remove",
              ].includes(frame.method)
            ) {
              requests.push({ method: frame.method, params: frame.params });
            }
          });
          socket.on("framereceived", ({ payload }) => {
            const frame = record(JSON.parse(payload.toString()));
            if (
              frame.type === "res" &&
              typeof frame.id === "string" &&
              impactRequests.has(frame.id) &&
              frame.ok === true
            ) {
              previews.push(frame.payload);
            }
          });
        });
        await page.goto(url.toString());
        await waitForControlUiGatewayReady(page);
        const picker = page.locator(".model-providers__defaults .model-picker").first();
        const trigger = picker.locator(".picker-select__trigger");
        await expect.poll(() => trigger.textContent()).toContain("anchor");
        const capture = async (name: string, surface = picker) => {
          const frame = await takeControlUiScreenshotFrame(page, surface, [surface], {
            animations: "disabled",
          });
          await writeFile(path.join(suite.artifactDir, name), frame.png);
        };
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          await capture("real-before.png");
        }
        const choose = async () => {
          await trigger.click();
          await picker.locator('[data-value="alternate-fixture/next"]').click();
        };
        await choose();
        const modal = page
          .locator("openclaw-modal-dialog")
          .filter({ hasText: "Review automation impact" });
        await modal.getByRole("button", { name: "Keep current model", exact: true }).waitFor();
        expect(requests).toEqual([
          { method: "cron.modelImpact", params: { model: "alternate-fixture/next" } },
        ]);
        expect(previews[0]).toMatchObject({
          model: "alternate-fixture/next",
          jobs: expect.arrayContaining([
            expect.objectContaining({
              name: "Daily briefing",
              enabled: true,
              changed: true,
              status: "blocked",
              issues: expect.arrayContaining([
                expect.objectContaining({ code: "recorded-provider-incompatible" }),
              ]),
            }),
            expect.objectContaining({ name: "Pinned weekly report", changed: false }),
          ]),
        });
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          await capture("real-after.png", modal.locator(".exec-approval-card"));
        }
        await modal.getByRole("button", { name: "Keep current model", exact: true }).click();
        await expect.poll(() => trigger.isEnabled()).toBe(true);
        expect((await gateway.request<ConfigSnapshot>("config.get", {})).hash).toBe(
          beforeConfig.hash,
        );
        expect(await list()).toEqual(beforeJobs);
        await choose();
        await modal.getByRole("button", { name: "Change model anyway", exact: true }).click();
        await expect.poll(() => trigger.isEnabled()).toBe(true);
        await expect.poll(() => trigger.textContent()).toContain("Alternate model");
        const after = await gateway.request<ConfigSnapshot>("config.get", {});
        const expected = structuredClone(record(beforeConfig.sourceConfig ?? beforeConfig.config));
        record(record(expected.agents).defaults).model = "alternate-fixture/next";
        const actual = structuredClone(record(after.sourceConfig ?? after.config));
        delete expected.meta;
        delete actual.meta;
        expect(actual).toEqual(expected);
        expect(await list()).toEqual(beforeJobs);
        expect(await gateway.request("cron.status", {})).toMatchObject({ enabled: false });
        expect(requests.map(({ method }) => method)).toEqual([
          "cron.modelImpact",
          "cron.modelImpact",
          "config.patch",
        ]);
        await writeFile(
          path.join(suite.artifactDir, "real-proof.json"),
          JSON.stringify(
            {
              gateway: "real isolated Gateway",
              websocketInterception: false,
              schedulerEnabled: false,
              cancellationPreservedConfig: true,
              jobsUnchanged: true,
              acceptedConfigOnly: true,
              methods: requests.map(({ method }) => method),
              previews,
            },
            null,
            2,
          ),
        );
      },
    );
  }, 120_000);
});
