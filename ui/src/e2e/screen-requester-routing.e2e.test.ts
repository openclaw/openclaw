import { expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { validateUiCommandParams } from "../../../packages/gateway-protocol/src/index.js";
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
    const environment = (ready = false) => ({
      id: "preview-desktop",
      type: "worker",
      status: ready ? "available" : "starting",
      desktop: ready,
    });
    const observation = (control = false) => ({
      transport: "rfb",
      wsPath: `/desktop/observe?token=synthetic${control ? "-control" : ""}`,
      expiresAtMs: 60_000,
      control,
    });
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
            "ui.command.result",
          ],
          methodResponses: {
            "sessions.list": chatSessionListResponse(),
            "environments.status": environment(),
            "desktop.observe": observation(),
            "portal.list": {
              portals: [
                {
                  id: "preview-web",
                  title: "Crabbox web app",
                  port: 3000,
                  tokenQuery: "openclaw_portal=synthetic",
                  url: "http://127.0.0.1:43210/?openclaw_portal=synthetic",
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
            deliveries.push(
              (async () => {
                await browser.gateway.emitGatewayEvent(event, payload);
                if (
                  event === "ui.command" &&
                  validateUiCommandParams(payload) &&
                  payload.requestId
                ) {
                  const report = await browser.gateway.waitForRequest("ui.command.result", {
                    match: { requestId: payload.requestId },
                  });
                  const respond = vi.fn();
                  await uiCommandHandlers["ui.command.result"]!({
                    params: report.params,
                    client: browser.client,
                    respond,
                    context,
                  } as never);
                  expect(respond).toHaveBeenCalledWith(true, { ok: true });
                }
              })(),
            );
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
          await uiCommandHandlers["ui.command"]!({ params, respond, context } as never);
          if (!validateUiCommandParams(params)) {
            throw new Error("Screen tool emitted an invalid UI command");
          }
          const command = params.command;
          if (command.kind === "panel" && command.panel === "portal" && command.open) {
            expect(respond).toHaveBeenCalledWith(true, {
              ok: true,
              delivery: "dispatched",
              presentation: {
                status: "unverified",
                ...("portalId" in command && command.portalId
                  ? { portalId: command.portalId, reason: "network-reachable" }
                  : { reason: "waiting-for-app" }),
              },
            });
          } else {
            expect(respond).toHaveBeenCalledWith(true, { ok: true });
          }
          return expectDefined(respond.mock.calls[0], "Gateway response")[1] as T;
        },
      }),
    );
    const command = async (id: string, params: Record<string, unknown>) => {
      await screen.execute(id, { sessionKey: destination, ...params });
      await Promise.all(deliveries);
    };
    const requester = expectDefined(browsers[0], "requester");
    const other = expectDefined(browsers[1], "other user");
    const proof = (name: string) =>
      captureUiProof(suite, requester.page, "screen-requester-routing", `${name}.png`);

    await command("select", { action: "navigate" });
    await expect
      .poll(() => new URL(requester.page.url()).pathname)
      .toBe(controlUiSessionPath(destination));
    await Promise.all(
      browsers.map(({ page, client }) =>
        captureUiProof(suite, page, "screen-requester-routing", `${client.connId}.png`),
      ),
    );
    expect(new URL(other.page.url()).pathname).toBe(controlUiSessionPath(source));
    expect(deliveries).toHaveLength(1);

    const rfb = await installScriptedRfbServer(requester.page);
    await command("show-native", { action: "desktop_show", environmentId: "preview-desktop" });
    const desktop = requester.page.locator("openclaw-desktop-panel[embedded]");
    await requester.gateway.waitForRequest("environments.status");
    await desktop.locator("openclaw-panel-loading-skeleton").waitFor();
    await desktop.getByText("Starting your machine…", { exact: true }).waitFor();
    expect(await requester.gateway.getRequests("desktop.observe")).toHaveLength(0);
    await proof("pending-desktop");
    await requester.gateway.setMethodResponse("environments.status", environment(true));
    await requester.gateway.waitForRequest("desktop.observe", {
      match: { source: { kind: "environment", environmentId: "preview-desktop" } },
    });
    await expect.poll(rfb.events).toContain("authenticated:1");
    await rfb.send([createRfbRawFrame()]);
    expect(await other.gateway.getRequests("desktop.observe")).toHaveLength(0);

    await requester.gateway.setMethodResponse("desktop.observe", observation(true));
    await desktop.getByRole("button", { name: "Take control", exact: true }).click();
    await expect.poll(rfb.events).toContain("authenticated:2");
    await desktop.getByRole("button", { name: "Switch to view only", exact: true }).waitFor();
    const controlledCanvas = await desktop.locator("canvas").elementHandle();
    const desktopRequests = () =>
      Promise.all(
        ["environments.status", "desktop.observe", "desktop.release"].map((method) =>
          requester.gateway.getRequests(method),
        ),
      );
    const requestsBeforeShow = await desktopRequests();
    for (const [environmentId, dock] of [
      ["preview-desktop", "bottom"],
      [undefined, "right"],
    ] as const) {
      await command("show-current-desktop", {
        action: "desktop_show",
        dock,
        ...(environmentId ? { environmentId } : {}),
      });
      await requester.page.locator(`.sidebar-region--${dock}`).filter({ has: desktop }).waitFor();
      expect(await desktopRequests()).toEqual(requestsBeforeShow);
      expect(await controlledCanvas?.evaluate((element) => element.isConnected)).toBe(true);
      expect(await rfb.connectionCount()).toBe(2);
      await desktop.getByRole("button", { name: "Switch to view only", exact: true }).waitFor();
    }
    await proof("human-control-preserved");

    await command("prepare-web", { action: "portal_show", environmentId: "preview-desktop" });
    const portal = requester.page.locator("openclaw-portals-page[embedded]");
    const pendingApp = portal.getByText("Machine ready. Waiting for your application…", {
      exact: true,
    });
    const app = requester.page.frameLocator("openclaw-portals-page[embedded] iframe");
    await pendingApp.waitFor();
    expect(await requester.gateway.getRequests("portal.list")).toHaveLength(0);
    await proof("pending-portal");
    await requester.page.reload();
    await pendingApp.waitFor();
    expect(await requester.gateway.getRequests("portal.list")).toHaveLength(0);

    await command("show-web", { action: "portal_show", portalId: "preview-web" });
    await portal.locator("iframe").waitFor();
    await app.getByRole("button", { name: "Click me" }).click();
    await app.getByRole("button", { name: "Clicked" }).waitFor();
    expect(await other.gateway.getRequests("portal.list")).toHaveLength(0);
    await proof("ready-portal");
    await installScriptedRfbServer(requester.page);

    await command("inspect-desktop", { action: "desktop_show", environmentId: "preview-desktop" });
    await portal.waitFor({ state: "hidden" });
    await command("show-web-again", { action: "portal_show", portalId: "preview-web" });
    await app.getByRole("button", { name: "Clicked" }).waitFor();

    await requester.page.reload();
    await app.getByRole("heading", { name: "Crabbox web app" }).waitFor();

    await command("hide-web", { action: "portal_hide" });
    await portal.waitFor({ state: "detached" });
    expect(await requester.gateway.getRequests("portal.close")).toHaveLength(0);
  });
});
