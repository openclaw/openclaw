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
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e.ts";
import {
  captureUiProof,
  chatSessionListResponse,
  controlUiSessionPath,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  expectDefined,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { createRfbRawFrame, installScriptedRfbServer } from "./desktop-rfb-test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("opens the selected session and its app views only in the browser that asked the agent", async () => {
    const source = "agent:main:session-a";
    const destination = "agent:main:session-b";
    const browsers = await Promise.all(
      ["requester", "other-user"].map(async (connId) => {
        const context = await suite.newBrowserContext({ viewport: { width: 1100, height: 800 } });
        const page = await context.newPage();
        const gateway = await installMockGateway(page, {
          sessionKey: source,
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "desktop.observe",
            "environments.status",
            "portal.list",
          ],
          methodResponses: {
            "sessions.list": chatSessionListResponse(),
            "environments.status": {
              id: "preview-desktop",
              type: "worker",
              status: "starting",
              desktop: false,
            },
            "desktop.observe": {
              transport: "rfb",
              wsPath: "/desktop/observe?token=synthetic",
              expiresAtMs: 60_000,
              control: false,
            },
            "portal.list": {
              portals: [
                {
                  id: "preview-web",
                  title: "Crabbox web app",
                  port: 3000,
                  listenPort: 43210,
                  tokenQuery: "openclaw_portal=synthetic",
                  publicUrl: "http://127.0.0.1:43210/",
                  url: "http://127.0.0.1:43210/?openclaw_portal=synthetic",
                  createdAtMs: 1,
                },
              ],
            },
          },
          historyMessages: [
            { role: "assistant", content: [{ type: "text", text: "Synthetic navigation proof." }] },
          ],
        });
        await page.route("http://127.0.0.1:43210/**", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: "<!doctype html><title>Crabbox web app</title><h1>Crabbox web app</h1><button onclick=\"this.textContent='Clicked'\">Click me</button>",
          }),
        );
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, source));
        await gateway.waitForRequest("chat.startup");
        await page.getByText("Synthetic navigation proof.").first().waitFor();
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
    const deliveries: Promise<void>[] = [];
    const context = {
      getRuntimeConfig: () => ({}),
      getClientConnIds: (filter?: (client: GatewayClient) => boolean) =>
        new Set(
          browsers.filter(({ client }) => filter?.(client) !== false).map(({ connId }) => connId),
        ),
      broadcastToConnIds: (event, payload, connIds) => {
        for (const browser of browsers) {
          if (connIds.has(browser.connId)) {
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
            "ui.command",
          )({ params, respond, context } as never);
          expect(respond).toHaveBeenCalledWith(true, { ok: true });
          return { ok: true } as T;
        },
      }),
    );

    await screen.execute("select", { action: "navigate", sessionKey: destination });
    await Promise.all(deliveries);
    await expect
      .poll(() => new URL(expectDefined(browsers[0], "requester").page.url()).pathname)
      .toBe(controlUiSessionPath(destination));
    await Promise.all(
      browsers.map(({ page, client }) =>
        captureUiProof(suite, page, "screen-requester-routing", `${client.connId}.png`),
      ),
    );
    expect(new URL(expectDefined(browsers[1], "other user").page.url()).pathname).toBe(
      controlUiSessionPath(source),
    );
    expect(deliveries).toHaveLength(1);

    const requester = expectDefined(browsers[0], "requester");
    const other = expectDefined(browsers[1], "other user");
    const rfb = await installScriptedRfbServer(requester.page);
    await screen.execute("show-native", {
      action: "desktop_show",
      environmentId: "preview-desktop",
      sessionKey: destination,
    });
    await Promise.all(deliveries);
    const desktop = requester.page.locator("openclaw-desktop-panel[embedded]");
    await requester.gateway.waitForRequest("environments.status");
    await desktop.locator("openclaw-panel-loading-skeleton").waitFor();
    await desktop.getByText("Starting your machine…", { exact: true }).waitFor();
    expect(await requester.gateway.getRequests("desktop.observe")).toHaveLength(0);
    await captureUiProof(suite, requester.page, "screen-requester-routing", "pending-desktop.png");
    await requester.gateway.setMethodResponse("environments.status", {
      id: "preview-desktop",
      type: "worker",
      status: "available",
      desktop: true,
    });
    await requester.gateway.waitForRequest("desktop.observe", {
      match: { source: { kind: "environment", environmentId: "preview-desktop" } },
    });
    await desktop.locator("canvas").waitFor();
    await expect.poll(rfb.events).toContain("authenticated:1");
    await rfb.send([createRfbRawFrame()]);
    expect(await other.gateway.getRequests("desktop.observe")).toHaveLength(0);

    await requester.gateway.setMethodResponse("desktop.observe", {
      transport: "rfb",
      wsPath: "/desktop/observe?token=synthetic-control",
      expiresAtMs: 60_000,
      control: true,
    });
    await desktop.getByRole("button", { name: "Take control", exact: true }).click();
    await expect.poll(rfb.events).toContain("authenticated:2");
    await desktop
      .getByText("You control this desktop. Agent input is paused until you switch to view only.", {
        exact: true,
      })
      .waitFor();
    const controlledCanvas = await desktop.locator("canvas").elementHandle();
    const requestsBeforeShow = await Promise.all(
      ["environments.status", "desktop.observe", "desktop.release"].map((method) =>
        requester.gateway.getRequests(method),
      ),
    );
    for (const [environmentId, dock] of [
      ["preview-desktop", "bottom"],
      [undefined, "right"],
    ] as const) {
      await screen.execute("show-current-desktop", {
        action: "desktop_show",
        sessionKey: destination,
        dock,
        ...(environmentId ? { environmentId } : {}),
      });
      await Promise.all(deliveries);
      await requester.page.locator(`.sidebar-region--${dock}`).filter({ has: desktop }).waitFor();
      await expect
        .poll(() =>
          desktop.evaluate(
            (element) =>
              (element as HTMLElementTagNameMap["openclaw-desktop-panel"]).refreshOnPresentation,
          ),
        )
        .toBe(true);
      expect(
        await Promise.all(
          ["environments.status", "desktop.observe", "desktop.release"].map((method) =>
            requester.gateway.getRequests(method),
          ),
        ),
      ).toEqual(requestsBeforeShow);
      expect(await controlledCanvas?.evaluate((element) => element.isConnected)).toBe(true);
      expect(await rfb.connectionCount()).toBe(2);
      await desktop
        .getByText(
          "You control this desktop. Agent input is paused until you switch to view only.",
          { exact: true },
        )
        .waitFor();
    }
    await captureUiProof(
      suite,
      requester.page,
      "screen-requester-routing",
      "human-control-preserved.png",
    );
    await requester.gateway.setMethodResponse("desktop.observe", {
      transport: "rfb",
      wsPath: "/desktop/observe?token=synthetic",
      expiresAtMs: 60_000,
      control: false,
    });
    await desktop.getByRole("button", { name: "Switch to view only", exact: true }).click();
    await expect.poll(rfb.events).toContain("authenticated:3");
    expect((await requester.gateway.getRequests("desktop.observe")).at(-1)).toMatchObject({
      params: { control: false },
    });

    await screen.execute("prepare-web", {
      action: "portal_show",
      environmentId: "preview-desktop",
      sessionKey: destination,
    });
    await Promise.all(deliveries);
    const portal = requester.page.locator("openclaw-portals-page[embedded]");
    await portal
      .getByText("Machine ready. Waiting for your application…", { exact: true })
      .waitFor();
    expect(await requester.gateway.getRequests("portal.list")).toHaveLength(0);
    await captureUiProof(suite, requester.page, "screen-requester-routing", "pending-portal.png");
    await requester.page.reload();
    await portal
      .getByText("Machine ready. Waiting for your application…", { exact: true })
      .waitFor();
    expect(await requester.gateway.getRequests("portal.list")).toHaveLength(0);

    await screen.execute("show-web", {
      action: "portal_show",
      portalId: "preview-web",
      sessionKey: destination,
    });
    await Promise.all(deliveries);
    await portal.locator("iframe").waitFor();
    await requester.page
      .frameLocator("openclaw-portals-page[embedded] iframe")
      .getByRole("button", { name: "Click me" })
      .click();
    await requester.page
      .frameLocator("openclaw-portals-page[embedded] iframe")
      .getByRole("button", { name: "Clicked" })
      .waitFor();
    expect(await other.gateway.getRequests("portal.list")).toHaveLength(0);
    await captureUiProof(suite, requester.page, "screen-requester-routing", "ready-portal.png");
    await installScriptedRfbServer(requester.page);

    await screen.execute("inspect-desktop", {
      action: "desktop_show",
      environmentId: "preview-desktop",
      sessionKey: destination,
    });
    await Promise.all(deliveries);
    await portal.waitFor({ state: "hidden" });
    await screen.execute("show-web-again", {
      action: "portal_show",
      portalId: "preview-web",
      sessionKey: destination,
    });
    await Promise.all(deliveries);
    await requester.page
      .frameLocator("openclaw-portals-page[embedded] iframe")
      .getByRole("button", { name: "Clicked" })
      .waitFor();

    await requester.page.reload();
    await requester.page
      .frameLocator("openclaw-portals-page[embedded] iframe")
      .getByRole("heading", { name: "Crabbox web app" })
      .waitFor();
    expect(
      await desktop.evaluate(
        (element) => (element as HTMLElementTagNameMap["openclaw-desktop-panel"]).requestedSource,
      ),
    ).toBe("preview-desktop");

    await screen.execute("hide-web", { action: "portal_hide", sessionKey: destination });
    await Promise.all(deliveries);
    await portal.waitFor({ state: "detached" });
    expect(await requester.gateway.getRequests("portal.close")).toHaveLength(0);
  });
});
