import { existsSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  readResidentUserProfileIdentity,
  prepareUserProfileCatalog,
} from "../../state/user-profile-list.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail } from "../../state/user-profiles.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveOperatorRolePolicyForProfile } from "../operator-role-policy.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createGatewayRequestContext } from "../server-request-context.js";
import { makeContextParams } from "../server-request-context.test-support.js";
import { SharedGatewaySessionGenerationState } from "../server-shared-auth-generation.js";
import { dispatchProfile } from "../server/client-fixtures.test-support.js";
import { GatewayClientRegistry } from "../server/client-registry.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "../server/ws-connection/authenticated-request-dispatch.test-support.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { listSystemChanges, systemChangesHandlers } from "./system-changes.js";
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
        default: "reader",
        definitions: {
          administrator: { scopes: ["operator.admin"], agents: "*", sessions: { others: "write" } },
          deputy: { scopes: ["operator.admin"], agents: "*", sessions: { others: "view" } },
          reader: { scopes: ["operator.read"], agents: "*", sessions: { others: "none" } },
          'night "ops"': { scopes: ["operator.read"], agents: "*", sessions: { others: "none" } },
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
    authenticatedUserProfile: dispatchProfile(profileId),
  };
}

// Demoting yourself out of operator.admin is refused, so the self case moves between admin roles.
it.each(["failed delivery", "self role change"] as const)(
  "retires role policy and connections through %s",
  async (scenario) => {
    const state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "users-role-delivery-",
      prepareProfileCatalog: true,
    });
    let release = () => {};
    try {
      const requester = ensureProfileForEmail("administrator@example.test");
      setUserProfileRole(requester.id, "administrator");
      const target = ensureProfileForEmail("reader@example.test");
      setUserProfileRole(target.id, "administrator");
      const self = scenario === "self role change";
      const changed = self ? requester : target;
      const nextRole = self ? "deputy" : "reader";
      release = (await prepareUserProfileCatalog()).release;
      expect(resolveOperatorRolePolicyForProfile(changed.id, roleConfig())?.scopes).toEqual([
        "operator.admin",
      ]);
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
          params: { profileId: changed.id, role: nextRole },
        },
        client,
      );
      expect(readResidentUserProfileIdentity(changed.id)?.role).toBe(nextRole);
      expect(resolveOperatorRolePolicyForProfile(changed.id, roleConfig())?.scopes).toEqual([
        self ? "operator.admin" : "operator.read",
      ]);
      expect(await harness.awaitResponseFrame("role-delivery")).toMatchObject(
        self
          ? { ok: true, payload: { profile: { id: requester.id, role: nextRole } } }
          : {
              ok: false,
              error: {
                code: "UNAVAILABLE",
                message: expect.stringContaining("synthetic committed role delivery failure"),
              },
            },
      );
      expect(self ? clientClose : targetClose).toHaveBeenCalledOnce();
      expect(self ? targetClose : clientClose).not.toHaveBeenCalled();
      // A committed role is history even when its RPC result could not be delivered.
      expect((await listSystemChanges({})).entries).toEqual([
        expect.objectContaining({
          kind: "operation",
          source: "config-rpc",
          summary: `Role for profile ${changed.id} changed from "administrator" to "${nextRole}" by profile ${requester.id}`,
        }),
      ]);
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
    expect(await harness.awaitResponseFrame("cold-missing-role")).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: expect.stringContaining("user profile not found"),
      },
    });
    expect(disconnectClientsForUserProfile).not.toHaveBeenCalled();
  } finally {
    await state.cleanup();
  }
});

it("lists committed role assignments, not refused or unchanged ones, in change history", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "users-role-history-",
    prepareProfileCatalog: true,
  });
  let release = () => {};
  try {
    const requester = ensureProfileForEmail("administrator@example.test");
    setUserProfileRole(requester.id, "administrator");
    const target = ensureProfileForEmail("reader@example.test");
    ensureGatewayOwnerProfile("Owner");
    release = (await prepareUserProfileCatalog()).release;
    const client = profileClient(requester.id, "role-history-requester", vi.fn());
    const clients = new GatewayClientRegistry([client]);
    const owner = createGatewayRequestContext(makeContextParams({ clients }));
    const context = createDirectChatContext({
      getRuntimeConfig: roleConfig,
      isConnectionActive: (connId) => connId === client.connId,
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
      extraHandlers: { ...usersHandlers, ...systemChangesHandlers },
    });
    const request = async (id: string, method: string, params: Record<string, unknown>) => {
      await harness.dispatcher.dispatch(
        { type: "req", id, method, expectedProfileId: requester.id, params },
        client,
      );
      return await harness.awaitResponseFrame(id);
    };
    const setRole = (id: string, profileId: string, role: string | null) =>
      request(id, "users.setRole", { profileId, role });

    // A quoted role name stays unambiguous in the summary.
    const role = 'night "ops"';
    expect(await setRole("assign", target.id, role)).toMatchObject({ ok: true });
    expect(await setRole("repeat", target.id, role)).toMatchObject({ ok: true });
    expect(await setRole("unknown-role", target.id, "ghost")).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('unknown operator role "ghost"') },
    });
    expect(await setRole("owner", GATEWAY_OWNER_PROFILE_ID, "reader")).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("not governed by operator roles") },
    });
    expect(await setRole("clear", target.id, null)).toMatchObject({ ok: true });
    expect(readResidentUserProfileIdentity(target.id)?.role ?? null).toBeNull();

    const history = await request("history", "openclaw.changes.list", { limit: 10 });
    expect(history).toMatchObject({ ok: true });
    const by = `by profile ${requester.id}`;
    expect((history.payload as { entries: unknown[] }).entries).toEqual([
      expect.objectContaining({
        kind: "operation",
        source: "config-rpc",
        summary: `Role for profile ${target.id} cleared (was "night \\"ops\\"") ${by}`,
      }),
      expect.objectContaining({
        kind: "operation",
        source: "config-rpc",
        summary: `Role for profile ${target.id} changed from no role to "night \\"ops\\"" ${by}`,
      }),
    ]);
  } finally {
    release();
    await state.cleanup();
  }
});
