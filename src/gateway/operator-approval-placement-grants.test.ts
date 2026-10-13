// Process-local placement-grant retention and final-boundary revalidation.
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { resolveCanonicalPluginApprovalRequestAllowedDecisions } from "../infra/plugin-approval-canonical-decisions.js";
import type { PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { createTestApprovalFixture } from "./exec-approval-manager.test-support.js";
import {
  resolveNodeInvokePlacementGrant,
  retainResolvedNodeInvokePlacementGrant,
  type NodeInvokePlacementGrantAuthorization,
} from "./node-invoke-placement-grant.js";
import { applyPluginNodeInvokePolicy } from "./node-invoke-plugin-policy.js";
import {
  createApprovalClientLookup,
  createContext,
  createDemoPolicy,
  createNodeSession,
  createOperatorClient,
  DEMO_COMMAND,
  DEMO_PARAMS,
  expectSinglePendingApproval,
  setDangerousDemoCommandRegistry,
} from "./node-invoke-plugin-policy.test-helpers.js";
import {
  createPlacementStandingGrantRuntime,
  type PlacementStandingGrantMintSpec,
  type PlacementStandingGrantRuntime,
} from "./operator-approval-placement-grants.js";
import { insertOperatorApproval, resolveOperatorApproval } from "./operator-approval-store.js";

type PlacementTestDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "operator_approvals" | "worker_environments" | "worker_session_placements"
>;
type NewOperatorApproval = Parameters<typeof insertOperatorApproval>[0]["approval"];

const NOW_MS = 1_756_000_000_000;
const SESSION_ID = "session-placement-1";
const SESSION_KEY = "agent:main:placement-1";
const ENVIRONMENT_ID = "environment-1";
const NODE_ID = "node-1";
const PAIRING_GENERATION = "pairing-1";
const CWD = "/worker/workspace";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const databasePaths = new Set<string>();

function createDatabaseOptions(): OpenClawStateDatabaseOptions {
  const stateDir = tempDirs.make("openclaw-placement-grant-");
  const databasePath = path.join(stateDir, "state.sqlite");
  databasePaths.add(databasePath);
  return { path: databasePath, env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

beforeEach(resetPluginRuntimeStateForTest);

afterEach(async () => {
  resetPluginRuntimeStateForTest();
  await Promise.all(
    [...databasePaths].map((databasePath) => closeOpenClawStateDatabaseByPathAsync(databasePath)),
  );
  databasePaths.clear();
});

function seedActivePlacement(
  databaseOptions: OpenClawStateDatabaseOptions,
  sessionId = SESSION_ID,
  environmentId = ENVIRONMENT_ID,
): void {
  const database = openOpenClawStateDatabase(databaseOptions);
  const stateDb = getNodeSqliteKysely<PlacementTestDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    stateDb.insertInto("worker_environments").values({
      environment_id: environmentId,
      provider_id: "test-provider",
      profile_id: "test-profile",
      profile_snapshot_json: "{}",
      provision_operation_id: `provision-${environmentId}`,
      lease_id: `lease-${environmentId}`,
      node_setup_id: `setup-${environmentId}`,
      node_device_id: NODE_ID,
      ssh_host: null,
      ssh_port: null,
      ssh_user: null,
      ssh_host_key: null,
      ssh_key_ref_json: null,
      desktop_json: null,
      state: "attached",
      bootstrap_bundle_hash: "bundle-1",
      bootstrap_openclaw_version: "test",
      bootstrap_protocol_features_json: "[]",
      bootstrap_install_kind: "test",
      owner_epoch: 7,
      teardown_terminal_state: null,
      attached_session_ids_json: JSON.stringify([sessionId]),
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      state_changed_at_ms: NOW_MS,
      idle_since_at_ms: null,
      destroy_requested_at_ms: null,
      last_error: null,
      shared_host: 0,
    }),
  );
  executeSqliteQuerySync(
    database.db,
    stateDb.insertInto("worker_session_placements").values({
      session_id: sessionId,
      agent_id: "main",
      session_key: SESSION_KEY,
      execution_mode: "remote-exec",
      state: "active",
      environment_id: environmentId,
      transition_generation: 4,
      active_owner_epoch: 7,
      workspace_base_manifest_ref: "manifest-1",
      remote_workspace_dir: CWD,
      worker_bundle_hash: "bundle-1",
      last_transcript_ack_cursor: null,
      last_live_event_ack_cursor: null,
      recovery_error: null,
      terminal_reason: null,
      terminal_at_ms: null,
      turn_claim_owner: null,
      turn_claim_id: null,
      turn_claim_run_id: null,
      turn_claim_generation: null,
      turn_claim_owner_epoch: null,
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      state_changed_at_ms: NOW_MS,
    }),
  );
}

function approval(id: string, sessionId = SESSION_ID): NewOperatorApproval {
  return {
    id,
    kind: "plugin",
    presentation: {
      kind: "plugin",
      title: "Run Codex on this node placement",
      description: "Run Codex on the active placement.",
      severity: "critical",
      pluginId: "codex",
      toolName: null,
      agentId: "main",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    },
    requester: { deviceId: "device-1", clientId: "client-1", deviceTokenAuth: true },
    reviewerDeviceIds: [],
    source: {
      agentId: "main",
      sessionKey: SESSION_KEY,
      sessionId,
      runId: "run-1",
      toolCallId: null,
      toolName: "codex.exec-server.stdio.v1",
    },
    audienceSessionKeys: [],
    runtimeEpoch: "runtime-1",
    createdAtMs: NOW_MS,
    expiresAtMs: NOW_MS + 60_000,
  };
}

async function resolveBinding(
  runtime: ReturnType<typeof createPlacementStandingGrantRuntime>,
): Promise<PlacementStandingGrantMintSpec> {
  const binding = await runtime.resolveBindingAsync({
    pluginId: "codex",
    command: "codex.exec-server.stdio.v1",
    approvalScope: "codex.exec-server",
    agentId: "main",
    sessionKey: SESSION_KEY,
    nodeId: NODE_ID,
    pairingGeneration: PAIRING_GENERATION,
  });
  expect(binding).not.toBeNull();
  return binding!;
}

async function mintGrant(
  databaseOptions: OpenClawStateDatabaseOptions,
  now: () => number = () => NOW_MS + 2_000,
): Promise<{
  binding: PlacementStandingGrantMintSpec;
  runtime: ReturnType<typeof createPlacementStandingGrantRuntime>;
}> {
  seedActivePlacement(databaseOptions);
  const runtime = createPlacementStandingGrantRuntime({
    runtimeEpoch: "runtime-1",
    databaseOptions,
    now,
  });
  const binding = await resolveBinding(runtime);
  await retainAllowedGrant(databaseOptions, runtime, binding);
  return { binding, runtime };
}

async function retainAllowedGrant(
  databaseOptions: OpenClawStateDatabaseOptions,
  runtime: ReturnType<typeof createPlacementStandingGrantRuntime>,
  binding: PlacementStandingGrantMintSpec,
  approvalId = "approval-1",
): Promise<void> {
  await insertOperatorApproval({
    approval: approval(approvalId, binding.sessionId),
    databaseOptions,
  });
  expect(
    (
      await resolveOperatorApproval({
        id: approvalId,
        decision: "allow-always",
        resolver: { kind: "device", id: "reviewer-1" },
        nowMs: NOW_MS + 1_000,
        databaseOptions,
      })
    ).outcome,
  ).toBe("resolved");
  expect(
    await runtime.retainAsync({
      ...binding,
      approvalId,
      nowMs: NOW_MS + 1_000,
      expiresAtMs: null,
    }),
  ).toBe(true);
}

describe("placement standing grants", () => {
  it("accepts the released synchronous SDK runtime at the node approval boundary", async () => {
    const { binding } = await mintGrant(createDatabaseOptions());
    const legacyRuntime: PlacementStandingGrantRuntime = {
      resolveBinding: () => binding,
      retain: () => true,
      validate: () => ({
        outcome: "consumed",
        grant: { ...binding, mintedByApprovalId: "approval-1", expiresAtMs: NOW_MS + 60_000 },
      }),
      consume: () => ({
        outcome: "consumed",
        grant: { ...binding, mintedByApprovalId: "approval-1", expiresAtMs: NOW_MS + 60_000 },
      }),
    };
    const owner = { agentId: "main", sessionKey: SESSION_KEY, assertCurrent: () => {} };
    expect(
      await resolveNodeInvokePlacementGrant({
        runtime: legacyRuntime,
        requestedDecisions: ["allow-always"],
        owner,
        pluginId: binding.pluginId,
        command: binding.command,
        approvalScope: binding.approvalScope,
        risk: { level: "high", family: "exec" },
        nodeSession: { ...createNodeSession(), pairingGeneration: PAIRING_GENERATION },
      }),
    ).toEqual({ kind: "granted", binding, approvalId: "approval-1" });
    const authorization: NodeInvokePlacementGrantAuthorization = {};
    expect(
      await retainResolvedNodeInvokePlacementGrant({
        runtime: legacyRuntime,
        decision: "allow-always",
        binding,
        owner,
        authorization,
      }),
    ).toBe(true);
    expect(authorization.binding).toEqual(binding);
  });

  it("retains each session's parent while selecting the current placement", async () => {
    const databaseOptions = createDatabaseOptions();
    const { binding, runtime } = await mintGrant(databaseOptions);
    const input = {
      pluginId: binding.pluginId,
      command: binding.command,
      approvalScope: binding.approvalScope,
      agentId: binding.agentId,
      sessionKey: binding.sessionKey,
      nodeId: binding.nodeId,
      pairingGeneration: binding.pairingGeneration,
    };
    const database = openOpenClawStateDatabase(databaseOptions);
    const stateDb = getNodeSqliteKysely<PlacementTestDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      stateDb.updateTable("worker_session_placements").set({ state: "draining" }),
    );
    seedActivePlacement(databaseOptions, "session-placement-2", "environment-2");
    const successor = await resolveBinding(runtime);
    await retainAllowedGrant(databaseOptions, runtime, successor, "approval-2");
    expect(await runtime.resolveAsync(input)).toEqual({
      binding: successor,
      approvalId: "approval-2",
    });

    executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("worker_session_placements")
        .set({ state: "draining" })
        .where("session_id", "=", successor.sessionId),
    );
    executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("worker_session_placements")
        .set({ state: "active" })
        .where("session_id", "=", binding.sessionId),
    );
    expect(await runtime.resolveAsync(input)).toEqual({ binding, approvalId: "approval-1" });
  });

  it("prepares without host SQL and rejects a parent revoked before transport handoff", async () => {
    const databaseOptions = createDatabaseOptions();
    const { binding, runtime } = await mintGrant(databaseOptions);
    await runtime.resolveAsync(binding);
    const hostSql = observeHostDataSql();
    try {
      const expired = {
        ...binding,
        approvalId: "approval-1",
        nowMs: NOW_MS + 1_000,
        expiresAtMs: NOW_MS,
      };
      const posted = vi.spyOn(Worker.prototype, "postMessage");
      try {
        expect(() => runtime.retain(expired)).toThrow("use retainAsync");
        expect(await runtime.retainAsync(expired)).toBe(false);
        expect(posted).not.toHaveBeenCalled();
        expect(hostSql.queries).toEqual([]);
      } finally {
        posted.mockRestore();
      }
      expect(await runtime.resolveAsync(binding)).toMatchObject({
        binding,
        approvalId: "approval-1",
      });
      expect(await runtime.validateAsync(binding)).toMatchObject({ outcome: "consumed" });
      expect(
        await runtime.retainAsync({
          ...binding,
          approvalId: "approval-1",
          nowMs: NOW_MS + 1_000,
          expiresAtMs: null,
        }),
      ).toBe(true);
      expect(hostSql.queries).toEqual([]);
    } finally {
      hostSql.restore();
    }
    expect(await runtime.consumeAsync(binding)).toMatchObject({ outcome: "consumed" });
    expect(runtime.consume(binding).outcome).toBe("consumed");
    const database = openOpenClawStateDatabase(databaseOptions);
    const stateDb = getNodeSqliteKysely<PlacementTestDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("operator_approvals")
        .set({ status: "denied", decision: "deny" })
        .where("approval_id", "=", "approval-1"),
    );
    const dispatchSql = observeHostDataSql();
    try {
      expect(runtime.consume(binding).outcome).toBe("no-grant");
      expect(dispatchSql.queries).toEqual([]);
    } finally {
      dispatchSql.restore();
    }
    expect(await runtime.validateAsync(binding)).toMatchObject({
      outcome: "approval-not-allow-always",
    });
  });

  it("rejects terminal metadata on an active placement before authorizing its grant", async () => {
    const databaseOptions = createDatabaseOptions();
    const { binding, runtime } = await mintGrant(databaseOptions);
    const database = openOpenClawStateDatabase(databaseOptions);
    executeSqliteQuerySync(
      database.db,
      getNodeSqliteKysely<PlacementTestDatabase>(database.db)
        .updateTable("worker_session_placements")
        .set({ terminal_reason: "retired", terminal_at_ms: NOW_MS })
        .where("session_id", "=", SESSION_ID),
    );
    await expect(runtime.resolveAsync(binding)).rejects.toThrow(
      "Worker session placement active cannot retain terminal facts",
    );
  });

  it("retains the exact binding only for the current Gateway runtime", async () => {
    const databaseOptions = createDatabaseOptions();
    seedActivePlacement(databaseOptions);
    const database = openOpenClawStateDatabase(databaseOptions);
    const versionBefore = database.db.prepare("PRAGMA user_version").get();
    const metadataBefore = database.db
      .prepare("SELECT schema_version, updated_at FROM schema_meta WHERE meta_key = 'primary'")
      .get();
    expect(tableExists(database.db, "operator_approval_placement_grants")).toBe(false);

    const runtime = createPlacementStandingGrantRuntime({
      runtimeEpoch: "runtime-1",
      databaseOptions,
      now: () => NOW_MS + 2_000,
    });
    const binding = await resolveBinding(runtime);
    expect(binding).toEqual({
      pluginId: "codex",
      command: "codex.exec-server.stdio.v1",
      approvalScope: "codex.exec-server",
      agentId: "main",
      sessionKey: SESSION_KEY,
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      pairingGeneration: PAIRING_GENERATION,
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: 7,
      placementGeneration: 4,
      cwd: CWD,
    });
    await retainAllowedGrant(databaseOptions, runtime, binding);

    expect(await runtime.validateAsync(binding)).toMatchObject({
      outcome: "consumed",
      grant: { mintedByApprovalId: "approval-1" },
    });
    expect(runtime.consume(binding).outcome).toBe("consumed");
    expect(tableExists(database.db, "operator_approval_placement_grants")).toBe(false);
    await expect(
      createPlacementStandingGrantRuntime({
        runtimeEpoch: "runtime-1",
        databaseOptions,
        now: () => NOW_MS + 2_000,
      })
        .validateAsync(binding)
        .then((result) => result.outcome),
    ).resolves.toBe("no-grant");
    expect(database.db.prepare("PRAGMA user_version").get()).toEqual(versionBefore);
    expect(
      database.db
        .prepare("SELECT schema_version, updated_at FROM schema_meta WHERE meta_key = 'primary'")
        .get(),
    ).toEqual(metadataBefore);
  });

  it("does not retain a grant before the parent allow-always decision", async () => {
    const databaseOptions = createDatabaseOptions();
    seedActivePlacement(databaseOptions);
    const runtime = createPlacementStandingGrantRuntime({
      runtimeEpoch: "runtime-1",
      databaseOptions,
      now: () => NOW_MS + 2_000,
    });
    const binding = await resolveBinding(runtime);
    await insertOperatorApproval({ approval: approval("approval-1"), databaseOptions });
    expect(
      await runtime.retainAsync({
        ...binding,
        approvalId: "approval-1",
        nowMs: NOW_MS + 1_000,
        expiresAtMs: null,
      }),
    ).toBe(false);
    expect((await runtime.validateAsync(binding)).outcome).toBe("no-grant");
  });

  it("keeps operation families isolated", async () => {
    const databaseOptions = createDatabaseOptions();
    const { binding, runtime } = await mintGrant(databaseOptions);
    expect(
      (
        await runtime.validateAsync({
          ...binding,
          command: "another.dangerous.command",
        })
      ).outcome,
    ).toBe("no-grant");
  });

  it.each([
    {
      name: "node substitution",
      expected: "node-changed",
      change: (binding: PlacementStandingGrantMintSpec) => ({ ...binding, nodeId: "node-2" }),
    },
    {
      name: "device re-pair",
      expected: "pairing-changed",
      change: (binding: PlacementStandingGrantMintSpec) => ({
        ...binding,
        pairingGeneration: "pairing-2",
      }),
    },
  ])("fails closed after $name", async ({ expected, change }) => {
    const databaseOptions = createDatabaseOptions();
    const { binding, runtime } = await mintGrant(databaseOptions);
    expect((await runtime.consumeAsync(change(binding))).outcome).toBe(expected);
  });

  it.each([
    ["placement generation bump", { transition_generation: 5 }],
    ["gateway owner-epoch rotation", { active_owner_epoch: 8 }],
    ["placement drain", { state: "draining" }],
  ] as const)("fails closed after %s", async (_name, update) => {
    const databaseOptions = createDatabaseOptions();
    const { binding, runtime } = await mintGrant(databaseOptions);
    const database = openOpenClawStateDatabase(databaseOptions);
    const stateDb = getNodeSqliteKysely<PlacementTestDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("worker_session_placements")
        .set(update)
        .where("session_id", "=", SESSION_ID),
    );
    expect((await runtime.consumeAsync(binding)).outcome).toBe("placement-changed");
  });

  it("fails closed after expiry, parent removal or reversal, or placement removal", async () => {
    const scenarios = ["expired", "parent-missing", "parent", "placement"] as const;
    for (const scenario of scenarios) {
      let nowMs = NOW_MS + 2_000;
      const databaseOptions = createDatabaseOptions();
      const { binding, runtime } = await mintGrant(databaseOptions, () => nowMs);
      const database = openOpenClawStateDatabase(databaseOptions);
      const stateDb = getNodeSqliteKysely<PlacementTestDatabase>(database.db);
      if (scenario === "parent-missing") {
        executeSqliteQuerySync(
          database.db,
          stateDb.deleteFrom("operator_approvals").where("approval_id", "=", "approval-1"),
        );
      } else if (scenario === "parent") {
        executeSqliteQuerySync(
          database.db,
          stateDb
            .updateTable("operator_approvals")
            .set({ status: "denied", decision: "deny" })
            .where("approval_id", "=", "approval-1"),
        );
      } else if (scenario === "placement") {
        executeSqliteQuerySync(database.db, stateDb.deleteFrom("worker_session_placements"));
      }
      if (scenario === "expired") {
        nowMs = NOW_MS + 31 * 24 * 60 * 60_000;
      }
      expect((await runtime.consumeAsync(binding)).outcome).toBe(
        scenario === "expired"
          ? "expired"
          : scenario === "parent-missing"
            ? "approval-missing"
            : scenario === "parent"
              ? "approval-not-allow-always"
              : "placement-missing",
      );
      await closeOpenClawStateDatabaseByPathAsync(database.path);
    }
  });

  it("skips the second launch and re-prompts after the placement generation changes", async (testContext) => {
    const fixture = createTestApprovalFixture<PluginApprovalRequestPayload>(testContext, {
      approvalKind: "plugin",
      resolveAllowedDecisions: resolveCanonicalPluginApprovalRequestAllowedDecisions,
      resolveStandingGrantMint: (request) =>
        request.placementGrant ? { kind: "placement", ...request.placementGrant } : null,
      retainPlacementStandingGrantAsync: (grant) => placementStandingGrants.retainAsync(grant),
      validateAgentRuntimeDelegatedAuthority: () => true,
    });
    const { manager, databaseOptions } = fixture;
    const placementStandingGrants = createPlacementStandingGrantRuntime({
      runtimeEpoch: manager.runtimeEpoch,
      databaseOptions,
    });
    await fixture.run(async () => {
      seedActivePlacement(databaseOptions);
      const policy = createDemoPolicy(async (context) => {
        const placementApproval = await context.approvals?.request({
          title: "Run on placement",
          description: "Allow this exact active placement.",
          allowedDecisions: ["allow-once", "allow-always"],
        });
        if (
          placementApproval?.decision !== "allow-once" &&
          placementApproval?.decision !== "allow-always"
        ) {
          return { ok: false, code: "DENIED", message: "approval denied" };
        }
        return await context.invokeNode();
      });
      policy.policy.classifyRisk = () => ({ level: "high", family: "demo.exec" });
      setDangerousDemoCommandRegistry([policy]);

      const nodeSession = { ...createNodeSession(), pairingGeneration: PAIRING_GENERATION };
      const { context } = createContext({
        pluginApprovalManager: manager,
        nodeSession,
        getApprovalClientConnIds: createApprovalClientLookup([createOperatorClient("reviewer")]),
        validateAgentRuntimeApprovalAuthority: () => true,
      });
      context.placementStandingGrants = placementStandingGrants;
      const invoke = vi.fn(async (input: Parameters<typeof context.nodeRegistry.invoke>[0]) => {
        if (
          (input.authorizeDispatch && !(await input.authorizeDispatch())) ||
          input.isDispatchAuthorized?.() === false
        ) {
          return {
            ok: false,
            payload: null,
            payloadJSON: null,
            error: { code: "AUTHORIZATION_CLOSED", message: "authorization closed" },
          };
        }
        input.onDispatchReady?.("invoke-placement");
        return { ok: true, payload: { connected: true }, payloadJSON: null, error: null };
      });
      context.nodeRegistry.invoke = invoke;
      const client = createOperatorClient();
      let placementAuthorityActive = true;
      const nodePlacementGrantAuthority = {
        agentId: "main",
        sessionKey: SESSION_KEY,
        runId: "run-placement-policy",
        assertCurrent: () => {
          if (!placementAuthorityActive) {
            throw new Error("placement authority closed");
          }
        },
      };
      const operationalRunInstance = createOperationalRunInstanceRef("identity-only-placement");
      const { record: identityOnlyApproval, pending: identityOnlyLaunch } =
        await expectSinglePendingApproval(manager, context, () =>
          fixture.track(
            applyPluginNodeInvokePolicy({
              context,
              client: {
                ...client,
                internal: {
                  agentRuntimeIdentity: {
                    kind: "agentRuntime",
                    agentId: "main",
                    sessionKey: SESSION_KEY,
                    operationalRunInstance,
                    delegatedAuthority: {
                      kind: "local",
                      operationalRunInstance,
                      lifecycleGeneration: "identity-only-generation",
                      claimId: "identity-only-claim",
                    },
                  },
                },
              },
              nodeSession,
              command: DEMO_COMMAND,
              params: DEMO_PARAMS,
              sessionKey: SESSION_KEY,
            }),
          ),
        );
      expect(identityOnlyApproval.request.allowedDecisions).not.toContain("allow-always");
      expect(identityOnlyApproval.request.placementGrant).toBeNull();
      expect(await manager.resolve(identityOnlyApproval.id, "deny")).toBe(true);
      await expect(identityOnlyLaunch).resolves.toMatchObject({ ok: false, code: "DENIED" });

      const launch = () =>
        withPluginRuntimeGatewayRequestScope(
          { isWebchatConnect: () => false, nodePlacementGrantAuthority },
          () =>
            applyPluginNodeInvokePolicy({
              context,
              client,
              nodeSession,
              command: DEMO_COMMAND,
              params: DEMO_PARAMS,
              sessionKey: SESSION_KEY,
            }),
        );

      const { record: legacyApproval, pending: legacyLaunch } = await expectSinglePendingApproval(
        manager,
        context,
        () => fixture.track(launch()),
      );
      expect(legacyApproval.request.allowedDecisions).not.toContain("allow-always");
      expect(legacyApproval.request.placementGrant).toBeNull();
      expect(await manager.resolve(legacyApproval.id, "deny")).toBe(true);
      await expect(legacyLaunch).resolves.toMatchObject({ ok: false, code: "DENIED" });

      policy.policy.standingApproval = { kind: "placement", scope: "demo.exec-placement" };
      const { record: firstApproval, pending: firstLaunch } = await expectSinglePendingApproval(
        manager,
        context,
        () => fixture.track(launch()),
      );
      expect(firstApproval.request.placementGrant).toMatchObject({
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        approvalScope: "demo.exec-placement",
        placementGeneration: 4,
      });
      expect(await manager.resolve(firstApproval.id, "allow-always")).toBe(true);
      await expect(firstLaunch).resolves.toMatchObject({ ok: true });
      expect(invoke).toHaveBeenCalledTimes(1);

      await expect(launch()).resolves.toMatchObject({ ok: true });
      expect(await manager.listPendingRecords()).toEqual([]);
      expect(invoke).toHaveBeenCalledTimes(2);

      const database = openOpenClawStateDatabase(databaseOptions);
      const stateDb = getNodeSqliteKysely<PlacementTestDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        stateDb
          .updateTable("worker_session_placements")
          .set({ transition_generation: 5 })
          .where("session_id", "=", SESSION_ID),
      );
      const { record: staleApproval, pending: staleLaunch } = await expectSinglePendingApproval(
        manager,
        context,
        () => fixture.track(launch()),
      );
      placementAuthorityActive = false;
      expect(await manager.resolve(staleApproval.id, "allow-always")).toBe(false);
      await expect(staleLaunch).resolves.toMatchObject({ ok: false, code: "DENIED" });
      placementAuthorityActive = true;

      const { record: movedApproval, pending: movedLaunch } = await expectSinglePendingApproval(
        manager,
        context,
        () => fixture.track(launch()),
      );
      expect(movedApproval.id).not.toBe(firstApproval.id);
      expect(movedApproval.request.placementGrant).toMatchObject({ placementGeneration: 5 });
      expect(await manager.resolve(movedApproval.id, "deny")).toBe(true);
      await expect(movedLaunch).resolves.toMatchObject({ ok: false, code: "DENIED" });
      expect(invoke).toHaveBeenCalledTimes(2);
    });
  });
});
