import { expect, it } from "vitest";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createEventWebPushDelivery } from "./event-web-push.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import {
  createSessionViewerPresenceDeclarations,
  type SessionViewerPresenceDeclarations,
} from "./session-viewer-presence.js";

const researchContext = { agentId: "research", sessionKeys: ["agent:research:thread.1"] };

type Viewers = {
  declarations: SessionViewerPresenceDeclarations;
  view: (deviceId: string | undefined, sessionKeys?: readonly string[]) => GatewayWsClient;
};

function createViewers(): Viewers {
  const clients = new GatewayClientRegistry();
  const declarations = createSessionViewerPresenceDeclarations({
    clients,
    publishPresence: () => {},
  });
  const view: Viewers["view"] = (deviceId, sessionKeys = researchContext.sessionKeys) => {
    const client: GatewayWsClient = {
      connId: `conn-${deviceId ?? "anonymous"}`,
      usesSharedGatewayAuth: false,
      socket: { readyState: 1 } as GatewayWsClient["socket"],
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        role: "operator",
        client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
        ...(deviceId
          ? {
              device: { id: deviceId, publicKey: "key", signature: "sig", signedAt: 1, nonce: "n" },
            }
          : {}),
      },
    };
    clients.add(client);
    declarations.replace(client.connId, sessionKeys);
    return client;
  };
  return { declarations, view };
}

export function registerViewerWebPushTests(params: {
  setRecipients: (scopes?: string[]) => void;
  sentDeviceIds: () => string[];
  clearSent: () => void;
  waitForSend: () => Promise<unknown>;
  authorityCompleted: () => Promise<unknown>;
}) {
  it.each<[string, string, (viewers: Viewers) => unknown, string[]]>([
    ["the viewing device", "chat", ({ view }) => view("phone"), ["desktop"]],
    ["no declaration", "chat", () => {}, ["phone", "desktop"]],
    [
      "a hidden document",
      "chat",
      ({ view, declarations }) => declarations.replace(view("phone").connId, []),
      ["phone", "desktop"],
    ],
    [
      "another session",
      "chat",
      ({ view }) => view("phone", ["agent:research:other"]),
      ["phone", "desktop"],
    ],
    [
      "a closed connection",
      "chat",
      ({ view }) => (view("phone").socket = { readyState: 3 } as GatewayWsClient["socket"]),
      ["phone", "desktop"],
    ],
    [
      "an invalidated connection",
      "chat",
      ({ view }) => (view("phone").invalidated = true),
      ["phone", "desktop"],
    ],
    [
      "a disconnect",
      "chat",
      ({ view, declarations }) => declarations.unsubscribe(view("phone").connId),
      ["phone", "desktop"],
    ],
    [
      "an aborted connection",
      "chat",
      ({ view }) => {
        const controller = new AbortController();
        view("phone").connectionSignal = controller.signal;
        controller.abort();
      },
      ["phone", "desktop"],
    ],
    [
      "stopped declarations",
      "chat",
      ({ view, declarations }) => {
        view("phone");
        declarations.stop();
      },
      ["phone", "desktop"],
    ],
    ["no device identity", "chat", ({ view }) => view(undefined), ["phone", "desktop"]],
    ["a question", "question.requested", ({ view }) => view("phone"), ["phone", "desktop"]],
  ])(
    "suppresses only the device viewing a finished session (%s)",
    async (_case, event, arrange, expected) => {
      params.setRecipients(["operator.read", "operator.questions"]);
      const viewers = createViewers();
      arrange(viewers);

      createEventWebPushDelivery({
        getRuntimeConfig: () => ({}),
        viewers: viewers.declarations,
      }).handleEvent(
        event,
        { state: "final", runId: "viewed-run", id: "question-1" },
        researchContext,
      );

      await params.authorityCompleted();
      const sent = params.sentDeviceIds();
      expect(sent).toEqual(expected);
    },
  );

  it("fails open before lifecycle attachment and observes the attached live viewer owner", async () => {
    params.setRecipients();
    const state = createGatewayConnectionState({
      scheduler: createTestGatewayScheduler(),
      bootId: "viewer-push",
      cfg: {},
    });
    const viewers = createViewers();
    viewers.view("phone");
    try {
      state.broadcast("chat", { state: "final", runId: "before-attach" }, researchContext);
      await params.waitForSend();
      expect(params.sentDeviceIds()).toEqual(["phone", "desktop"]);
      params.clearSent();
      state.attachSessionViewerPresence(viewers.declarations);
      state.broadcast("chat", { state: "final", runId: "after-attach" }, researchContext);
      await params.waitForSend();
      expect(params.sentDeviceIds()).toEqual(["desktop"]);
    } finally {
      viewers.declarations.stop();
      await state.mentionInbox.dispose();
    }
  });

  it.each([
    { sessionKeys: [] },
    { sessionKeys: ["agent:research:thread.1", "agent:research:other"] },
  ])("does not suppress ambiguous session scope $sessionKeys", async ({ sessionKeys }) => {
    params.setRecipients();
    const viewers = createViewers();
    viewers.view("phone");
    createEventWebPushDelivery({
      getRuntimeConfig: () => ({}),
      viewers: viewers.declarations,
    }).handleEvent(
      "chat",
      { state: "final", runId: "ambiguous" },
      { agentId: "research", sessionKeys },
    );
    await params.authorityCompleted();
    expect(params.sentDeviceIds()).toEqual(["phone", "desktop"]);
  });
}
