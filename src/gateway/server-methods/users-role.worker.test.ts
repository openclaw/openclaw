import { existsSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  readUserProfileIdentity,
  retainUserProfileCatalog,
} from "../../state/user-profile-list.js";
import {
  ensureProfileForEmail,
  getUserProfileRole,
  setUserProfileRole,
} from "../../state/user-profiles.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveOperatorRolePolicyForProfile } from "../operator-role-policy.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createGatewayRequestContext } from "../server-request-context.js";
import { makeContextParams } from "../server-request-context.test-support.js";
import { SharedGatewaySessionGenerationState } from "../server-shared-auth-generation.js";
import { GatewayClientRegistry } from "../server/client-registry.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "../server/ws-connection/authenticated-request-dispatch.test-support.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { usersHandlers } from "./users.js";

const boundary = vi.hoisted(() => ({
  afterRoleResult: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("../../state/openclaw-state-worker-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../state/openclaw-state-worker-store.js")>();
  return {
    ...actual,
    runOpenClawStateWorkerOperation: (
      context: Parameters<typeof actual.runOpenClawStateWorkerOperation>[0],
      operation: Parameters<typeof actual.runOpenClawStateWorkerOperation>[1],
      options: Parameters<typeof actual.runOpenClawStateWorkerOperation>[2],
    ) =>
      actual.runOpenClawStateWorkerOperation(
        context,
        (scope) =>
          operation({
            ...scope,
            execute: async (command, executeOptions) => {
              const result = await scope.execute(command, executeOptions);
              if (command.type === "userProfiles.setRole") {
                await boundary.afterRoleResult?.();
              }
              return result;
            },
          }),
        options,
      ),
  };
});

beforeEach(() => resetGatewayWorkAdmission());
afterEach(() => {
  boundary.afterRoleResult = undefined;
  vi.restoreAllMocks();
});

function roleConfig(): OpenClawConfig {
  return {
    gateway: {
      roles: {
        definitions: {
          administrator: { scopes: ["operator.admin"], agents: "*", sessions: { others: "write" } },
          reader: { scopes: ["operator.read"], agents: "*", sessions: { others: "none" } },
        },
      },
    },
  };
}

function profileClient(
  profileId: string,
  connId: string,
  close: ReturnType<typeof vi.fn>,
): GatewayWsClient {
  return {
    ...createOperatorWsClient({ connId, socket: { close } }),
    authenticatedUserProfile: {
      profileId,
      displayName: null,
      avatarRevision: "1",
      hasAvatar: false,
      updatedAt: 1,
    },
  };
}

it.each(["failed delivery", "self downgrade"] as const)(
  "retires role policy and connections through %s",
  async (scenario) => {
    const state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "users-role-delivery-",
    });
    let release = () => {};
    try {
      const requester = ensureProfileForEmail("administrator@example.test");
      setUserProfileRole(requester.id, "administrator");
      const target = ensureProfileForEmail("reader@example.test");
      setUserProfileRole(target.id, "administrator");
      const changed = scenario === "self downgrade" ? requester : target;
      expect(resolveOperatorRolePolicyForProfile(changed.id, roleConfig())?.scopes).toEqual([
        "operator.admin",
      ]);
      release = retainUserProfileCatalog();
      const clientClose = vi.fn();
      const targetClose = vi.fn();
      const client = profileClient(requester.id, "role-requester", clientClose);
      const targetClient = profileClient(target.id, "role-target", targetClose);
      const clients = new GatewayClientRegistry([client, targetClient]);
      const owner = createGatewayRequestContext(makeContextParams({ clients }));
      const context = createDirectChatContext({
        getRuntimeConfig: roleConfig,
        isConnectionActive: (connId) => [...clients].some((entry) => entry.connId === connId),
        getClientConnIds: owner.getClientConnIds,
        disconnectClientsForUserProfile: owner.disconnectClientsForUserProfile,
      });
      const harness = createDispatchTestHarness({
        connId: client.connId,
        getRequiredSharedGatewaySessionGeneration: new SharedGatewaySessionGenerationState({
          current: "generation-a",
          required: null,
        }).reader,
        buildRequestContext: () => context,
        extraHandlers: usersHandlers,
      });
      if (scenario === "failed delivery") {
        boundary.afterRoleResult = async () => {
          throw new Error("synthetic committed role delivery failure");
        };
      }
      await harness.dispatcher.dispatch(
        {
          type: "req",
          id: "role-delivery",
          method: "users.setRole",
          expectedProfileId: requester.id,
          params: { profileId: changed.id, role: "reader" },
        },
        client,
      );
      expect(getUserProfileRole(changed.id)).toBe("reader");
      expect(readUserProfileIdentity(changed.id)?.role).toBe("reader");
      expect(resolveOperatorRolePolicyForProfile(changed.id, roleConfig())?.scopes).toEqual([
        "operator.read",
      ]);
      expect(harness.send).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "role-delivery",
          ...(scenario === "self downgrade"
            ? {
                ok: true,
                payload: expect.objectContaining({
                  profile: expect.objectContaining({ id: requester.id, role: "reader" }),
                }),
              }
            : {
                ok: false,
                error: expect.objectContaining({
                  code: "UNAVAILABLE",
                  message: expect.stringContaining("synthetic committed role delivery failure"),
                }),
              }),
        }),
      );
      expect(scenario === "self downgrade" ? clientClose : targetClose).toHaveBeenCalledOnce();
      expect(scenario === "self downgrade" ? targetClose : clientClose).not.toHaveBeenCalled();
    } finally {
      release();
      await state.cleanup();
    }
  },
);

it("preserves the cold missing-profile RPC error without disconnecting a client", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "users-role-cold-" });
  try {
    const client: GatewayWsClient = {
      ...createOperatorWsClient({ connId: "cold-role-requester", socket: { close: vi.fn() } }),
      usesSharedGatewayAuth: true,
      sharedGatewaySessionGeneration: "generation-a",
      internal: { operatorRoleActor: { kind: "system" } },
    };
    const disconnectClientsForUserProfile = vi.fn();
    const context = createDirectChatContext({
      getRuntimeConfig: roleConfig,
      isConnectionActive: (connId) => connId === client.connId,
      getClientConnIds: () => new Set([client.connId]),
      disconnectClientsForUserProfile,
    });
    const harness = createDispatchTestHarness({
      connId: client.connId,
      getRequiredSharedGatewaySessionGeneration: new SharedGatewaySessionGenerationState({
        current: "generation-a",
        required: null,
      }).reader,
      buildRequestContext: () => context,
      extraHandlers: usersHandlers,
    });
    expect(existsSync(resolveOpenClawStateSqlitePath(state.env))).toBe(false);
    await harness.dispatcher.dispatch(
      {
        type: "req",
        id: "cold-missing-role",
        method: "users.setRole",
        params: { profileId: "missing-cold-profile", role: "reader" },
      },
      client,
    );
    expect(harness.send).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "cold-missing-role",
        ok: false,
        error: expect.objectContaining({
          code: "INVALID_REQUEST",
          message: expect.stringContaining("user profile not found"),
        }),
      }),
    );
    expect(disconnectClientsForUserProfile).not.toHaveBeenCalled();
  } finally {
    await state.cleanup();
  }
});
