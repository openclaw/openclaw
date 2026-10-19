import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.native.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { resolveSessionEnvironmentCaller } from "./environments.session.js";
import { captureGatewayRequestOperatorGuard } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

it.each(["agent", "sandbox"] as const)(
  "preserves named administrator access despite a restrictive role %s ceiling",
  async (restriction) => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const cfg = rolePolicyConfig();
      cfg.gateway!.roles!.definitions.view = {
        sessions: { others: "view" },
        agents: restriction === "agent" ? ["another-agent"] : ["main"],
        sandbox: restriction === "sandbox" ? "required" : "inherit",
        scopes: ["operator.admin"],
      };
      setRuntimeConfigSnapshot(cfg);
      const client = roleClient("view", "environment-administrator");
      client.connect.scopes = ["operator.admin"];
      const identity = { agentId: "main", sessionKey: "agent:main:admin-worker" };
      await upsertSessionEntryCore(identity, {
        sessionId: "admin-worker",
        updatedAt: 1,
        createdActor: {
          type: "human",
          source: "profile",
          id: client.authenticatedUserProfile!.profileId,
        },
      });
      const options: GatewayRequestHandlerOptions = {
        req: { type: "req", id: "admin-command", method: "environments.session.exec" },
        params: identity,
        client,
        context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
        respond: vi.fn(),
        isWebchatConnect: () => false,
      };
      options.sessionMutationCommitGuard = captureGatewayRequestOperatorGuard(options);
      const caller = await resolveSessionEnvironmentCaller(options, identity, true);
      try {
        expect(caller.identity.sessionId).toBe("admin-worker");
        expect(caller.assertCurrent).not.toThrow();
        client.invalidated = true;
        expect(caller.assertCurrent).toThrow();
      } finally {
        caller.release();
      }
    });
  },
);

it.each(["membership", "agent", "sandbox", "scope", "connection"] as const)(
  "revalidates a raw worker operator's %s authority on the actual session",
  async (revocation) => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      let cfg = rolePolicyConfig();
      cfg.gateway!.roles!.definitions.view = {
        sessions: { others: "view" },
        agents: ["main"],
        sandbox: "inherit",
        scopes: ["operator.write", "operator.workers"],
      };
      setRuntimeConfigSnapshot(cfg);
      const owner = roleClient("write", "environment-owner");
      const client = roleClient("view", "environment-member");
      client.connect.scopes = ["operator.write", "operator.workers"];
      const identity = { agentId: "main", sessionKey: "agent:main:attached-worker" };
      const ownerId = owner.authenticatedUserProfile!.profileId;
      const memberId = client.authenticatedUserProfile!.profileId;
      await upsertSessionEntryCore(identity, {
        sessionId: "attached-worker",
        updatedAt: 1,
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: ownerId },
      });
      const options: GatewayRequestHandlerOptions = {
        req: { type: "req", id: "worker-command", method: "environments.session.exec" },
        params: identity,
        client,
        context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
        respond: vi.fn(),
        isWebchatConnect: () => false,
      };
      options.sessionMutationCommitGuard = captureGatewayRequestOperatorGuard(options);
      await expect(resolveSessionEnvironmentCaller(options, identity, true)).rejects.toThrow();
      addSessionMember(identity, {
        identityId: memberId,
        addedBy: ownerId,
        expectedSessionId: "attached-worker",
      });
      const caller = await resolveSessionEnvironmentCaller(options, identity, true);
      try {
        expect(caller.identity.sessionId).toBe("attached-worker");
        expect(caller.assertCurrent).not.toThrow();
        if (revocation === "membership") {
          removeSessionMember(identity, memberId, undefined, "attached-worker");
        } else if (revocation === "connection") {
          client.invalidated = true;
        } else {
          cfg = structuredClone(cfg);
          if (revocation === "agent") {
            cfg.gateway!.roles!.definitions.view!.agents = ["another-agent"];
          } else if (revocation === "scope") {
            cfg.gateway!.roles!.definitions.view!.scopes = ["operator.write"];
          } else {
            cfg.gateway!.roles!.definitions.view!.sandbox = "required";
          }
          setRuntimeConfigSnapshot(cfg);
        }
        expect(caller.assertCurrent).toThrow();
        await expect(resolveSessionEnvironmentCaller(options, identity, true)).rejects.toThrow();
        if (revocation === "agent" || revocation === "sandbox") {
          // Reading status remains available; only machine effects need run admission.
          const reader = await resolveSessionEnvironmentCaller(options, identity);
          reader.release();
        }
      } finally {
        caller.release();
      }
    });
  },
);
