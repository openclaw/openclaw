import path from "node:path";
import { Worker } from "node:worker_threads";
import type { Compilable, Updateable } from "kysely";
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
import { createApprovalClientLookup } from "./server-methods/approval-request.test-support.js";
import { seedAttachedPlacementEnvironment } from "./worker-environments/placement-test-fixtures.js";

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
const RESOLUTION_INPUT = {
  pluginId: "codex",
  command: "codex.exec-server.stdio.v1",
  approvalScope: "codex.exec-server",
  agentId: "main",
  sessionKey: SESSION_KEY,
  nodeId: NODE_ID,
  pairingGeneration: PAIRING_GENERATION,
};
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const databasePaths = new Set<string>();

function createDatabaseOptions(): OpenClawStateDatabaseOptions {
  const stateDir = tempDirs.make("openclaw-placement-grant-");
  const databasePath = path.join(stateDir, "state.sqlite");
  databasePaths.add(databasePath);
  return { path: databasePath, env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

function placementDatabase(databaseOptions: OpenClawStateDatabaseOptions) {
  const database = openOpenClawStateDatabase(databaseOptions);
  const stateDb = getNodeSqliteKysely<PlacementTestDatabase>(database.db);
  const execute = <Row>(query: Compilable<Row>) => executeSqliteQuerySync(database.db, query);
  return {
    database,
    stateDb,
    execute,
    revokeApproval: () =>
      execute(
        stateDb
          .updateTable("operator_approvals")
          .set({ status: "denied", decision: "deny" })
          .where("approval_id", "=", "approval-1"),
      ),
    updatePlacement: (
      update: Updateable<PlacementTestDatabase["worker_session_placements"]>,
      sessionId = SESSION_ID,
    ) =>
      execute(
        stateDb
          .updateTable("worker_session_placements")
          .set(update)
          .where("session_id", "=", sessionId),
      ),
  };
}

function createRuntime(databaseOptions: OpenClawStateDatabaseOptions, now = () => NOW_MS + 2_000) {
  return createPlacementStandingGrantRuntime({ runtimeEpoch: "runtime-1", databaseOptions, now });
}

function grantInput(binding: PlacementStandingGrantMintSpec, approvalId = "approval-1") {
  return { ...binding, approvalId, nowMs: NOW_MS + 1_000, expiresAtMs: null };
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
  const { database, stateDb, execute } = placementDatabase(databaseOptions);
  seedAttachedPlacementEnvironment(database, {
    environmentId,
    sessionId,
    ownerEpoch: 7,
    nodeDeviceId: NODE_ID,
  });
  execute(
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
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    },
    source: { agentId: "main", sessionKey: SESSION_KEY, sessionId },
    runtimeEpoch: "runtime-1",
    createdAtMs: NOW_MS,
    expiresAtMs: NOW_MS + 60_000,
  };
}

async function resolveBinding(runtime: ReturnType<typeof createRuntime>) {
  const binding = await runtime.resolveBindingAsync(RESOLUTION_INPUT);
  expect(binding).not.toBeNull();
  return binding!;
}

async function createPlacementFixture(retain = true, now: () => number = () => NOW_MS + 2_000) {
  const databaseOptions = createDatabaseOptions();
  seedActivePlacement(databaseOptions);
  const runtime = createRuntime(databaseOptions, now);
  const binding = await resolveBinding(runtime);
  if (retain) {
    await retainAllowedGrant(databaseOptions, runtime, binding);
  }
  return { binding, runtime, databaseOptions, ...placementDatabase(databaseOptions) };
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
  const resolution = await resolveOperatorApproval({
    id: approvalId,
    decision: "allow-always",
    resolver: { kind: "device", id: "reviewer-1" },
    nowMs: NOW_MS + 1_000,
    databaseOptions,
  });
  expect(resolution.outcome).toBe("resolved");
  expect(await runtime.retainAsync(grantInput(binding, approvalId))).toBe(true);
}

describe("placement standing grants", () => {
  it("accepts the released synchronous SDK runtime at the node approval boundary", async () => {
    const { binding } = await createPlacementFixture();
    const consumed = () => ({
      outcome: "consumed" as const,
      grant: { ...binding, mintedByApprovalId: "approval-1", expiresAtMs: NOW_MS + 60_000 },
    });
    const legacyRuntime: PlacementStandingGrantRuntime = {
      resolveBinding: () => binding,
      retain: () => true,
      validate: consumed,
      consume: consumed,
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
    const { binding, runtime, databaseOptions, stateDb, execute, updatePlacement } =
      await createPlacementFixture();
    execute(stateDb.updateTable("worker_session_placements").set({ state: "draining" }));
    seedActivePlacement(databaseOptions, "session-placement-2", "environment-2");
    const successor = await resolveBinding(runtime);
    await retainAllowedGrant(databaseOptions, runtime, successor, "approval-2");
    expect(await runtime.resolveAsync(RESOLUTION_INPUT)).toEqual({
      binding: successor,
      approvalId: "approval-2",
    });

    updatePlacement({ state: "draining" }, successor.sessionId);
    updatePlacement({ state: "active" }, binding.sessionId);
    expect(await runtime.resolveAsync(RESOLUTION_INPUT)).toEqual({
      binding,
      approvalId: "approval-1",
    });
  });

  it("prepares without host SQL and rejects a parent revoked before transport handoff", async () => {
    const { binding, runtime, revokeApproval } = await createPlacementFixture();
    await runtime.resolveAsync(binding);
    const hostSql = observeHostDataSql();
    try {
      const expired = { ...grantInput(binding), expiresAtMs: NOW_MS };
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
      expect(await runtime.retainAsync(grantInput(binding))).toBe(true);
      expect(hostSql.queries).toEqual([]);
    } finally {
      hostSql.restore();
    }
    expect(await runtime.consumeAsync(binding)).toMatchObject({ outcome: "consumed" });
    expect(runtime.consume(binding).outcome).toBe("consumed");
    revokeApproval();
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
    const { binding, runtime, updatePlacement } = await createPlacementFixture();
    updatePlacement({ terminal_reason: "retired", terminal_at_ms: NOW_MS });
    await expect(runtime.resolveAsync(binding)).rejects.toThrow(
      "Worker session placement active cannot retain terminal facts",
    );
  });

  it("retains the exact binding only for the current Gateway runtime", async () => {
    const databaseOptions = createDatabaseOptions();
    seedActivePlacement(databaseOptions);
    const database = openOpenClawStateDatabase(databaseOptions);
    const schemaSnapshot = () => [
      database.db.prepare("PRAGMA user_version").get(),
      database.db
        .prepare("SELECT schema_version, updated_at FROM schema_meta WHERE meta_key = 'primary'")
        .get(),
    ];
    const schemaBefore = schemaSnapshot();
    expect(tableExists(database.db, "operator_approval_placement_grants")).toBe(false);

    const runtime = createRuntime(databaseOptions);
    const binding = await resolveBinding(runtime);
    expect(binding).toEqual({
      ...RESOLUTION_INPUT,
      sessionId: SESSION_ID,
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
    expect(await createRuntime(databaseOptions).validateAsync(binding)).toMatchObject({
      outcome: "no-grant",
    });
    expect(schemaSnapshot()).toEqual(schemaBefore);
  });

  it("does not retain a grant before the parent allow-always decision", async () => {
    const { databaseOptions, runtime, binding } = await createPlacementFixture(false);
    await insertOperatorApproval({ approval: approval("approval-1"), databaseOptions });
    expect(await runtime.retainAsync(grantInput(binding))).toBe(false);
    expect((await runtime.validateAsync(binding)).outcome).toBe("no-grant");
  });

  it("keeps operation families isolated", async () => {
    const { binding, runtime } = await createPlacementFixture();
    expect(
      await runtime.validateAsync({ ...binding, command: "another.dangerous.command" }),
    ).toMatchObject({ outcome: "no-grant" });
  });

  it.each([
    ["node substitution", { nodeId: "node-2" }, "node-changed"],
    ["device re-pair", { pairingGeneration: "pairing-2" }, "pairing-changed"],
  ] as const)("fails closed after %s", async (_name, change, expected) => {
    const { binding, runtime } = await createPlacementFixture();
    expect((await runtime.consumeAsync({ ...binding, ...change })).outcome).toBe(expected);
  });

  it.each([
    ["placement generation bump", { transition_generation: 5 }],
    ["gateway owner-epoch rotation", { active_owner_epoch: 8 }],
    ["placement drain", { state: "draining" }],
  ] as const)("fails closed after %s", async (_name, update) => {
    const { binding, runtime, updatePlacement } = await createPlacementFixture();
    updatePlacement(update);
    expect((await runtime.consumeAsync(binding)).outcome).toBe("placement-changed");
  });

  it("fails closed after expiry, parent removal or reversal, or placement removal", async () => {
    const scenarios = {
      expired: "expired",
      "parent-missing": "approval-missing",
      parent: "approval-not-allow-always",
      placement: "placement-missing",
    };
    for (const [scenario, outcome] of Object.entries(scenarios)) {
      let nowMs = NOW_MS + 2_000;
      const { binding, runtime, database, stateDb, execute, revokeApproval } =
        await createPlacementFixture(true, () => nowMs);
      if (scenario === "parent-missing") {
        execute(stateDb.deleteFrom("operator_approvals").where("approval_id", "=", "approval-1"));
      } else if (scenario === "parent") {
        revokeApproval();
      } else if (scenario === "placement") {
        execute(stateDb.deleteFrom("worker_session_placements"));
      }
      if (scenario === "expired") {
        nowMs = NOW_MS + 31 * 24 * 60 * 60_000;
      }
      expect((await runtime.consumeAsync(binding)).outcome).toBe(outcome);
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
      const invokePolicy = (requestClient = client) =>
        applyPluginNodeInvokePolicy({
          context,
          client: requestClient,
          nodeSession,
          command: DEMO_COMMAND,
          params: DEMO_PARAMS,
          sessionKey: SESSION_KEY,
        });
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
            invokePolicy({
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
          () => invokePolicy(),
        );
      const requestApproval = () =>
        expectSinglePendingApproval(manager, context, () => fixture.track(launch()));

      const { record: legacyApproval, pending: legacyLaunch } = await requestApproval();
      expect(legacyApproval.request.allowedDecisions).not.toContain("allow-always");
      expect(legacyApproval.request.placementGrant).toBeNull();
      expect(await manager.resolve(legacyApproval.id, "deny")).toBe(true);
      await expect(legacyLaunch).resolves.toMatchObject({ ok: false, code: "DENIED" });

      policy.policy.standingApproval = { kind: "placement", scope: "demo.exec-placement" };
      const { record: firstApproval, pending: firstLaunch } = await requestApproval();
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

      placementDatabase(databaseOptions).updatePlacement({ transition_generation: 5 });
      const { record: staleApproval, pending: staleLaunch } = await requestApproval();
      placementAuthorityActive = false;
      expect(await manager.resolve(staleApproval.id, "allow-always")).toBe(false);
      await expect(staleLaunch).resolves.toMatchObject({ ok: false, code: "DENIED" });
      placementAuthorityActive = true;

      const { record: movedApproval, pending: movedLaunch } = await requestApproval();
      expect(movedApproval.id).not.toBe(firstApproval.id);
      expect(movedApproval.request.placementGrant).toMatchObject({ placementGeneration: 5 });
      expect(await manager.resolve(movedApproval.id, "deny")).toBe(true);
      await expect(movedLaunch).resolves.toMatchObject({ ok: false, code: "DENIED" });
      expect(invoke).toHaveBeenCalledTimes(2);
    });
  });
});
