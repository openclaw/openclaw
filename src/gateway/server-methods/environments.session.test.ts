import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { withPersonalToolTurn } from "../../auto-reply/reply/personal-tool-turn.test-support.js";
import { ensureSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabases } from "../../state/openclaw-agent-db.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import * as support from "../worker-environments/service.test-support.js";
import { environmentsSessionHandlers } from "./environments.session.js";
import type { GatewayClient } from "./types.js";

const owner = {
  profileId: "alice",
  senderId: "alice-sender",
  name: "Alice",
  gatewayUiCommandTarget: { connId: "alice-tab", profileId: "alice" },
};
const steerer = {
  profileId: "bob",
  senderId: "bob-sender",
  name: "Bob",
  gatewayUiCommandTarget: { connId: "bob-tab", profileId: "bob" },
};
const identity = {
  agentId: "main",
  sessionKey: "agent:main:personal-tools",
  sessionId: "personal-tools",
};

describe("conversation environment presentation participants", () => {
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
    const clients: GatewayClient[] = [owner, steerer].map((person) => ({
      connId: person.gatewayUiCommandTarget.connId,
      authenticatedUserProfile: {
        profileId: person.profileId,
        displayName: person.name,
        hasAvatar: false,
        updatedAt: 1,
      },
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: GATEWAY_CLIENT_IDS.CONTROL_UI, version: "test", platform: "web", mode: "ui" },
        caps: [GATEWAY_CLIENT_CAPS.UI_COMMANDS],
      },
    }));
    const context = createDirectChatContext({
      getRuntimeConfig: () => support.testState.config,
      workerEnvironmentService: service,
      getClientConnIds: (filter) =>
        new Set(
          clients.filter((client) => !filter || filter(client)).map((client) => client.connId!),
        ),
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
    return { call, respond, create, provision, service, context };
  }

  it.each(["desktop", "portal"] as const)(
    "rejects ambiguous %s presentation before creating an environment, but permits creation without presentation",
    async (presentation) => {
      const test = fixture();
      await withPersonalToolTurn({ owner }, async (turn) => {
        expect(await turn.steer(steerer)).toMatchObject({ status: "accepted" });
        await test.call(presentation);
        expect(test.create).not.toHaveBeenCalled();
        expect(test.provision).not.toHaveBeenCalled();
        expect(test.context.broadcastToConnIds).not.toHaveBeenCalled();
        expect(test.respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            message: expect.stringMatching(
              /without presentation.*screen.*desktop_show.*portal_show.*environmentId.*requester_profile.id/s,
            ),
          }),
        );
        await test.call();
        expect(test.respond).toHaveBeenLastCalledWith(
          true,
          expect.objectContaining({
            environment: expect.objectContaining({ status: "available" }),
          }),
        );
        expect(test.provision).toHaveBeenCalledOnce();
      });
    },
  );

  it("presents a single-owner environment only in that owner's connection", async () => {
    const test = fixture();
    await withPersonalToolTurn({ owner }, () => test.call("desktop"));
    expect(test.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ environment: expect.objectContaining({ status: "available" }) }),
    );
    expect(test.context.broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
      "ui.command",
      expect.objectContaining({
        command: expect.objectContaining({ panel: "desktop", open: true }),
      }),
      new Set(["alice-tab"]),
    );
    expect(test.provision).toHaveBeenCalledOnce();
  });

  it("reports dispatch-time ambiguity and cancels the reserved environment before allocation", async () => {
    const test = fixture();
    await withPersonalToolTurn({ owner }, async (turn) => {
      const reserve = support.testState.store.createSessionAttachmentIntent.bind(
        support.testState.store,
      );
      vi.spyOn(support.testState.store, "createSessionAttachmentIntent").mockImplementation(
        async (...args) => {
          const reservation = await reserve(...args);
          expect(await turn.steer(steerer)).toMatchObject({ status: "accepted" });
          return reservation;
        },
      );
      await test.call("portal");
      expect(test.create).toHaveBeenCalledOnce();
      expect(test.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringMatching(/Several people.*Alice.*Bob/s) }),
      );
      expect(test.context.broadcastToConnIds).not.toHaveBeenCalled();
      expect(test.provision).not.toHaveBeenCalled();
      const result = test.service.getSessionAttachmentStatus(identity.sessionId)!;
      expect(result.attachment.closedAtMs).not.toBeNull();
      expect(result.environment.state).toBe("failed");
    });
  });
});
