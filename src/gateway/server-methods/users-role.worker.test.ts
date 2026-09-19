import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { onUserProfilesChanged } from "../../state/user-profile-events.js";
import {
  readUserProfileIdentity,
  retainUserProfileCatalog,
} from "../../state/user-profile-list.js";
import {
  ensureGatewayOwnerProfile,
  ensureProfileForEmail,
  getUserProfileRole,
} from "../../state/user-profiles.js";
import { seedProfileForRole, seedUserProfileRole } from "../../state/user-profiles.test-support.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readGatewayAccessRevision } from "../gateway-access-revision.js";
import { resolveOperatorRolePolicyForProfile } from "../operator-role-policy.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createGatewayRequestContext } from "../server-request-context.js";
import { makeContextParams } from "../server-request-context.test-support.js";
import { createRequiredSharedGatewaySessionGenerationReader } from "../server-shared-auth-generation.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "../server/ws-connection/authenticated-request-dispatch.test-support.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { usersHandlers } from "./users.js";

const boundary = vi.hoisted(() => ({
  onAdmission: undefined as ((stage: string) => void) | undefined,
  afterRoleResult: undefined as (() => Promise<void>) | undefined,
  sourceIdentityFailure: undefined as Error | undefined,
}));
vi.mock("../../infra/sqlite-worker-identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/sqlite-worker-identity.js")>();
  return {
    ...actual,
    assertExistingDatabaseIdentity: (
      ...args: Parameters<typeof actual.assertExistingDatabaseIdentity>
    ) => {
      if (boundary.sourceIdentityFailure) {
        throw boundary.sourceIdentityFailure;
      }
      actual.assertExistingDatabaseIdentity(...args);
    },
  };
});
vi.mock("../../infra/sqlite-worker-operation-admission.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../infra/sqlite-worker-operation-admission.js")>();
  return {
    ...actual,
    createSqliteWorkerOperationAdmission: (
      admit: Parameters<typeof actual.createSqliteWorkerOperationAdmission>[0],
    ) =>
      actual.createSqliteWorkerOperationAdmission((request, grant) => {
        // Observe the real worker message without replacing the owner or its grant.
        if (
          request.facts === "profile-role" ||
          (typeof request.facts === "object" &&
            request.facts !== null &&
            "kind" in request.facts &&
            request.facts.kind === "profile-role")
        ) {
          boundary.onAdmission?.(request.stage);
        }
        admit(request, grant);
      }),
  };
});

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
  boundary.onAdmission = undefined;
  boundary.afterRoleResult = undefined;
  boundary.sourceIdentityFailure = undefined;
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

function profileClient(profileId: string, connId: string, close = vi.fn()): GatewayWsClient {
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

async function fixture() {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "users-role-rpc-" });
  const requester = seedProfileForRole("administrator@example.test", "administrator");
  const target = ensureProfileForEmail("reader@example.test");
  const config = roleConfig();
  const clientClose = vi.fn();
  const targetClose = vi.fn();
  const client = profileClient(requester.id, "role-requester", clientClose);
  const targetClient = profileClient(target.id, "role-target", targetClose);
  const clients = new Set([client, targetClient]);
  const ownedContext = createGatewayRequestContext(makeContextParams({ clients }));
  const context = createDirectChatContext({
    getRuntimeConfig: () => config,
    isConnectionActive: (connId) => [...clients].some((entry) => entry.connId === connId),
    getClientConnIds: ownedContext.getClientConnIds,
    disconnectClientsForUserProfile: ownedContext.disconnectClientsForUserProfile,
  });
  const generation = { current: "generation-a", required: null };
  const harness = createDispatchTestHarness({
    connId: client.connId,
    getRequiredSharedGatewaySessionGeneration:
      createRequiredSharedGatewaySessionGenerationReader(generation),
    buildRequestContext: () => context,
    extraHandlers: usersHandlers,
  });
  let sequence = 0;
  return {
    state,
    requester,
    target,
    config,
    client,
    targetClient,
    clientClose,
    targetClose,
    generation,
    harness,
    context,
    clients,
    dispatch(profileId: string, role: string | null) {
      const id = `role-${++sequence}`;
      return {
        id,
        done: harness.dispatcher.dispatch(
          {
            type: "req",
            id,
            method: "users.setRole",
            expectedProfileId: requester.id,
            params: { profileId, role },
          },
          client,
        ),
      };
    },
  };
}

describe("registered users.setRole worker mutation", () => {
  it("preserves the missing-profile error when the worker creates the first state database", async () => {
    const state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "users-role-cold-",
    });
    const close = vi.fn();
    const client: GatewayWsClient = {
      ...createOperatorWsClient({ connId: "cold-role-requester", socket: { close } }),
      usesSharedGatewayAuth: true,
      sharedGatewaySessionGeneration: "generation-a",
      internal: { operatorRoleActor: { kind: "system" } },
    };
    const disconnectClientsForUserProfile = vi.fn();
    const config = roleConfig();
    const context = createDirectChatContext({
      getRuntimeConfig: () => config,
      isConnectionActive: (connId) => connId === client.connId,
      getClientConnIds: () => new Set([client.connId]),
      disconnectClientsForUserProfile,
    });
    const harness = createDispatchTestHarness({
      connId: client.connId,
      getRequiredSharedGatewaySessionGeneration: createRequiredSharedGatewaySessionGenerationReader(
        { current: "generation-a", required: null },
      ),
      buildRequestContext: () => context,
      extraHandlers: usersHandlers,
    });
    const stages: string[] = [];
    boundary.onAdmission = (stage) => stages.push(stage);
    try {
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
      expect(stages).toEqual(["prepare", "transaction", "commit"]);
      expect(harness.send).toHaveBeenCalledOnce();
      expect(await harness.awaitResponseFrame("cold-missing-role")).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST", message: "user profile not found: missing-cold-profile" },
      });
      expect(disconnectClientsForUserProfile).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(client.invalidated).not.toBe(true);
    } finally {
      await state.cleanup();
    }
  });

  it("publishes assignments and clears, invalidates cached policy, and closes affected clients before replying", async () => {
    const f = await fixture();
    const release = retainUserProfileCatalog();
    const events: string[] = [];
    const published: Array<string | null | undefined> = [];
    let desired: string | null = "reader";
    let revision = readGatewayAccessRevision();
    const stop = onUserProfilesChanged(() => {
      published.push(readUserProfileIdentity(f.target.id)?.role);
      events.push("published");
    });
    const stages: string[] = [];
    boundary.onAdmission = (stage) => stages.push(stage);
    vi.mocked(f.targetClose).mockImplementation(() => {
      expect(f.targetClient.invalidated).toBe(true);
      expect(f.targetClient.invalidatedReason).toBe("operator-role-changed");
      expect(readUserProfileIdentity(f.target.id)?.role).toBe(desired);
      expect(readGatewayAccessRevision()).toBeGreaterThan(revision);
      const policy = resolveOperatorRolePolicyForProfile(f.target.id, f.config);
      expect(policy?.scopes).toEqual(desired === "reader" ? ["operator.read"] : []);
      events.push("closed");
    });
    f.harness.send.mockImplementation(() => {
      events.push("response");
      return { kind: "sent" };
    });
    try {
      // Prime the actual assignment cache; publication must evict this previous role.
      expect(resolveOperatorRolePolicyForProfile(f.target.id, f.config)?.scopes).toEqual([]);
      for (const role of ["reader", null]) {
        desired = role;
        revision = readGatewayAccessRevision();
        events.length = 0;
        const request = f.dispatch(f.target.id, role);
        await request.done;
        expect(await f.harness.awaitResponseFrame(request.id)).toMatchObject({
          ok: true,
          payload: { profile: { id: f.target.id, ...(role ? { role } : {}) } },
        });
        if (role === null) {
          expect((await f.harness.awaitResponseFrame(request.id)).payload).toEqual({
            profile: expect.not.objectContaining({ role: expect.anything() }),
          });
        }
        expect(getUserProfileRole(f.target.id)).toBe(role);
        expect(events).toEqual(["published", "closed", "response"]);
      }
      expect(published).toEqual(["reader", null]);
      expect(stages).toEqual([
        "prepare",
        "transaction",
        "commit",
        "prepare",
        "transaction",
        "commit",
      ]);
      expect(f.client.invalidated).not.toBe(true);
    } finally {
      stop();
      release();
      await f.state.cleanup();
    }
  });

  it("rejects a cached administrator after a durable downgrade whose host receipt is still pending", async () => {
    const f = await fixture();
    const administrator = ensureProfileForEmail("other-administrator@example.test");
    seedUserProfileRole(administrator.id, "administrator");
    const adminClient = profileClient(administrator.id, "other-administrator");
    f.clients.add(adminClient);
    const adminHarness = createDispatchTestHarness({
      connId: adminClient.connId,
      getRequiredSharedGatewaySessionGeneration: createRequiredSharedGatewaySessionGenerationReader(
        f.generation,
      ),
      buildRequestContext: () => f.context,
      extraHandlers: usersHandlers,
    });
    const releaseCatalog = retainUserProfileCatalog();
    const received = createDeferredCore();
    const resume = createDeferredCore();
    let firstResult = true;
    let downgrade: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    boundary.afterRoleResult = async () => {
      if (!firstResult) {
        return;
      }
      firstResult = false;
      received.resolve();
      await resume.promise;
    };
    try {
      expect(resolveOperatorRolePolicyForProfile(f.requester.id, f.config)?.scopes).toEqual([
        "operator.admin",
      ]);
      downgrade = adminHarness.dispatcher.dispatch(
        {
          type: "req",
          id: "downgrade-requester",
          method: "users.setRole",
          expectedProfileId: administrator.id,
          params: { profileId: f.requester.id, role: "reader" },
        },
        adminClient,
      );
      await Promise.race([
        received.promise,
        downgrade.then(() => {
          throw new Error("Downgrade returned without reaching the retained worker receipt");
        }),
      ]);
      expect(getUserProfileRole(f.requester.id)).toBe("reader");
      expect(readUserProfileIdentity(f.requester.id)?.role).toBe("administrator");
      expect(resolveOperatorRolePolicyForProfile(f.requester.id, f.config)?.scopes).toEqual([
        "operator.admin",
      ]);
      expect(f.client.invalidated).not.toBe(true);
      expect(f.client.connect.scopes).toEqual(["operator.admin"]);
      expect(adminHarness.send).not.toHaveBeenCalled();

      const stages: string[] = [];
      boundary.onAdmission = (stage) => stages.push(stage);
      const request = f.dispatch(f.target.id, "reader");
      second = request.done;
      await second;
      expect(stages).toEqual(["prepare", "transaction"]);
      expect(await f.harness.awaitResponseFrame(request.id)).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN", message: "missing scope: operator.admin" },
      });
      expect(getUserProfileRole(f.target.id)).toBeNull();
      expect(f.targetClose).not.toHaveBeenCalled();
      expect(f.client.invalidated).not.toBe(true);

      resume.resolve();
      await downgrade;
      expect(await adminHarness.awaitResponseFrame("downgrade-requester")).toMatchObject({
        ok: true,
        payload: { profile: { id: f.requester.id, role: "reader" } },
      });
      expect(f.client.invalidated).toBe(true);
      expect(f.clientClose).toHaveBeenCalledWith(4001, "operator role changed");
      expect(readUserProfileIdentity(f.requester.id)?.role).toBe("reader");
      expect(resolveOperatorRolePolicyForProfile(f.requester.id, f.config)?.scopes).toEqual([
        "operator.read",
      ]);
    } finally {
      resume.resolve();
      await Promise.allSettled([downgrade, second]);
      releaseCatalog();
      await f.state.cleanup();
    }
  });

  it("retires committed role authority before source validation recovery can complete", async () => {
    const f = await fixture();
    seedUserProfileRole(f.target.id, "administrator");
    const database = openOpenClawStateDatabase();
    const releaseCatalog = retainUserProfileCatalog();
    const changed = vi.fn();
    const stop = onUserProfilesChanged(changed);
    const accessRevision = readGatewayAccessRevision();
    const failure = new Error("synthetic settlement source validation failure");
    boundary.afterRoleResult = async () => {
      // A source-validation fault after a real commit, not a physical-file replacement.
      boundary.sourceIdentityFailure = failure;
    };
    try {
      const request = f.dispatch(f.target.id, "reader");
      await request.done;
      expect(boundary.sourceIdentityFailure).toBe(failure);
      expect(
        database.db.prepare("SELECT role FROM user_profiles WHERE id = ?").get(f.target.id),
      ).toMatchObject({ role: "reader" });
      expect(readUserProfileIdentity(f.target.id)?.role).toBe("administrator");
      expect(await f.harness.awaitResponseFrame(request.id)).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE" },
      });
      await expect(closeOpenClawStateDatabaseByPathAsync(database.path)).rejects.toThrow();
      expect(changed).not.toHaveBeenCalled();
      expect(f.targetClient.invalidated).toBe(true);
      expect(f.targetClient.invalidatedReason).toBe("operator-role-changed");
      expect(f.targetClose).toHaveBeenCalledExactlyOnceWith(4001, "operator role changed");
      expect(readGatewayAccessRevision()).toBe(accessRevision + 1);

      boundary.sourceIdentityFailure = undefined;
      await closeOpenClawStateDatabaseByPathAsync(database.path);
      expect(readUserProfileIdentity(f.target.id)?.role).toBe("reader");
      expect(changed).toHaveBeenCalledOnce();
      expect(f.targetClose).toHaveBeenCalledOnce();
      expect(readGatewayAccessRevision()).toBe(accessRevision + 1);
    } finally {
      boundary.sourceIdentityFailure = undefined;
      await closeOpenClawStateDatabaseByPathAsync(database.path);
      stop();
      releaseCatalog();
      await f.state.cleanup();
    }
  });

  it.each(["owner", "owner alias", "missing", "unknown role"] as const)(
    "returns the existing %s error without publishing or disconnecting",
    async (scenario) => {
      const f = await fixture();
      let profileId = f.target.id;
      let role = "reader";
      if (scenario === "owner" || scenario === "owner alias") {
        profileId = ensureGatewayOwnerProfile("Owner").id;
        if (scenario === "owner alias") {
          openOpenClawStateDatabase()
            .db.prepare(
              "INSERT INTO user_profiles (id, merged_into, created_at, updated_at) VALUES (?, ?, 1, 1)",
            )
            .run("retired-owner", profileId);
          profileId = "retired-owner";
        }
      } else if (scenario === "missing") {
        profileId = "missing-profile";
      } else {
        role = "undefined-role";
      }
      const changed = vi.fn();
      const stop = onUserProfilesChanged(changed);
      try {
        const request = f.dispatch(profileId, role);
        await request.done;
        expect(await f.harness.awaitResponseFrame(request.id)).toMatchObject({
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message: expect.stringContaining(
              scenario.startsWith("owner")
                ? "shared owner profile"
                : scenario === "missing"
                  ? "missing-profile"
                  : "unknown operator role",
            ),
          },
        });
        expect(getUserProfileRole(f.target.id)).toBeNull();
        expect(changed).not.toHaveBeenCalled();
        expect(f.targetClose).not.toHaveBeenCalled();
      } finally {
        stop();
        await f.state.cleanup();
      }
    },
  );

  it("commits an authorized self-downgrade before retiring the requesting connection", async () => {
    const f = await fixture();
    const stages: string[] = [];
    boundary.onAdmission = (stage) => stages.push(stage);
    try {
      const request = f.dispatch(f.requester.id, "reader");
      await request.done;
      expect(getUserProfileRole(f.requester.id)).toBe("reader");
      expect(stages).toEqual(["prepare", "transaction", "commit"]);
      expect(f.client.invalidated).toBe(true);
      expect(f.clientClose).toHaveBeenCalledWith(4001, "operator role changed");
      // The authenticated transport suppresses replies after this client's authority retires.
      expect(f.harness.send).not.toHaveBeenCalled();
      expect(f.targetClose).not.toHaveBeenCalled();
    } finally {
      await f.state.cleanup();
    }
  });

  it.each([
    { stage: "transaction", change: "scopes" },
    { stage: "commit", change: "scopes" },
    { stage: "commit", change: "definition" },
    { stage: "commit", change: "generation" },
  ] as const)(
    "rolls back when $change changes before the $stage grant",
    async ({ stage, change }) => {
      const f = await fixture();
      f.client.usesSharedGatewayAuth = true;
      f.client.sharedGatewaySessionGeneration = "generation-a";
      let changed = false;
      boundary.onAdmission = (observed) => {
        if (observed !== stage) {
          return;
        }
        changed = true;
        if (change === "scopes") {
          f.client.connect.scopes = ["operator.read"];
        } else if (change === "definition") {
          delete f.config.gateway!.roles!.definitions.reader;
        } else {
          f.generation.current = "generation-b";
        }
      };
      const published = vi.fn();
      const stop = onUserProfilesChanged(published);
      try {
        const request = f.dispatch(f.target.id, "reader");
        await request.done;
        expect(changed).toBe(true);
        expect(getUserProfileRole(f.target.id)).toBeNull();
        expect(published).not.toHaveBeenCalled();
        expect(f.targetClose).not.toHaveBeenCalled();
        if (change === "generation") {
          expect(f.harness.send).not.toHaveBeenCalled();
        } else {
          expect(await f.harness.awaitResponseFrame(request.id)).toMatchObject({ ok: false });
        }
      } finally {
        stop();
        await f.state.cleanup();
      }
    },
  );
});
