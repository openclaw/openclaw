import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { OpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import type { ModelCatalogResult, SessionsListResult } from "../api/types.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { enterControlUiSession } from "../test-helpers/control-ui-session-entry.ts";
import {
  callGateway,
  createChatGatewayInstance,
  gatewayChatUrl,
} from "./chat-real-gateway.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const sessionKey = "agent:main:thinking-status";
const harnessOnlyThinkingLevels = [{ id: "ultra", label: "ultra" }];
const pageOptions = {
  locale: "en-US",
  serviceWorkers: "block" as const,
  viewport: { width: 1280, height: 900 },
};

const call = (method: string, params: Record<string, unknown>) =>
  callGateway(instance, method, params);

async function enterChat(page: Page, url: URL) {
  await page.goto(url.href);
  await enterControlUiSession(page);
  await waitForControlUiGatewayReady(page);
  const composer = page.getByRole("textbox", { name: "Chat composer", exact: true });
  await composer.waitFor({ state: "visible" });
  return composer;
}

async function completeThinkCommand(composer: ReturnType<Page["getByRole"]>, page: Page) {
  await composer.fill("/think");
  await composer.press("Tab");
  await expect.poll(() => composer.inputValue()).toBe("/think ");
  await page.locator(".slash-menu[role='listbox']").waitFor({ state: "visible" });
  await composer.press("Escape");
}

async function expectSendEnabled(page: Page) {
  await expect
    .poll(() =>
      page
        .locator("openclaw-chat-pane.chat-pane-cache__pane--visible .chat-send-btn--send")
        .isEnabled(),
    )
    .toBe(true);
}

async function expectUnselectedUltraChoice(page: Page, currentValue: "" | "off") {
  const control = page.locator('[data-chat-thinking-select="true"]');
  expect(await control.getAttribute("data-chat-thinking-value")).toBe(currentValue);
  expect(await control.textContent()).toContain(currentValue === "off" ? "Off" : "Unknown");
  await control.click();
  const ultra = page.locator('[data-chat-thinking-option="ultra"]');
  await ultra.waitFor({ state: "visible" });
  expect(await page.locator("[data-chat-thinking-option]").count()).toBe(1);
  expect(await ultra.getAttribute("aria-pressed")).toBe("false");
  await control.click();
}

let instance: OpenClawTestInstance;
const suite = createControlUiE2eSuite({
  name: "Model picker public thinking metadata",
  startServerBeforeBrowser: true,
  async startServer() {
    instance = await createChatGatewayInstance({
      name: "thinking-metadata",
      provider: "thinking-fixture",
      identity: "Thinking controls",
      model: "no-effort",
      agents: { ownership: "explicit" },
      api: "openai-completions",
      apiKey: "synthetic-unused-key",
      baseUrl: "http://127.0.0.1:9/v1",
      models: [
        { id: "with-effort", name: "With effort", reasoning: true },
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
  it("retains saved Off through a real model change to a profile without native thinking choices", async () => {
    const key = "agent:main:thinking-saved-off";
    const frames: Array<{ direction: "sent" | "received"; frame: Record<string, unknown> }> = [];
    await call("sessions.create", {
      key,
      agentId: "main",
      label: "Saved thinking override",
      model: "with-effort",
    });
    await call("sessions.patch", { key, thinkingLevel: "off" });
    const before: SessionsListResult = JSON.parse(
      await call("sessions.list", { agentId: "main", limit: 50 }),
    );
    const beforeRow = before.sessions.find((row) => row.key === key);
    expect(beforeRow).toMatchObject({
      sessionId: expect.any(String),
      modelProvider: "thinking-fixture",
      model: "with-effort",
      thinkingLevel: "off",
    });
    expect(beforeRow?.thinkingLevels?.some((level) => level.id === "high")).toBe(true);
    const url = await gatewayChatUrl(instance, "thinking-saved-off");
    await suite.withPage(pageOptions, async ({ page }) => {
      page.on("websocket", (socket) => {
        const recordFrame = (direction: "sent" | "received", payload: string | Buffer) => {
          const frame: Record<string, unknown> = JSON.parse(payload.toString());
          // Authentication is outside this observation; retain all subsequent product frames.
          if (
            !(frame.type === "req" && frame.method === "connect") &&
            frame.event !== "connect.challenge" &&
            !(isRecord(frame.payload) && frame.payload.type === "hello-ok")
          ) {
            frames.push({ direction, frame });
          }
        };
        socket.on("framesent", ({ payload }) => recordFrame("sent", payload));
        socket.on("framereceived", ({ payload }) => recordFrame("received", payload));
      });
      const composer = await enterChat(page, url);
      await composer.fill("/model thinking-fixture/no-effort");
      await expectSendEnabled(page);
      await composer.press("Enter");
      await expect
        .poll(async () => {
          const listed: SessionsListResult = JSON.parse(
            await call("sessions.list", { agentId: "main", limit: 50 }),
          );
          return listed.sessions.find((row) => row.key === key);
        })
        .toMatchObject({
          modelProvider: "thinking-fixture",
          model: "no-effort",
          thinkingLevel: "off",
          thinkingLevels: harnessOnlyThinkingLevels,
        });
      await completeThinkCommand(composer, page);
      await composer.press("Enter");
      await expect
        .poll(() => page.getByRole("log").textContent())
        .toContain("Current thinking level: off.");
      expect(await page.getByRole("log").textContent()).toContain("Options: default, ultra.");
      expect(await page.locator('[data-chat-thinking-slider="true"]').count()).toBe(0);
      await expectUnselectedUltraChoice(page, "off");
      await page.screenshot({
        path: path.join(suite.artifactDir, "saved-off-empty-profile.png"),
      });
      await composer.fill("/think high");
      await composer.press("Enter");
      await expect
        .poll(() => page.getByRole("log").textContent())
        .toContain('Unsupported thinking level "high" for this model.');
      const after: SessionsListResult = JSON.parse(
        await call("sessions.list", { agentId: "main", limit: 50 }),
      );
      expect(after.sessions.find((row) => row.key === key)).toMatchObject({
        modelProvider: "thinking-fixture",
        model: "no-effort",
        thinkingLevel: "off",
        thinkingLevels: harnessOnlyThinkingLevels,
      });
      expect(after.sessions.find((row) => row.key === key)?.thinkingDefault).toBeUndefined();
      const requests = frames
        .filter(({ direction }) => direction === "sent")
        .map(({ frame }) => frame);
      expect(requests.some((frame) => frame.method === "chat.send")).toBe(false);
      expect(
        requests.filter((frame) => frame.method === "sessions.patch").map((frame) => frame.params),
      ).toEqual([
        {
          key,
          expectedSessionId: beforeRow?.sessionId,
          model: "thinking-fixture/no-effort",
        },
      ]);
      const changes = frames
        .filter(
          ({ frame }) =>
            frame.event === "sessions.changed" &&
            isRecord(frame.payload) &&
            frame.payload.sessionKey === key,
        )
        .map(({ frame }) => frame.payload)
        .filter(isRecord);
      expect(changes.length).toBeGreaterThan(0);
      for (const change of changes) {
        if (change.model !== undefined || change.modelProvider !== undefined) {
          expect(typeof change.model).toBe("string");
          expect(change.modelProvider).toBe("thinking-fixture");
        }
      }
    });
  }, 120_000);

  it("offers only harness Ultra without advertising a default or changing the session", async () => {
    const browserMethods: string[] = [];
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
    expect(model?.thinkingLevels).toEqual(harnessOnlyThinkingLevels);
    expect(model?.thinkingDefault).toBeUndefined();

    const before: SessionsListResult = JSON.parse(
      await call("sessions.list", { agentId: "main", limit: 50 }),
    );
    const row = before.sessions.find((entry) => entry.key === sessionKey);
    expect(row?.thinkingLevels).toEqual(harnessOnlyThinkingLevels);
    expect(row?.thinkingDefault).toBeUndefined();
    expect(before.defaults.thinkingLevels).toEqual(harnessOnlyThinkingLevels);
    expect(before.defaults.thinkingDefault).toBeUndefined();

    const url = await gatewayChatUrl(instance, "thinking-status");
    await suite.withPage(pageOptions, async ({ page }) => {
      try {
        page.on("websocket", (socket) => {
          socket.on("framesent", ({ payload }) => {
            const frame: { type: string; method?: string } = JSON.parse(payload.toString());
            if (frame.type === "req" && frame.method) {
              browserMethods.push(frame.method);
            }
          });
        });
        const composer = await enterChat(page, url);
        await completeThinkCommand(composer, page);
        await expectSendEnabled(page);
        await composer.press("Enter");
        try {
          await expect
            .poll(() => page.getByRole("log").textContent(), { timeout: 30_000 })
            .toContain("Current thinking level: Unknown.");
          expect(await page.getByRole("log").textContent()).toContain("Options: default, ultra.");
        } finally {
          await page.screenshot({ path: path.join(suite.artifactDir, "thinking-status.png") });
        }
        expect(await composer.inputValue()).toBe("");
        expect(await page.getByRole("slider").count()).toBe(0);
        await expectUnselectedUltraChoice(page, "");

        await page.goto(new URL("/sessions", url).href);
        await waitForControlUiGatewayReady(page);
        const session = page.getByRole("row").filter({ hasText: "Thinking status" });
        await session.waitFor({ state: "visible" });
        await session.press("Enter");
        const thinking = page.locator(".session-details-row select").first();
        await thinking.waitFor({ state: "visible" });
        const tableOptions = await thinking
          .locator("option")
          .evaluateAll((options) => options.map((option) => option.getAttribute("value")));
        expect(tableOptions).toEqual(["", "ultra"]);
        expect(await thinking.inputValue()).toBe("");
        await thinking.locator("..").screenshot({
          path: path.join(suite.artifactDir, "session-thinking.png"),
        });

        await page.getByRole("link", { name: "New conversation", exact: true }).first().click();
        await page.waitForURL((current) => current.pathname === "/new");
        await waitForControlUiGatewayReady(page);
        const modelControl = page.locator("[data-chat-model-select='true']");
        await expect.poll(() => modelControl.textContent()).toContain("No effort");
        expect(await page.locator("[data-chat-thinking-slider='true']").count()).toBe(0);
        await expectUnselectedUltraChoice(page, "");
        await page.locator(".chat-controls__model-settings").screenshot({
          path: path.join(suite.artifactDir, "draft-thinking.png"),
        });
      } finally {
        await page.screenshot({ path: path.join(suite.artifactDir, "last-page.png") });
      }
    });
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
  }, 120_000);
});
