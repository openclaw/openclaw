import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { createGatewayToolCallerWrapper } from "../../../src/agents/tools/gateway-caller-context.js";
import { createScreenTool } from "../../../src/agents/tools/screen-tool.js";
import type {
  GatewayClient,
  GatewayRequestContext,
} from "../../../src/gateway/server-methods/types.js";
import { uiCommandHandlers } from "../../../src/gateway/server-methods/ui-command.js";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e.ts";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  expectDefined,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
suite.define(() => {
  it("guides the requesting browser through real controls without clicking, stealing focus, or replaying", async () => {
    const source = "agent:main:session-a";
    const browsers = await Promise.all(
      ["requester", "other-user"].map(async (connId) => {
        const context = await suite.newBrowserContext({ viewport: { width: 1320, height: 900 } });
        const page = await context.newPage();
        const gateway = await installMockGateway(page, {
          sessionKey: source,
          terminalEnabled: true,
          featureMethods: [...defaultControlUiFeatureMethods, "terminal.open"],
          methodResponses: {
            "sessions.list": chatSessionListResponse([
              { key: source, kind: "direct", label: "Getting started", updatedAt: 2 },
              {
                key: "agent:main:session-b",
                kind: "direct",
                label: "Website launch",
                updatedAt: 1,
                pinned: true,
              },
            ]),
          },
          historyMessages: [
            { role: "user", content: [{ type: "text", text: "How do I open a terminal?" }] },
            {
              role: "assistant",
              content: [
                { type: "text", text: "I can point the way. You stay in control of every click." },
              ],
            },
          ],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, source));
        await page.getByText("I can point the way.", { exact: false }).first().waitFor();
        const client = {
          connId,
          connect: {
            client: {
              id: GATEWAY_CLIENT_IDS.CONTROL_UI,
              version: "test",
              platform: "web",
              mode: "ui",
            },
            caps: [GATEWAY_CLIENT_CAPS.UI_COMMANDS],
          },
        } as GatewayClient;
        return { page, gateway, client, connId };
      }),
    );
    const requester = expectDefined(browsers[0], "requester"),
      other = expectDefined(browsers[1], "other");
    const deliveries: Promise<void>[] = [];
    const context = {
      getRuntimeConfig: () => ({}),
      getClientConnIds: (filter?: (client: GatewayClient) => boolean) =>
        new Set(
          browsers.filter(({ client }) => filter?.(client) !== false).map(({ connId }) => connId),
        ),
      broadcastToConnIds: (event, payload, ids) => {
        for (const browser of browsers) {
          if (ids.has(browser.connId)) {
            deliveries.push(browser.gateway.emitGatewayEvent(event, payload));
          }
        }
      },
    } satisfies Partial<GatewayRequestContext>;
    const screen = createGatewayToolCallerWrapper("main", {
      agentSessionKey: source,
      gatewayUiCommandTarget: { connId: "requester" },
    })(
      createScreenTool({
        agentSessionKey: source,
        callGateway: async <T>(_method: string, params: Record<string, unknown>): Promise<T> => {
          const respond = vi.fn();
          await expectDefined(
            uiCommandHandlers["ui.command"],
            "handler",
          )({ params, respond, context } as never);
          expect(respond).toHaveBeenCalledWith(true, { ok: true, status: "dispatched" });
          return respond.mock.calls[0]![1] as T;
        },
      }),
    );
    const page = requester.page;
    const capture = async (name: string) => {
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
        return;
      }
      const frame = await takeControlUiScreenshotFrame(
        page,
        page.locator("openclaw-app-shell"),
        [page.locator(".agent-chat__composer-combobox textarea")],
        { animations: "disabled" },
      );
      await writeFile(path.join(suite.artifactDir, name + ".png"), frame.png);
    };
    const point = async (
      target: Record<string, string>,
      text: string,
      style = "arrow",
      color = "coral",
    ) => {
      await screen.execute("guide", {
        action: "annotate",
        durationSeconds: 120,
        annotations: [{ target, text, style, color }],
      });
      await Promise.all(deliveries);
      await page.locator(".ui-guide__label").waitFor();
    };
    await capture("01-before");
    const composer = page.locator(".agent-chat__composer-combobox textarea");
    await composer.focus();
    await point({ control: "side-panel" }, "Start here. Open your side panel.");
    await page.locator(".ui-guide__shaft").waitFor();
    expect(await composer.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(await other.page.locator(".ui-guide").count()).toBe(0);
    await capture("02-open-side-panel");
    const dismiss = page.getByRole("button", { name: "Dismiss guide" });
    await dismiss.focus();
    await page.setViewportSize({ width: 1319, height: 900 });
    await expect
      .poll(() => dismiss.evaluate((element) => element === document.activeElement))
      .toBe(true);
    await page.setViewportSize({ width: 1320, height: 900 });
    await page.locator(".chat-side-panel-toggle").click();
    await page.locator(".ui-guide").waitFor({ state: "detached" });
    await point({ control: "terminal-new" }, "Choose Terminal. Your shell opens here.");
    await page.locator(".ui-guide__shaft").waitFor();
    await capture("03-choose-terminal");
    await page.locator("[data-guide-target='terminal-new']").click();
    await requester.gateway.waitForRequest("terminal.open");
    await point({ control: "panel-new" }, "Use the plus to add another panel.");
    await page.locator(".ui-guide__shaft").waitFor();
    await capture("04-add-panel");
    await page.locator(".side-panel-type-menu__trigger").click();
    await point({ control: "terminal-new" }, "Open another terminal from this menu.");
    await page.locator(".ui-guide__shaft").waitFor();
    await capture("05-another-terminal");
    await page.keyboard.press("Escape");
    await point(
      { sessionKey: "agent:main:session-b" },
      "Your pinned launch conversation is right here.",
      "outline",
      "teal",
    );
    await page.locator(".ui-guide__outline").waitFor();
    await capture("05-pinned-conversation");
    await page.keyboard.press("Escape");
    await point({ control: "agent-menu" }, "Want another claw? Start with the agent menu.");
    await page.locator(".ui-guide__shaft").waitFor();
    await capture("06-agent-menu");
    await page.locator("[data-guide-target='agent-menu']").click();
    await point({ control: "agent-new" }, "Create a new claw from here.", "arrow", "purple");
    await page.locator(".ui-guide__shaft").waitFor();
    expect(
      await page.locator(".ui-guide").evaluate((element) => element.matches(":popover-open")),
    ).toBe(true);
    await capture("07-new-claw");
    await page.keyboard.press("Escape");
    await point(
      { text: "I can point the way. You stay in control of every click." },
      "This explanation stays in your conversation.",
      "note",
      "teal",
    );
    await page.locator(".ui-guide__shaft").waitFor();
    await capture("08-mentioned-content");
    await page.locator(".sidebar-identity-card").click();
    await point(
      { control: "settings" },
      "Appearance and preferences live in Settings.",
      "arrow",
      "purple",
    );
    await page.locator(".ui-guide__shaft").waitFor();
    await capture("09-settings");
    await page.keyboard.press("Escape");
    await point({ text: "A control that is not on screen" }, "Reveal the target to continue.");
    await page.getByText("Waiting for one visible target.", { exact: false }).waitFor();
    expect(await page.locator(".ui-guide__shaft").count()).toBe(0);
    await capture("09-missing-target");
    await screen.execute("clear", { action: "annotations_clear" });
    await Promise.all(deliveries);
    await page.locator(".ui-guide").waitFor({ state: "detached" });
    await point({ control: "side-panel" }, "A fresh guide, not history.");
    await page.reload();
    await composer.waitFor();
    expect(await page.locator(".ui-guide").count()).toBe(0);
    const toggle = page.locator(".chat-side-panel-toggle");
    if ((await toggle.getAttribute("aria-expanded")) === "true") {
      await toggle.click();
    }
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await screen.execute("multi", {
      action: "annotate",
      durationSeconds: 120,
      annotations: [
        { target: { control: "agent-menu" }, text: "Your claw and its settings.", color: "coral" },
        {
          target: { sessionKey: "agent:main:session-b" },
          text: "Your pinned launch conversation.",
          color: "teal",
        },
      ],
    });
    await Promise.all(deliveries);
    await expect.poll(() => page.locator(".ui-guide__shaft").count()).toBe(2);
    await capture("10-dark-multiple");
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    await point({ control: "side-panel" }, "The same guide works on a narrow screen.");
    await page.locator(".ui-guide__shaft").waitFor();
    await capture("11-narrow");
    const bounds = await page.locator(".ui-guide__label").boundingBox();
    expect(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390).toBe(true);
    await page.keyboard.press("Escape");
    await page.clock.install();
    await screen.execute("expiry", {
      action: "annotate",
      durationSeconds: 3,
      annotations: [{ target: { control: "side-panel" }, text: "This guide expires." }],
    });
    await Promise.all(deliveries);
    await page.locator(".ui-guide__label").waitFor();
    await page.clock.fastForward(3001);
    await page.locator(".ui-guide").waitFor({ state: "detached" });
  });
});
