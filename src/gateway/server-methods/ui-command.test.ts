import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { createGatewayToolCallerWrapper } from "../../agents/tools/gateway-caller-context.js";
import { createScreenTool } from "../../agents/tools/screen-tool.js";
import type { GatewayClient } from "./types.js";
import { uiCommandHandlers } from "./ui-command.js";

function client(
  connId: string,
  id: string = GATEWAY_CLIENT_IDS.CONTROL_UI,
  caps: string[] = [GATEWAY_CLIENT_CAPS.UI_COMMANDS],
  profileId?: string,
): GatewayClient {
  return {
    connId,
    ...(profileId
      ? {
          authenticatedUserProfile: {
            profileId,
            displayName: null,
            hasAvatar: false,
            updatedAt: 1,
          },
        }
      : {}),
    connect: {
      client: { id, version: "test", platform: "web", mode: "ui" },
      caps,
    },
  } as GatewayClient;
}

async function call(params: unknown, clients: GatewayClient[], requester?: GatewayClient) {
  const respond = vi.fn();
  const broadcastToConnIds = vi.fn();
  await expectDefined(
    uiCommandHandlers["ui.command"],
    "ui.command",
  )({
    params,
    client: requester,
    respond,
    context: {
      broadcastToConnIds,
      getRuntimeConfig: () => ({}),
      getClientConnIds: (filter?: (client: GatewayClient) => boolean) =>
        new Set(
          clients
            .filter((entry) => filter?.(entry) !== false)
            .flatMap((entry) => (entry.connId ? [entry.connId] : [])),
        ),
    },
  } as never);
  return { respond, broadcastToConnIds };
}

describe("ui.command gateway method", () => {
  it("rejects invalid params", async () => {
    const result = await call({ command: { kind: "sidebar", visible: "yes" } }, []);

    expect(result.respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
    expect(result.broadcastToConnIds).not.toHaveBeenCalled();
  });

  it("reports when no capable Control UI client is connected", async () => {
    const requester = client("legacy-ui", GATEWAY_CLIENT_IDS.CONTROL_UI, []);
    const result = await call(
      { command: { kind: "sidebar", visible: true } },
      [requester, client("capable-cli", GATEWAY_CLIENT_IDS.CLI)],
      requester,
    );

    expect(result.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
    expect(result.broadcastToConnIds).not.toHaveBeenCalled();
  });

  it("navigates only the requester, even when another user and another tab share the session", async () => {
    const params = {
      command: { kind: "navigate", sessionKey: "agent:main:other" },
      sessionKey: "agent:main:main",
    };
    const requester = client("alice-tab-one", undefined, undefined, "alice");
    const result = await call(
      params,
      [
        requester,
        client("alice-tab-two", undefined, undefined, "alice"),
        client("bob-tab", undefined, undefined, "bob"),
        client("legacy-ui", GATEWAY_CLIENT_IDS.CONTROL_UI, []),
        client("cli", GATEWAY_CLIENT_IDS.CLI),
      ],
      requester,
    );

    expect(result.broadcastToConnIds).toHaveBeenCalledWith(
      "ui.command",
      {
        ...params,
        agentId: "main",
        sessionKey: "agent:main:other",
      },
      new Set(["alice-tab-one"]),
    );
    expect(result.respond).toHaveBeenCalledWith(true, { ok: true });
  });

  it("keeps the agent screen tool bound to its requesting browser across async execution", async () => {
    const requester = client("requester");
    const recipients = [requester, client("bystander")];
    const deliveries: Set<string>[] = [];
    const screen = createGatewayToolCallerWrapper("main", {
      agentSessionKey: "agent:main:main",
      gatewayUiCommandTarget: { connId: requester.connId! },
    })(
      createScreenTool({
        agentSessionKey: "agent:main:main",
        callGateway: async <T>(_method: string, params: Record<string, unknown>): Promise<T> => {
          await Promise.resolve();
          const result = await call(params, recipients);
          expect(result.respond).toHaveBeenCalledWith(true, { ok: true });
          const delivery = expectDefined(result.broadcastToConnIds.mock.calls[0], "UI delivery");
          deliveries.push(delivery[2]);
          return { ok: true } as T;
        },
      }),
    );

    await screen.execute("select", { action: "navigate", sessionKey: "agent:main:selected" });

    expect(deliveries).toEqual([new Set(["requester"])]);
  });

  it.each([
    "missing",
    "disconnected",
    "invalidated",
    "retired",
    "synthetic",
    "backend",
    "different-profile",
  ])("does not redirect a %s requester to another browser", async (state) => {
    const requester = client("requester", undefined, undefined, "alice");
    if (state === "synthetic") {
      requester.internal = { syntheticClient: true };
    }
    if (state === "backend") {
      requester.connect.client.id = GATEWAY_CLIENT_IDS.GATEWAY_CLIENT;
    }
    const recipient = {
      ...requester,
      ...(state === "invalidated" ? { invalidated: true } : {}),
      ...(state === "retired" ? { connectionSignal: AbortSignal.abort() } : {}),
      ...(state === "different-profile"
        ? {
            authenticatedUserProfile: client("requester", undefined, undefined, "bob")
              .authenticatedUserProfile,
          }
        : {}),
    };
    const result = await call(
      { command: { kind: "navigate", sessionKey: "agent:main:selected" } },
      [client("bystander"), ...(state === "disconnected" ? [] : [recipient])],
      state === "missing" ? undefined : requester,
    );

    expect(result.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
    expect(result.broadcastToConnIds).not.toHaveBeenCalled();
  });

  it("rejects caller-supplied browser targeting in RPC params", async () => {
    const requester = client("requester");
    const result = await call(
      {
        command: { kind: "sidebar", visible: true },
        gatewayUiCommandTarget: { connId: "bystander" },
      },
      [requester, client("bystander")],
      requester,
    );

    expect(result.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(result.broadcastToConnIds).not.toHaveBeenCalled();
  });
});
