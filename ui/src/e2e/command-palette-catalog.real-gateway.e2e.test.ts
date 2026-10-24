import { once } from "node:events";
import http from "node:http";
import { expect, it } from "vitest";
import type { GatewayClient } from "../../../src/gateway/client.ts";
import { acquireGatewayTestClient } from "../../../test/helpers/gateway-client.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { createRequireRecord } from "../../../test/helpers/record.js";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { pickerValue } from "../test-helpers/select-picker-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const requireRecord = createRequireRecord("record", "expected-object-value");
let instance: OpenClawTestInstance;
let readback: GatewayClient;
let providerMode: "ready" | "failed" | "empty" = "ready";
let providerModel = "refresh-fixture:latest";
const providerTraffic: Array<{ path: string; status: number }> = [];
async function dashboardUrl() {
  const handoff = await instance.cli(["dashboard", "--json"]);
  expect(handoff.code, handoff.stderr).toBe(0);
  const url = requireRecord(JSON.parse(handoff.stdout)).browserUrl;
  if (typeof url !== "string") {
    throw new Error("Dashboard did not return a browser handoff");
  }
  return url;
}
const refreshCatalog = async (agentId = "main") =>
  requireRecord(
    await readback.request("models.list", { agentId, view: "configured", refresh: true }),
  );
const suite = createControlUiE2eSuite({
  name: "Control UI catalog publication with a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const provider = http.createServer((req, res) => {
      const status = providerMode === "failed" ? 503 : 200;
      providerTraffic.push({ path: req.url ?? "", status });
      const body =
        status === 503
          ? { error: "private upstream error body" }
          : req.url === "/api/tags"
            ? { models: providerMode === "empty" ? [] : [{ name: providerModel }] }
            : {
                capabilities: ["completion", "tools"],
                model_info: { "llama.context_length": 8192 },
              };
      req.resume();
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    const closeProvider = async () => {
      provider.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        provider.close((error) => (error ? reject(error) : resolve()));
      });
    };
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    const address = provider.address();
    if (!address || typeof address === "string") {
      throw new Error("Ollama fixture did not bind a TCP port");
    }
    try {
      instance = await createOpenClawTestInstance({
        name: "palette-catalog-publication",
        env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined, OLLAMA_API_KEY: "" },
        config: {
          gateway: { controlUi: { enabled: true } },
          cron: { enabled: false },
          agents: {
            ownership: "explicit",
            defaults: {
              model: "fixture/anchor",
              modelPolicy: { allow: ["fixture/*", "ollama/*"] },
            },
            entries: {
              main: { identity: { name: "Main fixture" } },
              reviewer: { identity: { name: "Reviewer fixture" } },
            },
          },
          models: {
            catalogRefresh: { enabled: false },
            providers: {
              fixture: {
                api: "openai-completions",
                apiKey: "synthetic-catalog-key",
                baseUrl: "http://127.0.0.1:9/v1",
                models: [{ id: "anchor", name: "Anchor" }],
              },
              ollama: { api: "ollama", baseUrl: `http://127.0.0.1:${address.port}`, models: [] },
            },
          },
          plugins: { allow: ["ollama"], entries: { ollama: { enabled: true } } },
        },
      });
      try {
        await instance.startGateway();
        readback = await acquireGatewayTestClient(
          {
            url: instance.url,
            token: instance.gatewayToken,
            env: instance.env,
            clientName: "cli",
            mode: "cli",
            scopes: ["operator.read"],
            deviceIdentity: null,
            deviceAuthScope: instance.url,
            sharedStateMode: "read-only",
            requestTimeoutMs: 30_000,
          },
          {
            timeoutMs: 10_000,
            timeoutMessage: "Catalog readback client did not connect",
            closeMessage: "Catalog readback client closed during connect",
          },
        );
        return {
          baseUrl: `http://127.0.0.1:${instance.port}/`,
          close: () =>
            runQaGatewayFixture(
              () => readback.stopAndWait(),
              () => instance.cleanup(),
              closeProvider,
            ),
        };
      } catch (error) {
        await instance.cleanup();
        throw error;
      }
    } catch (error) {
      return await runQaGatewayFixture(async (): Promise<never> => {
        throw error;
      }, closeProvider);
    }
  },
});

suite.define(() => {
  it("opens Settings pickers from publication and acquires only on Refresh or Retry", async () => {
    const requests: Array<{ id: string; params: Record<string, unknown> }> = [];
    const replies = new Map<string, Record<string, unknown>>();
    const acquisitions = () => providerTraffic.filter((entry) => entry.path === "/api/tags").length;
    const browserUrl = await dashboardUrl();
    const url = new URL("/settings/model-providers", browserUrl);
    url.hash = new URL(browserUrl).hash;
    try {
      // The provider counter spans both owners; settle each before measuring page-owned requests.
      for (const agentId of ["main", "reviewer"]) {
        expect((await refreshCatalog(agentId)).providerOutcomes).toContainEqual({
          provider: "ollama",
          status: "ready",
        });
      }
      await suite.withPage(
        { serviceWorkers: "block", locale: "en-US", viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
          page.on("websocket", (socket) => {
            socket.on("framesent", ({ payload }) => {
              const frame = requireRecord(JSON.parse(payload.toString()));
              if (
                frame.type === "req" &&
                frame.method === "models.list" &&
                typeof frame.id === "string"
              ) {
                requests.push({ id: frame.id, params: requireRecord(frame.params) });
              }
            });
            socket.on("framereceived", ({ payload }) => {
              const frame = requireRecord(JSON.parse(payload.toString()));
              if (
                frame.type === "res" &&
                typeof frame.id === "string" &&
                requests.some(({ id }) => id === frame.id)
              ) {
                replies.set(frame.id, frame);
              }
            });
          });
          const initialAcquisitions = acquisitions();
          await page.goto(url.href);
          await waitForControlUiGatewayReady(page);
          const settings = page.locator("openclaw-model-providers-page");
          const refreshButton = settings.locator(".model-providers__refresh-button");
          const catalogProgress = settings.locator(
            '.model-providers__catalog-progress[role="status"]',
          );
          const pickers = settings.locator(".model-providers__defaults openclaw-select-picker");
          const primary = pickers.first();
          const trigger = primary.locator(".picker-select__trigger");
          await trigger.waitFor({ state: "visible" });
          await expect.poll(() => pickerValue(primary)).toBe("fixture/anchor");
          expect(acquisitions()).toBe(initialAcquisitions);

          const catalogRefresh = async (action: () => Promise<void>) => {
            // Publication can add passive reads; this action owns the explicit acquisition.
            const refreshRequests = () => requests.filter(({ params }) => params.refresh === true);
            const before = refreshRequests().length;
            await action();
            await expect.poll(() => refreshRequests().length).toBe(before + 1);
            const request = refreshRequests().at(-1)!;
            await expect.poll(() => replies.has(request.id)).toBe(true);
            expect(request.params).toEqual({
              view: "configured",
              agentId: "main",
              refresh: true,
            });
            expect(replies.get(request.id)?.ok).toBe(true);
            return requireRecord(replies.get(request.id)?.payload);
          };
          const catalogIdle = async () =>
            (await refreshButton.isEnabled()) &&
            (await catalogProgress.count()) === 0 &&
            requests.every(({ id }) => replies.has(id));
          const waitForCatalogIdle = async () => {
            await expect
              .poll(async () => {
                const requestCount = requests.length;
                if (!(await catalogIdle())) {
                  return false;
                }
                await page.evaluate(() => {
                  return new Promise(requestAnimationFrame);
                });
                return requests.length === requestCount && (await catalogIdle());
              })
              .toBe(true);
          };
          const open = async () => {
            await waitForCatalogIdle();
            const requestsBeforeOpen = requests.length;
            const acquisitionsBeforeOpen = acquisitions();
            if ((await trigger.getAttribute("aria-expanded")) === "true") {
              await trigger.click();
            }
            await trigger.click();
            await primary.getByRole("listbox").waitFor({ state: "visible" });
            expect(requests).toHaveLength(requestsBeforeOpen);
            expect(acquisitions()).toBe(acquisitionsBeforeOpen);
          };
          await open();
          await primary
            .locator('[role="option"][data-value="ollama/refresh-fixture:latest"]')
            .waitFor({ state: "visible" });
          expect(acquisitions()).toBe(initialAcquisitions);
          expect(await pickerValue(primary)).toBe("fixture/anchor");

          providerModel = "published-fixture:latest";
          const publicationStart = requests.length;
          expect((await refreshCatalog()).providerOutcomes).toContainEqual({
            provider: "ollama",
            status: "ready",
          });
          expect(acquisitions()).toBe(initialAcquisitions + 1);
          await expect
            .poll(() =>
              requests
                .slice(publicationStart)
                .filter(({ params }) => params.refresh === undefined)
                .map(({ id }) => replies.get(id)?.payload),
            )
            .toContainEqual(
              expect.objectContaining({
                models: expect.arrayContaining([
                  expect.objectContaining({
                    provider: "ollama",
                    id: "published-fixture:latest",
                  }),
                ]),
              }),
            );
          await primary
            .locator('[role="option"][data-value="ollama/published-fixture:latest"]')
            .waitFor({ state: "visible" });
          expect(
            await primary
              .locator('[role="option"][data-value="ollama/refresh-fixture:latest"]')
              .count(),
          ).toBe(0);
          await open();
          expect(acquisitions()).toBe(initialAcquisitions + 1);
          expect(await pickerValue(primary)).toBe("fixture/anchor");

          await trigger.click();
          await catalogRefresh(() =>
            settings.getByRole("button", { name: "Refresh", exact: true }).click(),
          );
          expect(acquisitions()).toBe(initialAcquisitions + 2);
          await open();
          expect(acquisitions()).toBe(initialAcquisitions + 2);
          expect(await pickerValue(primary)).toBe("fixture/anchor");

          // A new page starts its own request lifetime and keeps the published rows on failure.
          await page.reload();
          await waitForControlUiGatewayReady(page);
          await trigger.waitFor({ state: "visible" });
          await expect.poll(() => pickerValue(primary)).toBe("fixture/anchor");
          providerMode = "failed";
          const failed = await catalogRefresh(() =>
            settings.getByRole("button", { name: "Refresh", exact: true }).click(),
          );
          const providerStatus = settings.locator(
            '[data-provider-id="ollama"] .model-providers__head',
          );
          await expect.poll(() => providerStatus.textContent()).toContain("Models unavailable");
          const retry = settings
            .locator('.model-providers__catalog-progress[role="alert"]')
            .getByRole("button", { name: "Retry", exact: true });
          await retry.waitFor({ state: "visible" });
          expect(await settings.textContent()).not.toContain("Open Models to try again.");
          expect(acquisitions()).toBe(initialAcquisitions + 3);
          await open();
          await primary
            .locator('[role="option"][data-value="ollama/published-fixture:latest"]')
            .waitFor({ state: "visible" });
          expect(failed.refreshFailed).toBe(true);
          expect(failed.providerOutcomes).toContainEqual({
            provider: "ollama",
            status: "unavailable",
          });
          expect(await pickerValue(primary)).toBe("fixture/anchor");

          providerMode = "ready";
          providerModel = "recovered-fixture:latest";
          await catalogRefresh(() => retry.click());
          await retry.waitFor({ state: "hidden" });
          await expect.poll(() => providerStatus.textContent()).not.toContain("Models unavailable");
          await open();
          await primary
            .locator('[role="option"][data-value="ollama/recovered-fixture:latest"]')
            .waitFor({ state: "visible" });
          expect(acquisitions()).toBe(initialAcquisitions + 4);
          expect(await pickerValue(primary)).toBe("fixture/anchor");
        },
      );
    } finally {
      providerMode = "ready";
      providerModel = "refresh-fixture:latest";
    }
  }, 120_000);

  it("shows acquisition failures in Automations while keeping model search quiet and usable", async () => {
    const browserUrl = await dashboardUrl();
    const warning = "Some models could not be refreshed. Open Models to try again.";
    try {
      await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
        await page.goto(browserUrl);
        await waitForControlUiGatewayReady(page);
        providerMode = "ready";
        expect((await refreshCatalog()).providerOutcomes).toContainEqual({
          provider: "ollama",
          status: "ready",
        });
        await page.goto(new URL("/automations", browserUrl).href);
        await waitForControlUiGatewayReady(page);
        const automations = page.locator("openclaw-cron-page");
        await automations.waitFor({ state: "visible" });

        providerMode = "failed";
        const failed = await refreshCatalog();
        expect(failed.providerOutcomes).toContainEqual({
          provider: "ollama",
          status: "unavailable",
        });
        expect(failed.models).toContainEqual(
          expect.objectContaining({ provider: "ollama", id: "refresh-fixture:latest" }),
        );
        expect(JSON.stringify(failed)).not.toContain("private upstream error body");
        await automations.getByText(warning, { exact: true }).waitFor({ state: "visible" });
        await page.keyboard.press("ControlOrMeta+K");
        await page.locator(".cmd-palette__input").fill("refresh-fixture");
        const model = page.getByRole("option", {
          name: "refresh-fixture:latest ollama",
          exact: true,
        });
        await model.waitFor({ state: "visible" });
        expect(await model.count()).toBe(1);
        expect(await page.locator(".cmd-palette").getByText(warning, { exact: true }).count()).toBe(
          0,
        );

        providerMode = "empty";
        expect((await refreshCatalog()).providerOutcomes).toContainEqual({
          provider: "ollama",
          status: "ready",
        });
        await model.waitFor({ state: "hidden" });
        await automations.getByText(warning, { exact: true }).waitFor({ state: "hidden" });
        await page
          .locator(".cmd-palette")
          .getByText(warning, { exact: true })
          .waitFor({ state: "hidden" });
      });
    } finally {
      providerMode = "ready";
    }
  }, 120_000);
});
