import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { withForegroundPromotedCaller } from "../../agents/run-execution-policy.test-support.js";
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

  function fixture(session = identity) {
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
    const call = (
      presentation?: "desktop" | "portal",
      action: "create" | "status" | "destroy" = "create",
    ) =>
      withGatewayToolCallerIdentity(
        { ...session, assertToolAllowed: () => {}, gatewayContextResolver: () => context },
        () =>
          environmentsSessionHandlers[`environments.session.${action}`]!({
            req: {
              type: "req",
              id: "environment-preview",
              method: `environments.session.${action}`,
            },
            params:
              action === "create"
                ? {
                    profileId: "development",
                    idempotencyKey: "open-preview",
                    ...(presentation ? { presentation } : {}),
                  }
                : {},
            client: createSyntheticPluginRuntimeClient({ pluginRuntimeOwnerId: "crabbox" }),
            context,
            isWebchatConnect: () => false,
            respond,
          }),
      );
    return { call, respond, create, provision, service, context };
  }

  it.each(["role", "session"] as const)(
    "refuses foreground %s allocation while retaining status and destroy",
    async (restriction) => {
      const session = {
        ...identity,
        sessionKey:
          restriction === "role"
            ? "agent:main:main"
            : `agent:main:foreground-environment-${restriction}`,
        sessionId: `foreground-environment-${restriction}`,
      };
      ensureSessionEntrySync(
        { ...session, storePath: support.testState.config.session?.store },
        {
          sessionId: session.sessionId,
          updatedAt: 1,
          ...(restriction === "session" ? { execution: "foreground-only" as const } : {}),
        },
      );
      const test = fixture(session);
      const check = async () => {
        await test.call();
        expect(test.respond).toHaveBeenLastCalledWith(
          false,
          undefined,
          expect.objectContaining({
            message: expect.stringContaining("cannot outlive this foreground request"),
          }),
        );
        expect(test.create).not.toHaveBeenCalled();
        expect(test.provision).not.toHaveBeenCalled();
        await test.call(undefined, "status");
        expect(test.respond).toHaveBeenLastCalledWith(true, { attachment: null });
        await test.call(undefined, "destroy");
        expect(test.respond).toHaveBeenLastCalledWith(true, { stopped: true });
        expect(test.provision).not.toHaveBeenCalled();
      };
      if (restriction === "role") {
        await withForegroundPromotedCaller("role", check);
      } else {
        await withPersonalToolTurn({ owner, ...session }, check);
      }
    },
  );

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
