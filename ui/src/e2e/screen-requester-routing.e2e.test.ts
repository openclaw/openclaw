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
import {
  captureUiProof,
  chatSessionListResponse,
  controlUiSessionPath,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  expectDefined,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("opens the selected session only in the browser that asked the agent", async () => {
    const source = "agent:main:session-a";
    const destination = "agent:main:session-b";
    const browsers = await Promise.all(
      ["requester", "other-user"].map(async (connId) => {
        const context = await suite.newBrowserContext({ viewport: { width: 1100, height: 800 } });
        const page = await context.newPage();
        const gateway = await installMockGateway(page, {
          sessionKey: source,
          methodResponses: { "sessions.list": chatSessionListResponse() },
          historyMessages: [
            { role: "assistant", content: [{ type: "text", text: "Synthetic navigation proof." }] },
          ],
        });
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
  });
});
