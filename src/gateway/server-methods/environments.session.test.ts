import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { withPersonalToolTurn } from "../../auto-reply/reply/personal-tool-turn.test-support.js";
import { ensureSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabases } from "../../state/openclaw-agent-db-lifecycle.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createOperatorClient } from "../server-plugin-in-process-dispatch.test-support.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import * as support from "../worker-environments/service.test-support.js";
import { environmentsSessionHandlers } from "./environments.session.js";

function participant(profileId: string, name: string) {
  return {
    profileId,
    name,
    senderId: `${profileId}-sender`,
    gatewayUiCommandTarget: { connId: `${profileId}-tab`, profileId },
  };
}
const owner = participant("alice", "Alice");
const steerer = participant("bob", "Bob");
const identity = {
  agentId: "main",
  sessionKey: "agent:main:personal-tools",
  sessionId: "personal-tools",
};

support.setupWorkerEnvironmentServiceSuite();
beforeEach(() => {
  support.testState.config.session = {
    store: path.join(support.testState.root, "sessions.json"),
  };
  ensureSessionEntrySync(
    { ...identity, storePath: support.testState.config.session.store },
    { sessionId: identity.sessionId, updatedAt: 1 },
  );
});
afterEach(() => closeOpenClawAgentDatabases());

function fixture() {
  const provision = vi.fn(async () => ({ leaseId: "lease-one", ssh: support.SSH_ENDPOINT }));
  const service = support.createService(support.createProvider({ provision }));
  const create = vi.spyOn(service, "createSessionAttachment");
  const clients = [owner, steerer].map((person) => {
    const client = createOperatorClient({
      profileId: person.profileId,
      scopes: [],
      caps: [GATEWAY_CLIENT_CAPS.UI_COMMANDS],
    });
    client.connId = person.gatewayUiCommandTarget.connId;
    client.connect.client.id = GATEWAY_CLIENT_IDS.CONTROL_UI;
    return client;
  });
  const context = createDirectChatContext({
    getRuntimeConfig: () => support.testState.config,
    workerEnvironmentService: service,
    getClientConnIds: (filter) =>
      new Set(clients.filter(filter ?? (() => true)).map((client) => client.connId!)),
  });
  const respond = vi.fn();
  const call = (presentation?: "desktop" | "portal") =>
    withGatewayToolCallerIdentity(
      { ...identity, assertToolAllowed: () => {}, gatewayContextResolver: () => context },
      () =>
        environmentsSessionHandlers["environments.session.create"]!({
          req: { type: "req", id: "create-preview", method: "environments.session.create" },
          params: {
            profileId: "development",
            idempotencyKey: "open-preview",
            ...(presentation ? { presentation } : {}),
          },
          client: createSyntheticPluginRuntimeClient({ pluginRuntimeOwnerId: "crabbox" }),
          context,
          isWebchatConnect: () => false,
          respond,
        }),
    );
  const expectRejected = (message: RegExp) => {
    expect(provision).not.toHaveBeenCalled();
    expect(context.broadcastToConnIds).not.toHaveBeenCalled();
    expect(respond.mock.lastCall).toMatchObject([
      false,
      undefined,
      { message: expect.stringMatching(message) },
    ]);
  };
  const expectAvailable = () => {
    expect(respond.mock.lastCall).toMatchObject([true, { environment: { status: "available" } }]);
    expect(provision).toHaveBeenCalledOnce();
  };
  return { call, create, service, context, expectRejected, expectAvailable };
}

it.each(["desktop", "portal"] as const)(
  "rejects ambiguous %s presentation before creating an environment, but permits creation without presentation",
  async (presentation) => {
    const test = fixture();
    await withPersonalToolTurn({ owner, allowCollaborativeSteering: true }, async (turn) => {
      expect(await turn.steer(steerer)).toMatchObject({ status: "accepted" });
      await test.call(presentation);
      expect(test.create).not.toHaveBeenCalled();
      test.expectRejected(
        /without presentation.*screen.*desktop_show.*portal_show.*environmentId.*requester_profile.id/s,
      );
      await test.call();
      test.expectAvailable();
    });
  },
);

it("presents a single-owner environment only in that owner's connection", async () => {
  const test = fixture();
  await withPersonalToolTurn({ owner }, () => test.call("desktop"));
  test.expectAvailable();
  expect(test.context.broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
    "ui.command",
    expect.objectContaining({
      command: expect.objectContaining({ panel: "desktop", open: true }),
    }),
    new Set(["alice-tab"]),
  );
});

it.each(["ambiguity", "revocation"])("cancels before allocation: %s", async (change) => {
  const test = fixture();
  await withPersonalToolTurn({ owner, allowCollaborativeSteering: true }, async (turn) => {
    const store = support.testState.store;
    const reserve = store.createSessionAttachmentIntent.bind(store);
    vi.spyOn(store, "createSessionAttachmentIntent").mockImplementation(async (...args) => {
      const reservation = await reserve(...args);
      if (change === "revocation") {
        turn.revoke(owner.profileId);
      } else {
        expect(await turn.steer(steerer)).toMatchObject({ status: "accepted" });
      }
      return reservation;
    });
    await test.call("portal");
    expect(test.create).toHaveBeenCalledOnce();
    test.expectRejected(
      change === "revocation" ? /Profile access revoked/ : /Several people.*Alice.*Bob/s,
    );
    expect(test.service.getSessionAttachmentStatus(identity.sessionId)).toMatchObject({
      attachment: { closedAtMs: expect.any(Number) },
      environment: { state: "failed" },
    });
  });
});
