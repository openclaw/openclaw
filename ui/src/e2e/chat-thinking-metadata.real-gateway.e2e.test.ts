import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import type { ModelCatalogResult, SessionsListResult } from "../api/types.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const sessionKey = "agent:main:thinking-status";
let instance: OpenClawTestInstance;
const suite = createControlUiE2eSuite({
  name: "Model picker public thinking metadata",
  startServerBeforeBrowser: true,
  async startServer() {
    instance = await createOpenClawTestInstance({
      name: "thinking-metadata",
      env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined },
      config: {
        gateway: { controlUi: { enabled: true } },
        cron: { enabled: false },
        agents: {
          ownership: "explicit",
          defaults: {
            model: "thinking-fixture/no-effort",
            modelPolicy: { allow: ["thinking-fixture/*"] },
          },
          entries: { main: { identity: { name: "Thinking controls" } } },
        },
        models: {
          catalogRefresh: { enabled: false },
          providers: {
            "thinking-fixture": {
              api: "openai-completions",
              apiKey: "synthetic-unused-key",
              baseUrl: "http://127.0.0.1:9/v1",
              models: [
                {
                  id: "no-effort",
                  name: "No effort",
                  reasoning: true,
                  thinkingLevelMap: {
                    off: null,
                    minimal: null,
                    low: null,
                    medium: null,
                    high: null,
                    xhigh: null,
                    max: null,
                  },
                },
              ],
            },
          },
        },
        plugins: { allow: [] },
      },
    });
    try {
      await instance.startGateway();
      return { baseUrl: `http://127.0.0.1:${instance.port}/`, close: () => instance.cleanup() };
    } catch (error) {
      await instance.cleanup();
      throw error;
    }
  },
});

suite.define(() => {
  it("reports no thinking choices without advertising a default or changing the session", async () => {
    const commands: unknown[] = [];
    const call = async (method: string, params: Record<string, unknown>) => {
      const result = await instance.cli([
        "gateway",
        "call",
        method,
        "--json",
        "--params",
        JSON.stringify(params),
      ]);
      commands.push({ method, params, ...result });
      expect(result.code, result.stderr).toBe(0);
      return result.stdout;
    };
    const browserMethods: string[] = [];
    let text: string | null | undefined;
    let stage = "create session";
    let lastPageText: string | null | undefined;
    const browserErrors: string[] = [];
    let tableOptions: Array<string | null> | undefined;
    let draftModel: string | null | undefined;
    try {
      await call("sessions.create", {
        key: sessionKey,
        agentId: "main",
        label: "Thinking status",
        model: "thinking-fixture/no-effort",
      });
      const catalog: ModelCatalogResult = JSON.parse(
        await call("models.list", { agentId: "main", view: "configured" }),
      );
      const model = catalog.models.find((entry) => entry.id === "no-effort");
      expect(model?.thinkingLevels).toEqual([]);
      expect(model?.thinkingDefault).toBeUndefined();

      const before: SessionsListResult = JSON.parse(
        await call("sessions.list", { agentId: "main", limit: 50 }),
      );
      const row = before.sessions.find((entry) => entry.key === sessionKey);
      expect(row?.thinkingLevels).toEqual([]);
      expect(row?.thinkingDefault).toBeUndefined();
      expect(before.defaults.thinkingLevels).toEqual([]);
      expect(before.defaults.thinkingDefault).toBeUndefined();

      const handoff = await instance.cli(["dashboard", "--json"]);
      expect(handoff.code, handoff.stderr).toBe(0);
      const { browserUrl }: { browserUrl: string } = JSON.parse(handoff.stdout);
      const url = new URL(browserUrl);
      url.pathname = "/chat/main/thinking-status";
      url.search = "?nav=collapsed";
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
          page.on("pageerror", (error) => browserErrors.push(error.message));
          try {
            stage = "open Chat";
            page.on("websocket", (socket) => {
              socket.on("framesent", ({ payload }) => {
                const frame: { type: string; method?: string } = JSON.parse(payload.toString());
                if (frame.type === "req" && frame.method) {
                  browserMethods.push(frame.method);
                }
              });
            });
            await page.goto(url.href);
            await waitForControlUiGatewayReady(page);
            const composer = page.getByRole("textbox", { name: "Chat composer", exact: true });
            await composer.waitFor({ state: "visible" });
            await composer.fill("/think");
            await composer.press("Tab");
            await expect.poll(() => composer.inputValue()).toBe("/think ");
            await composer.press("Enter");
            try {
              await expect
                .poll(
                  async () => {
                    text = await page.getByRole("log").textContent();
                    return text;
                  },
                  { timeout: 30_000 },
                )
                .toContain("Current thinking level: Unknown.");
              expect(text).toContain("Options: none.");
            } finally {
              await page.screenshot({ path: path.join(suite.artifactDir, "thinking-status.png") });
            }
            expect(await composer.inputValue()).toBe("");
            expect(await page.getByRole("slider").count()).toBe(0);

            stage = "open Sessions";
            await page.goto(new URL("/sessions", url).href);
            await waitForControlUiGatewayReady(page);
            const session = page
              .locator("tr[aria-controls]")
              .filter({ hasText: "Thinking status" });
            await session.waitFor({ state: "visible" });
            await session.press("Enter");
            const thinking = page.locator(".session-details-row select").first();
            await thinking.waitFor({ state: "visible" });
            tableOptions = await thinking
              .locator("option")
              .evaluateAll((options) => options.map((option) => option.getAttribute("value")));
            expect(tableOptions).toEqual([""]);
            await thinking.locator("..").screenshot({
              path: path.join(suite.artifactDir, "session-thinking.png"),
            });

            stage = "open New session";
            await page.getByRole("link", { name: "New session", exact: true }).first().click();
            await page.waitForURL((current) => current.pathname === "/new");
            await waitForControlUiGatewayReady(page);
            const modelControl = page.locator("[data-chat-model-select='true']");
            await expect.poll(() => modelControl.textContent()).toContain("No effort");
            draftModel = await modelControl.textContent();
            expect(await page.locator("[data-chat-thinking-slider='true']").count()).toBe(0);
            await page.locator(".chat-controls__model-settings").screenshot({
              path: path.join(suite.artifactDir, "draft-thinking.png"),
            });
          } finally {
            lastPageText = await page.locator("body").textContent();
            await page.screenshot({ path: path.join(suite.artifactDir, "last-page.png") });
          }
        },
      );
      stage = "session readback";
      const after: SessionsListResult = JSON.parse(
        await call("sessions.list", { agentId: "main", limit: 50 }),
      );
      const afterRow = after.sessions.find((entry) => entry.key === sessionKey);
      expect(afterRow?.model).toBe(row?.model);
      expect(afterRow?.modelProvider).toBe(row?.modelProvider);
      expect(afterRow?.thinkingLevel).toBe(row?.thinkingLevel);
      expect(afterRow?.thinkingDefault).toBeUndefined();
      expect(browserMethods).not.toContain("chat.send");
      expect(browserMethods).not.toContain("sessions.patch");
    } finally {
      const serialized = JSON.stringify(
        {
          commands,
          browserMethods,
          browserErrors,
          stage,
          lastPageText,
          text,
          tableOptions,
          draftModel,
        },
        null,
        2,
      )
        .replaceAll(instance.gatewayToken, "[synthetic token]")
        .replaceAll(instance.hookToken, "[synthetic token]")
        .replaceAll(instance.homeDir, "[fixture home]")
        .replaceAll(instance.stateDir, "[fixture state]")
        .replaceAll(process.cwd(), "[source checkout]");
      await fs.writeFile(path.join(suite.artifactDir, "thinking-status.json"), serialized);
    }
  }, 120_000);
});
