import { afterAll, afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { GatewayResourceRef } from "./contracts.js";
import {
  createAuthorizationDelegation,
  revokeAuthorizationDelegation,
} from "./delegations.test-support.js";
import {
  getAuthorizationResourceParent,
  getAuthorizationResourceOwner,
  listAuthorizationResourceChildren,
  prepareAuthorizationResourceRegistration,
  prepareAuthorizationResourceRetirement,
  replayAuthorizationResourceOperation,
} from "./resource-operations.js";
import { createStateGatewayAuthorizationRuntime } from "./state-provider.js";
import {
  bindAuthorizationResource,
  addIsolationDomainMember,
  createIsolationDomain,
  putAuthorizationPrincipal,
  removeIsolationDomainMember,
  retireAuthorizationResource,
} from "./state-store.js";

const tempDirs: string[] = [];
const resource: GatewayResourceRef = {
  namespace: "workspaces",
  type: "tab",
  id: "tab-shared-id",
};
const firstOwner = {
  id: "principal-owner-1",
  principal: { issuer: "trusted-proxy", subject: "owner-1@example.com", kind: "human" },
} as const;
const secondOwner = {
  id: "principal-owner-2",
  principal: { issuer: "trusted-proxy", subject: "owner-2@example.com", kind: "human" },
} as const;
const agent = {
  id: "principal-agent",
  principal: { issuer: "core", subject: "agent:main", kind: "service" },
} as const;

function createDatabase() {
  return { path: `${makeTempDir(tempDirs, "openclaw-rbac-operations-")}/openclaw.sqlite` };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

afterAll(() => {
  cleanupTempDirs(tempDirs);
});

describe("authorization resource operations", () => {
  it("returns the active owner for the requested domain when opaque IDs collide", () => {
    const database = createDatabase();
    for (const [domainId, owner] of [
      ["domain-1", firstOwner],
      ["domain-2", secondOwner],
    ] as const) {
      putAuthorizationPrincipal({ ...owner, database });
      createIsolationDomain({ id: domainId, ownerPrincipalId: owner.id, database });
      bindAuthorizationResource({
        domainId,
        resource,
        ownerPrincipalId: owner.id,
        database,
      });
    }

    expect(getAuthorizationResourceOwner({ domainId: "domain-1", resource, database })).toEqual({
      principalId: firstOwner.id,
    });
    expect(getAuthorizationResourceOwner({ domainId: "domain-2", resource, database })).toEqual({
      principalId: secondOwner.id,
    });
  });

  it("returns only the active resource parent in the requested domain", () => {
    const database = createDatabase();
    putAuthorizationPrincipal({ ...firstOwner, database });
    createIsolationDomain({ id: "domain-1", ownerPrincipalId: firstOwner.id, database });
    const workspace = {
      namespace: "workspaces",
      type: "workspace",
      id: "workspace-1",
    } as const;
    bindAuthorizationResource({
      domainId: "domain-1",
      resource: workspace,
      ownerPrincipalId: firstOwner.id,
      database,
    });
    bindAuthorizationResource({
      domainId: "domain-1",
      resource,
      parent: workspace,
      ownerPrincipalId: firstOwner.id,
      database,
    });

    expect(getAuthorizationResourceParent({ domainId: "domain-1", resource, database })).toEqual(
      workspace,
    );
    expect(
      getAuthorizationResourceParent({ domainId: "missing-domain", resource, database }),
    ).toBeUndefined();
    expect(
      getAuthorizationResourceParent({ domainId: "domain-1", resource: workspace, database }),
    ).toBeNull();
    retireAuthorizationResource({
      domainId: "domain-1",
      resource,
      retiredByPrincipalId: firstOwner.id,
      database,
    });
    expect(
      getAuthorizationResourceParent({ domainId: "domain-1", resource, database }),
    ).toBeUndefined();
  });

  it("lists exact active children and parent-binds retirement through replay", () => {
    const database = createDatabase();
    putAuthorizationPrincipal({ ...firstOwner, database });
    createIsolationDomain({ id: "domain-1", ownerPrincipalId: firstOwner.id, database });
    const workspace = { namespace: "workspaces", type: "workspace", id: "workspace-1" } as const;
    const otherWorkspace = { ...workspace, id: "workspace-2" };
    for (const parent of [workspace, otherWorkspace]) {
      bindAuthorizationResource({
        domainId: "domain-1",
        resource: parent,
        ownerPrincipalId: firstOwner.id,
        database,
      });
    }
    bindAuthorizationResource({
      domainId: "domain-1",
      resource,
      parent: workspace,
      ownerPrincipalId: firstOwner.id,
      database,
    });

    expect(
      listAuthorizationResourceChildren({
        domainId: "domain-1",
        parent: workspace,
        type: "tab",
        database,
      }),
    ).toEqual([resource]);
    expect(() =>
      prepareAuthorizationResourceRetirement({
        operationScope: "plugin:workspaces",
        idempotencyKey: "retire-wrong-parent",
        domainId: "domain-1",
        resource,
        parent: otherWorkspace,
        actorPrincipalId: firstOwner.id,
        database,
      }),
    ).toThrow(/parent does not match/i);

    const prepared = prepareAuthorizationResourceRetirement({
      operationScope: "plugin:workspaces",
      idempotencyKey: "retire-tab-1",
      domainId: "domain-1",
      resource,
      parent: workspace,
      actorPrincipalId: firstOwner.id,
      database,
    });
    replayAuthorizationResourceOperation({
      domainId: "domain-1",
      operationScope: "plugin:workspaces",
      operationId: prepared.operationId,
      database,
    });
    expect(
      listAuthorizationResourceChildren({ domainId: "domain-1", parent: workspace, database }),
    ).toEqual([]);
  });

  it("deduplicates an exact registration intent without binding the resource", () => {
    const database = createDatabase();
    putAuthorizationPrincipal({ ...firstOwner, database });
    createIsolationDomain({
      id: "domain-1",
      ownerPrincipalId: firstOwner.id,
      database,
    });
    const input = {
      operationScope: "plugin:workspaces",
      idempotencyKey: "create-tab-1",
      domainId: "domain-1",
      resource,
      actor: { kind: "human" as const, principalId: firstOwner.id },
      database,
    };

    const first = prepareAuthorizationResourceRegistration(input);
    const duplicate = prepareAuthorizationResourceRegistration(input);

    expect(first).toEqual({ operationId: expect.any(String), state: "pending" });
    expect(duplicate).toEqual(first);
    expect(
      getAuthorizationResourceOwner({ domainId: "domain-1", resource, database }),
    ).toBeUndefined();
  });

  it("scopes idempotency keys by isolation domain", () => {
    const database = createDatabase();
    for (const [domainId, owner] of [
      ["domain-1", firstOwner],
      ["domain-2", secondOwner],
    ] as const) {
      putAuthorizationPrincipal({ ...owner, database });
      createIsolationDomain({ id: domainId, ownerPrincipalId: owner.id, database });
    }

    const first = prepareAuthorizationResourceRegistration({
      operationScope: "plugin:workspaces",
      idempotencyKey: "create-tab-1",
      domainId: "domain-1",
      resource,
      actor: { kind: "human", principalId: firstOwner.id },
      database,
    });
    const second = prepareAuthorizationResourceRegistration({
      operationScope: "plugin:workspaces",
      idempotencyKey: "create-tab-1",
      domainId: "domain-2",
      resource,
      actor: { kind: "human", principalId: secondOwner.id },
      database,
    });

    expect(second.operationId).not.toBe(first.operationId);
  });

  it("replays a prepared registration idempotently without a user session", () => {
    const database = createDatabase();
    putAuthorizationPrincipal({ ...firstOwner, database });
    createIsolationDomain({
      id: "domain-1",
      ownerPrincipalId: firstOwner.id,
      database,
    });
    const prepared = prepareAuthorizationResourceRegistration({
      operationScope: "plugin:workspaces",
      idempotencyKey: "create-tab-1",
      domainId: "domain-1",
      resource,
      actor: { kind: "human", principalId: firstOwner.id },
      database,
    });

    const firstReplay = replayAuthorizationResourceOperation({
      domainId: "domain-1",
      operationScope: "plugin:workspaces",
      operationId: prepared.operationId,
      database,
    });
    const duplicateReplay = replayAuthorizationResourceOperation({
      domainId: "domain-1",
      operationScope: "plugin:workspaces",
      operationId: prepared.operationId,
      database,
    });

    expect(firstReplay).toEqual({ operationId: prepared.operationId, state: "applied" });
    expect(duplicateReplay).toEqual(firstReplay);
    expect(getAuthorizationResourceOwner({ domainId: "domain-1", resource, database })).toEqual({
      principalId: firstOwner.id,
    });
  });

  it("does not replay an operation through a different trusted domain", () => {
    const database = createDatabase();
    for (const [domainId, owner] of [
      ["domain-1", firstOwner],
      ["domain-2", secondOwner],
    ] as const) {
      putAuthorizationPrincipal({ ...owner, database });
      createIsolationDomain({ id: domainId, ownerPrincipalId: owner.id, database });
    }
    const prepared = prepareAuthorizationResourceRegistration({
      operationScope: "plugin:workspaces",
      idempotencyKey: "create-tab-1",
      domainId: "domain-1",
      resource,
      actor: { kind: "human", principalId: firstOwner.id },
      database,
    });

    expect(() =>
      replayAuthorizationResourceOperation({
        domainId: "domain-2",
        operationScope: "plugin:workspaces",
        operationId: prepared.operationId,
        database,
      }),
    ).toThrow(/unknown authorization resource operation/i);
    expect(
      getAuthorizationResourceOwner({ domainId: "domain-1", resource, database }),
    ).toBeUndefined();
  });

  it("rolls back registration when the operation transition fails", () => {
    const database = createDatabase();
    putAuthorizationPrincipal({ ...firstOwner, database });
    createIsolationDomain({
      id: "domain-1",
      ownerPrincipalId: firstOwner.id,
      database,
    });
    const prepared = prepareAuthorizationResourceRegistration({
      operationScope: "plugin:workspaces",
      idempotencyKey: "create-tab-1",
      domainId: "domain-1",
      resource,
      actor: { kind: "human", principalId: firstOwner.id },
      database,
    });
    const { db } = openOpenClawStateDatabase(database);
    db.exec(`
      CREATE TRIGGER test_authorization_operation_transition_failure
      BEFORE UPDATE OF state ON authorization_resource_operations
      FOR EACH ROW
      BEGIN
        SELECT RAISE(ABORT, 'forced operation transition failure');
      END;
    `);

    expect(() =>
      replayAuthorizationResourceOperation({
        domainId: "domain-1",
        operationScope: "plugin:workspaces",
        operationId: prepared.operationId,
        database,
      }),
    ).toThrow(/forced operation transition failure/i);
    expect(
      getAuthorizationResourceOwner({ domainId: "domain-1", resource, database }),
    ).toBeUndefined();
  });

  it("assigns a delegated agent creation to its human sponsor without owner inheritance", async () => {
    const database = createDatabase();
    putAuthorizationPrincipal({ ...firstOwner, database });
    putAuthorizationPrincipal({ ...agent, database });
    createIsolationDomain({
      id: "domain-1",
      ownerPrincipalId: firstOwner.id,
      database,
    });
    addIsolationDomainMember({
      domainId: "domain-1",
      principalId: agent.id,
      addedByPrincipalId: firstOwner.id,
      database,
    });
    createAuthorizationDelegation({
      id: "delegation-1",
      assignmentId: "assignment-1",
      domainId: "domain-1",
      agentPrincipalId: agent.id,
      sponsorPrincipalId: firstOwner.id,
      createdByPrincipalId: firstOwner.id,
      database,
    });

    const prepared = prepareAuthorizationResourceRegistration({
      operationScope: "plugin:workspaces",
      idempotencyKey: "agent-create-tab-1",
      domainId: "domain-1",
      resource,
      actor: {
        kind: "delegated-agent",
        principalId: agent.id,
        sponsorPrincipalId: firstOwner.id,
        delegationId: " delegation-1 ",
        assignmentId: " assignment-1 ",
      },
      database,
    });
    replayAuthorizationResourceOperation({
      domainId: "domain-1",
      operationScope: "plugin:workspaces",
      operationId: prepared.operationId,
      database,
    });

    expect(getAuthorizationResourceOwner({ domainId: "domain-1", resource, database })).toEqual({
      principalId: firstOwner.id,
    });
    const runtime = createStateGatewayAuthorizationRuntime({ database });
    if (runtime.mode !== "isolated") {
      throw new Error("expected isolated authorization runtime");
    }
    await expect(
      runtime.authorize({
        principal: agent.principal,
        domain: { id: "domain-1" },
        method: "workspaces.tab.update",
        permission: "workspaces.tab.write",
        resources: [resource],
      }),
    ).resolves.toEqual({ allowed: false, reason: "forbidden" });
  });

  it("rejects a competing sponsor for an agent already tied to the domain owner", () => {
    const database = createDatabase();
    putAuthorizationPrincipal({ ...firstOwner, database });
    putAuthorizationPrincipal({ ...secondOwner, database });
    putAuthorizationPrincipal({ ...agent, database });
    createIsolationDomain({
      id: "domain-1",
      ownerPrincipalId: firstOwner.id,
      database,
    });
    addIsolationDomainMember({
      domainId: "domain-1",
      principalId: secondOwner.id,
      addedByPrincipalId: firstOwner.id,
      database,
    });
    addIsolationDomainMember({
      domainId: "domain-1",
      principalId: agent.id,
      addedByPrincipalId: firstOwner.id,
      database,
    });
    createAuthorizationDelegation({
      id: "delegation-owner",
      assignmentId: "assignment-owner",
      domainId: "domain-1",
      agentPrincipalId: agent.id,
      sponsorPrincipalId: firstOwner.id,
      createdByPrincipalId: firstOwner.id,
      database,
    });

    expect(() =>
      createAuthorizationDelegation({
        id: "delegation-member",
        assignmentId: "assignment-member",
        domainId: "domain-1",
        agentPrincipalId: agent.id,
        sponsorPrincipalId: secondOwner.id,
        createdByPrincipalId: secondOwner.id,
        database,
      }),
    ).toThrow(/canonical sponsor|domain owner/i);
  });

  it("rejects replay after the delegated assignment is revoked", () => {
    const database = createDatabase();
    putAuthorizationPrincipal({ ...firstOwner, database });
    putAuthorizationPrincipal({ ...agent, database });
    createIsolationDomain({
      id: "domain-1",
      ownerPrincipalId: firstOwner.id,
      database,
    });
    addIsolationDomainMember({
      domainId: "domain-1",
      principalId: agent.id,
      addedByPrincipalId: firstOwner.id,
      database,
    });
    createAuthorizationDelegation({
      id: "delegation-1",
      assignmentId: "assignment-1",
      domainId: "domain-1",
      agentPrincipalId: agent.id,
      sponsorPrincipalId: firstOwner.id,
      createdByPrincipalId: firstOwner.id,
      database,
    });
    const prepared = prepareAuthorizationResourceRegistration({
      operationScope: "plugin:workspaces",
      idempotencyKey: "agent-create-tab-1",
      domainId: "domain-1",
      resource,
      actor: {
        kind: "delegated-agent",
        principalId: agent.id,
        sponsorPrincipalId: firstOwner.id,
        delegationId: "delegation-1",
        assignmentId: "assignment-1",
      },
      database,
    });

    revokeAuthorizationDelegation({
      domainId: "domain-1",
      delegationId: "delegation-1",
      revokedByPrincipalId: firstOwner.id,
      database,
    });

    expect(() =>
      replayAuthorizationResourceOperation({
        domainId: "domain-1",
        operationScope: "plugin:workspaces",
        operationId: prepared.operationId,
        database,
      }),
    ).toThrow(/delegation is not active/i);
    expect(
      getAuthorizationResourceOwner({ domainId: "domain-1", resource, database }),
    ).toBeUndefined();
  });

  it("rejects caller-invented delegation and assignment identifiers", () => {
    const database = createDatabase();
    putAuthorizationPrincipal({ ...firstOwner, database });
    putAuthorizationPrincipal({ ...agent, database });
    createIsolationDomain({
      id: "domain-1",
      ownerPrincipalId: firstOwner.id,
      database,
    });
    addIsolationDomainMember({
      domainId: "domain-1",
      principalId: agent.id,
      addedByPrincipalId: firstOwner.id,
      database,
    });

    expect(() =>
      prepareAuthorizationResourceRegistration({
        operationScope: "plugin:workspaces",
        idempotencyKey: "agent-create-tab-1",
        domainId: "domain-1",
        resource,
        actor: {
          kind: "delegated-agent",
          principalId: agent.id,
          sponsorPrincipalId: firstOwner.id,
          delegationId: "invented-delegation",
          assignmentId: "invented-assignment",
        },
        database,
      }),
    ).toThrow(/delegation is not active/i);
  });

  it("does not resurrect a delegation when a removed agent is re-added", () => {
    const database = createDatabase();
    putAuthorizationPrincipal({ ...firstOwner, database });
    putAuthorizationPrincipal({ ...agent, database });
    createIsolationDomain({
      id: "domain-1",
      ownerPrincipalId: firstOwner.id,
      database,
    });
    addIsolationDomainMember({
      domainId: "domain-1",
      principalId: agent.id,
      addedByPrincipalId: firstOwner.id,
      database,
    });
    createAuthorizationDelegation({
      id: "delegation-1",
      assignmentId: "assignment-1",
      domainId: "domain-1",
      agentPrincipalId: agent.id,
      sponsorPrincipalId: firstOwner.id,
      createdByPrincipalId: firstOwner.id,
      database,
    });
    const prepared = prepareAuthorizationResourceRegistration({
      operationScope: "plugin:workspaces",
      idempotencyKey: "agent-create-tab-1",
      domainId: "domain-1",
      resource,
      actor: {
        kind: "delegated-agent",
        principalId: agent.id,
        sponsorPrincipalId: firstOwner.id,
        delegationId: "delegation-1",
        assignmentId: "assignment-1",
      },
      database,
    });
    removeIsolationDomainMember({
      domainId: "domain-1",
      principalId: agent.id,
      removedByPrincipalId: firstOwner.id,
      database,
    });
    addIsolationDomainMember({
      domainId: "domain-1",
      principalId: agent.id,
      addedByPrincipalId: firstOwner.id,
      database,
    });

    expect(() =>
      replayAuthorizationResourceOperation({
        domainId: "domain-1",
        operationScope: "plugin:workspaces",
        operationId: prepared.operationId,
        database,
      }),
    ).toThrow(/delegation is not active/i);
    expect(
      getAuthorizationResourceOwner({ domainId: "domain-1", resource, database }),
    ).toBeUndefined();
  });

  it("prepares and replays resource retirement without a user session", () => {
    const database = createDatabase();
    putAuthorizationPrincipal({ ...firstOwner, database });
    createIsolationDomain({
      id: "domain-1",
      ownerPrincipalId: firstOwner.id,
      database,
    });
    bindAuthorizationResource({
      domainId: "domain-1",
      resource,
      ownerPrincipalId: firstOwner.id,
      database,
    });

    const prepared = prepareAuthorizationResourceRetirement({
      operationScope: "plugin:workspaces",
      idempotencyKey: "delete-tab-1",
      domainId: "domain-1",
      resource,
      actorPrincipalId: firstOwner.id,
      database,
    });
    expect(getAuthorizationResourceOwner({ domainId: "domain-1", resource, database })).toEqual({
      principalId: firstOwner.id,
    });

    expect(
      replayAuthorizationResourceOperation({
        domainId: "domain-1",
        operationScope: "plugin:workspaces",
        operationId: prepared.operationId,
        database,
      }),
    ).toEqual({ operationId: prepared.operationId, state: "applied" });
    expect(
      getAuthorizationResourceOwner({ domainId: "domain-1", resource, database }),
    ).toBeUndefined();
  });

  it("rejects raw mutation of a prepared operation payload", () => {
    const database = createDatabase();
    putAuthorizationPrincipal({ ...firstOwner, database });
    putAuthorizationPrincipal({ ...secondOwner, database });
    createIsolationDomain({
      id: "domain-1",
      ownerPrincipalId: firstOwner.id,
      database,
    });
    addIsolationDomainMember({
      domainId: "domain-1",
      principalId: secondOwner.id,
      addedByPrincipalId: firstOwner.id,
      database,
    });
    const prepared = prepareAuthorizationResourceRegistration({
      operationScope: "plugin:workspaces",
      idempotencyKey: "create-tab-1",
      domainId: "domain-1",
      resource,
      actor: { kind: "human", principalId: firstOwner.id },
      database,
    });
    const { db } = openOpenClawStateDatabase(database);

    expect(() =>
      db
        .prepare(
          `UPDATE authorization_resource_operations
           SET owner_principal_id = ?
           WHERE operation_id = ?`,
        )
        .run(secondOwner.id, prepared.operationId),
    ).toThrow(/immutable/i);
  });

  it("rejects a raw non-delegated registration for a service actor", () => {
    const database = createDatabase();
    putAuthorizationPrincipal({ ...firstOwner, database });
    putAuthorizationPrincipal({ ...agent, database });
    createIsolationDomain({
      id: "domain-1",
      ownerPrincipalId: firstOwner.id,
      database,
    });
    addIsolationDomainMember({
      domainId: "domain-1",
      principalId: agent.id,
      addedByPrincipalId: firstOwner.id,
      database,
    });
    const { db } = openOpenClawStateDatabase(database);

    expect(() =>
      db
        .prepare(
          `INSERT INTO authorization_resource_operations (
             operation_id, operation_scope, idempotency_key, operation_type,
             domain_id, namespace, resource_type, resource_id,
             parent_namespace, parent_resource_type, parent_resource_id,
             actor_principal_id, owner_principal_id, delegation_id, assignment_id,
             state, created_at, updated_at, applied_at
           ) VALUES (?, ?, ?, 'register', ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL, NULL,
                     'pending', ?, ?, NULL)`,
        )
        .run(
          "authop_raw",
          "plugin:workspaces",
          "raw-create-tab",
          "domain-1",
          resource.namespace,
          resource.type,
          resource.id,
          agent.id,
          firstOwner.id,
          1,
          1,
        ),
    ).toThrow(/human actor.*owner|delegation/i);
  });

  it("rejects inserting a resource operation directly in the applied state", () => {
    const database = createDatabase();
    putAuthorizationPrincipal({ ...firstOwner, database });
    createIsolationDomain({
      id: "domain-1",
      ownerPrincipalId: firstOwner.id,
      database,
    });
    const { db } = openOpenClawStateDatabase(database);

    expect(() =>
      db
        .prepare(
          `INSERT INTO authorization_resource_operations (
             operation_id, operation_scope, idempotency_key, operation_type,
             domain_id, namespace, resource_type, resource_id,
             parent_namespace, parent_resource_type, parent_resource_id,
             actor_principal_id, owner_principal_id, delegation_id, assignment_id,
             state, created_at, updated_at, applied_at
           ) VALUES (?, ?, ?, 'register', ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL, NULL,
                     'applied', ?, ?, ?)`,
        )
        .run(
          "authop_forged_applied",
          "plugin:workspaces",
          "forged-applied-tab",
          "domain-1",
          resource.namespace,
          resource.type,
          resource.id,
          firstOwner.id,
          firstOwner.id,
          1,
          1,
          1,
        ),
    ).toThrow(/pending/i);
  });

  it("rejects marking registration applied before the resource exists", () => {
    const database = createDatabase();
    putAuthorizationPrincipal({ ...firstOwner, database });
    createIsolationDomain({
      id: "domain-1",
      ownerPrincipalId: firstOwner.id,
      database,
    });
    const prepared = prepareAuthorizationResourceRegistration({
      operationScope: "plugin:workspaces",
      idempotencyKey: "create-tab-1",
      domainId: "domain-1",
      resource,
      actor: { kind: "human", principalId: firstOwner.id },
      database,
    });
    const { db } = openOpenClawStateDatabase(database);

    expect(() =>
      db
        .prepare(
          `UPDATE authorization_resource_operations
           SET state = 'applied', applied_at = ?, updated_at = ?
           WHERE operation_id = ?`,
        )
        .run(1, 1, prepared.operationId),
    ).toThrow(/resource state/i);
  });

  it("rejects marking registration applied when the persisted parent differs", () => {
    const database = createDatabase();
    putAuthorizationPrincipal({ ...firstOwner, database });
    createIsolationDomain({
      id: "domain-1",
      ownerPrincipalId: firstOwner.id,
      database,
    });
    const parentOne = { namespace: "workspaces", type: "workspace", id: "workspace-1" } as const;
    const parentTwo = { namespace: "workspaces", type: "workspace", id: "workspace-2" } as const;
    for (const parent of [parentOne, parentTwo]) {
      bindAuthorizationResource({
        domainId: "domain-1",
        resource: parent,
        ownerPrincipalId: firstOwner.id,
        database,
      });
    }
    bindAuthorizationResource({
      domainId: "domain-1",
      resource,
      parent: parentTwo,
      ownerPrincipalId: firstOwner.id,
      database,
    });
    const prepared = prepareAuthorizationResourceRegistration({
      operationScope: "plugin:workspaces",
      idempotencyKey: "create-tab-1",
      domainId: "domain-1",
      resource,
      parent: parentOne,
      actor: { kind: "human", principalId: firstOwner.id },
      database,
    });
    const { db } = openOpenClawStateDatabase(database);

    expect(() =>
      db
        .prepare(
          `UPDATE authorization_resource_operations
           SET state = 'applied', applied_at = ?, updated_at = ?
           WHERE operation_id = ?`,
        )
        .run(1, 1, prepared.operationId),
    ).toThrow(/resource state/i);
  });

  it("rejects marking retirement applied when a different principal retired the resource", () => {
    const database = createDatabase();
    putAuthorizationPrincipal({ ...firstOwner, database });
    putAuthorizationPrincipal({ ...secondOwner, database });
    createIsolationDomain({
      id: "domain-1",
      ownerPrincipalId: firstOwner.id,
      database,
    });
    addIsolationDomainMember({
      domainId: "domain-1",
      principalId: secondOwner.id,
      addedByPrincipalId: firstOwner.id,
      database,
    });
    bindAuthorizationResource({
      domainId: "domain-1",
      resource,
      ownerPrincipalId: secondOwner.id,
      database,
    });
    const prepared = prepareAuthorizationResourceRetirement({
      operationScope: "plugin:workspaces",
      idempotencyKey: "delete-tab-1",
      domainId: "domain-1",
      resource,
      actorPrincipalId: firstOwner.id,
      database,
    });
    retireAuthorizationResource({
      domainId: "domain-1",
      resource,
      retiredByPrincipalId: secondOwner.id,
      database,
    });
    const { db } = openOpenClawStateDatabase(database);

    expect(() =>
      db
        .prepare(
          `UPDATE authorization_resource_operations
           SET state = 'applied', applied_at = ?, updated_at = ?
           WHERE operation_id = ?`,
        )
        .run(1, 1, prepared.operationId),
    ).toThrow(/resource state/i);
  });
});
