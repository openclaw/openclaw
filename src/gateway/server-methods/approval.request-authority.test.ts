import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveExecApprovalRequestAllowedDecisions,
  type ExecApprovalRequestPayload,
} from "../../infra/exec-approvals.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { StateDatabaseReadAdmissionInvalidatedError } from "../../state/openclaw-state-db-async-lifecycle.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import {
  createOpenClawTestState,
  withOpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { captureGatewayAuthPolicy } from "../auth-policy.js";
import { invalidateGatewayDeviceRevocation } from "../device-revocation.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import type { ExecApprovalManagerOptions } from "../exec-approval-manager.types.js";
import { bumpGatewayAccessRevision } from "../gateway-access-revision.js";
import * as operatorApprovalStore from "../operator-approval-store.js";
import { publishOperatorRoleConfigChange } from "../operator-role-policy.js";
import { rolePolicyConfig } from "../session-sharing.test-utils.js";
import { createApprovalHandlers } from "./approval.js";
import {
  createApprovalInvocation,
  createClient,
  getOperatorApproval,
} from "./approval.test-support.js";
import { createExecApprovalHandlers } from "./exec-approval.js";

let sharedState: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
beforeAll(async () => {
  sharedState = await createOpenClawTestState({ label: "approval-request-custody" });
});
beforeEach(() => sharedState?.applyEnv());
afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
});
afterAll(async () => sharedState?.cleanup());

function createManagers(
  databaseOptions: OpenClawStateDatabaseOptions,
  runtimeEpoch: string,
  onLifecycle?: ExecApprovalManagerOptions<ExecApprovalRequestPayload>["onLifecycle"],
) {
  const persistence = { runtimeEpoch, databaseOptions };
  const exec = new ExecApprovalManager<ExecApprovalRequestPayload>({
    scheduler: createTestGatewayScheduler(),
    persistence,
    resolveAllowedDecisions: resolveExecApprovalRequestAllowedDecisions,
    onLifecycle,
  });
  const plugin = new ExecApprovalManager<PluginApprovalRequestPayload>({
    scheduler: createTestGatewayScheduler(),
    approvalKind: "plugin",
    persistence,
  });
  const handlers = createApprovalHandlers({
    execApprovalManager: exec,
    pluginApprovalManager: plugin,
    databaseOptions,
  });
  return { exec, plugin, handlers };
}

const unrelatedAgentConfig: OpenClawConfig = {
  agents: {
    ownership: "explicit",
    defaults: { systemAgent: { agentId: "main" } },
    entries: { main: {}, other: {} },
  },
};

it.each([
  "lookup",
  "verdict",
  "verdict-reviewer",
  "verdict-source",
  "native-refused",
  "native-config-unrelated",
  "native-config-unrelated-agent",
  "native-config-role-aba",
  "native-config-routing-aba",
  "access",
  "reviewer",
  "source",
  "binding",
  "profile",
  "config",
  "config-unrelated",
  "config-unrelated-agent",
  "config-target-routing-aba",
  "config-target-store-aba",
  "config-other-identity",
  "config-own-identity-aba",
  "config-role-aba",
  "config-routing-aba",
  "transport-reviewer",
  "transport-source",
  "transport-unrelated-agent",
] as const)("preserves disconnected request custody with %s authority", async (revocation) => {
  const verdictChange = revocation.startsWith("verdict");
  const native = revocation.startsWith("native");
  const revoke = ![
    "config-unrelated",
    "config-unrelated-agent",
    "config-other-identity",
    "native-config-unrelated",
    "native-config-unrelated-agent",
  ].includes(revocation);
  const targetsMainSession =
    revocation.endsWith("unrelated-agent") || revocation.startsWith("config-target-");
  const state = expectDefined(sharedState, "shared approval test state");
  {
    const databaseOptions = { env: state.env };
    openOpenClawStateDatabase(databaseOptions);
    const { exec, plugin, handlers } = createManagers(databaseOptions, "request-custody-test");
    const record = exec.create(
      {
        command: "echo fixture",
        ...(targetsMainSession ? { sessionKey: "agent:main:main", agentId: "main" } : {}),
      },
      600_000,
      `request-custody-${revocation}`,
    );
    record.approvalReviewerDeviceIds = ["reviewer"];
    const { decision } = await exec.register(record, 600_000);
    let settled = false;
    void decision.then(() => {
      settled = true;
    });
    const client = createClient({ deviceId: "reviewer" });
    const connection = new AbortController();
    client.connectionSignal = connection.signal;
    let nativeRevoked = false;
    const nativeGuard = vi.fn(() => {
      // This enters the existing native write transaction even for a pending-row read.
      getOperatorApproval({ id: record.id, databaseOptions });
      if (nativeRevoked) {
        throw new Error("synthetic native guard revoked");
      }
    });
    const before = getOperatorApproval({ id: record.id, databaseOptions });
    const invocation = createApprovalInvocation({
      handlers,
      method: "approval.resolve",
      body: {
        id: revocation.startsWith("transport-")
          ? expectDefined(before, "persisted approval").resolutionRef
          : record.id,
        kind: "exec",
        decision: "allow-once",
      },
      client,
      ...(native ? { sessionMutationCommitGuard: nativeGuard } : {}),
    });
    const initialConfig: OpenClawConfig = {};
    setRuntimeConfigSnapshot(initialConfig);
    client.authPolicy = captureGatewayAuthPolicy(initialConfig, {
      role: "operator",
      verifiedIdentity: "reviewer@example.test",
    });
    let currentConfig = initialConfig;
    invocation.context.getRuntimeConfig = () => currentConfig;
    const publishConfig = (config: OpenClawConfig) => {
      currentConfig = config;
      setRuntimeConfigSnapshot(config);
      publishOperatorRoleConfigChange(invocation.context);
    };
    expect(before).toMatchObject({
      status: "pending",
      decision: null,
      resolvedAtMs: null,
      terminalReason: null,
      resolver: null,
    });
    const lookup = vi.spyOn(operatorApprovalStore, "getOperatorApprovalDetailed");
    const stages: string[] = [];
    let transaction = 0;
    probe.admission(workerAdmission, (request, grant, admit) => {
      if (request.stage === "transaction") {
        transaction += 1;
        if (transaction === 1) {
          connection.abort();
          stages.push("transport-retired");
        }
      } else if (request.stage === "commit") {
        if (transaction === 1) {
          stages.push("lookup-completed");
          switch (revocation) {
            case "lookup":
            case "native-refused":
            case "native-config-unrelated":
            case "native-config-unrelated-agent":
            case "native-config-role-aba":
            case "native-config-routing-aba":
            case "verdict":
            case "verdict-reviewer":
            case "verdict-source":
              break;
            case "access":
              bumpGatewayAccessRevision();
              break;
            case "transport-reviewer":
            case "reviewer":
              record.approvalReviewerDeviceIds = ["other-reviewer"];
              break;
            case "transport-source":
            case "source":
              record.request.sessionKey = "agent:main:other";
              break;
            case "binding":
              exec.retire();
              break;
            case "profile":
              client.authenticatedUserId = "other-user";
              break;
            case "config":
              invocation.context.getRuntimeConfig = () => ({});
              break;
            case "config-unrelated":
              publishConfig({ ...initialConfig, messages: { ackReaction: "ok" } });
              break;
            case "config-unrelated-agent":
            case "transport-unrelated-agent":
              publishConfig(unrelatedAgentConfig);
              break;
            case "config-target-routing-aba":
              publishConfig({ ...initialConfig, session: { mainKey: "other" } });
              publishConfig(initialConfig);
              break;
            case "config-target-store-aba":
              publishConfig({
                ...initialConfig,
                session: { store: path.join(state.stateDir, "moved", "{agentId}.sqlite") },
              });
              publishConfig(initialConfig);
              break;
            case "config-other-identity":
            case "config-own-identity-aba":
              publishConfig({
                gateway: {
                  auth: {
                    identityScopes: {
                      [revocation === "config-other-identity"
                        ? "other@example.test"
                        : "reviewer@example.test"]: ["operator.approvals"],
                    },
                  },
                },
              });
              publishConfig(initialConfig);
              break;
            case "config-role-aba":
              publishConfig(rolePolicyConfig());
              publishConfig(initialConfig);
              break;
            case "config-routing-aba":
              publishConfig({ ...initialConfig, session: { mainKey: "other" } });
              publishConfig(initialConfig);
              break;
          }
        }
        if (transaction === 2 && verdictChange) {
          stages.push("verdict-precommit");
          if (revocation === "verdict-reviewer") {
            record.approvalReviewerDeviceIds = ["other-reviewer"];
          }
          if (revocation === "verdict-source") {
            record.request.sessionKey = "agent:main:other";
          }
        }
        if (
          (transaction === 1 && revocation === "lookup") ||
          (transaction === 2 && revocation === "verdict")
        ) {
          invalidateGatewayDeviceRevocation(invocation.context, "reviewer", "operator");
          stages.push("device-revoked");
        }
      }
      admit(request, grant);
    });
    try {
      const pending = invocation.invoke();
      if (revocation === "native-refused") {
        nativeRevoked = true;
      }
      if (revocation === "native-config-unrelated") {
        publishConfig({ ...initialConfig, messages: { ackReaction: "ok" } });
      } else if (revocation === "native-config-unrelated-agent") {
        publishConfig(unrelatedAgentConfig);
      } else if (revocation === "native-config-role-aba") {
        publishConfig(rolePolicyConfig());
        publishConfig(initialConfig);
      } else if (revocation === "native-config-routing-aba") {
        publishConfig({ ...initialConfig, session: { mainKey: "other" } });
        publishConfig(initialConfig);
      }
      const response = await pending;
      expect(stages).toEqual(
        native
          ? []
          : [
              "transport-retired",
              "lookup-completed",
              ...(verdictChange ? ["verdict-precommit"] : []),
              ...(revocation === "lookup" || revocation === "verdict" ? ["device-revoked"] : []),
            ],
      );
      if (native) {
        expect(nativeGuard).toHaveBeenCalled();
      } else {
        expect(client.connectionSignal.aborted).toBe(true);
      }
      expect(lookup).toHaveBeenCalledOnce();
      if (revoke) {
        expect(response).toMatchObject({ ok: false, error: { message: "approval not found" } });
        expect(getOperatorApproval({ id: record.id, databaseOptions })).toEqual(before);
        expect(exec.getLiveSnapshot(record.id)).toBe(revocation === "binding" ? null : record);
        expect(record.resolvedAtMs).toBeUndefined();
        expect(settled).toBe(false);
        expect(invocation.context.approvalEvents?.publishResolved).not.toHaveBeenCalled();
        expect(invocation.context.broadcast).not.toHaveBeenCalled();
        expect(invocation.context.broadcastToConnIds).not.toHaveBeenCalled();
      } else {
        expect(response).toMatchObject({
          ok: true,
          result: { approval: { id: record.id, status: "allowed" } },
        });
        expect(getOperatorApproval({ id: record.id, databaseOptions })).toMatchObject({
          status: "allowed",
        });
        await expect(decision).resolves.toBe("allow-once");
      }
    } finally {
      await Promise.all([exec.drain(), plugin.drain()]);
    }
  }
});

it("keeps a legacy decision wait when an unrelated agent is added", async () => {
  const state = expectDefined(sharedState, "shared approval test state");
  const databaseOptions = { env: state.env };
  openOpenClawStateDatabase(databaseOptions);
  const exec = new ExecApprovalManager<ExecApprovalRequestPayload>({
    scheduler: createTestGatewayScheduler(),
    persistence: { runtimeEpoch: "wait-unrelated-agent-test", databaseOptions },
    resolveAllowedDecisions: resolveExecApprovalRequestAllowedDecisions,
  });
  const record = exec.create(
    { command: "echo wait", sessionKey: "agent:main:main", agentId: "main" },
    600_000,
    "wait-unrelated-agent",
  );
  record.approvalReviewerDeviceIds = ["wait-reviewer"];
  await exec.register(record, 600_000);
  const waiting = createDeferred();
  const awaitDecision = exec.awaitDecision.bind(exec);
  vi.spyOn(exec, "awaitDecision").mockImplementation((id) => {
    const decision = awaitDecision(id);
    waiting.resolve();
    return decision;
  });
  const client = createClient({ deviceId: "wait-reviewer" });
  const invocation = createApprovalInvocation({
    handlers: createExecApprovalHandlers(exec),
    method: "exec.approval.waitDecision",
    body: { id: record.id },
    client,
  });
  const initialConfig: OpenClawConfig = {};
  setRuntimeConfigSnapshot(initialConfig);
  client.authPolicy = captureGatewayAuthPolicy(initialConfig, {
    role: "operator",
    verifiedIdentity: "reviewer@example.test",
  });
  let currentConfig = initialConfig;
  invocation.context.getRuntimeConfig = () => currentConfig;
  try {
    const pending = invocation.invoke();
    await waiting.promise;
    currentConfig = unrelatedAgentConfig;
    setRuntimeConfigSnapshot(currentConfig);
    publishOperatorRoleConfigChange(invocation.context);
    await expect(exec.resolve(record.id, "allow-once")).resolves.toBe(true);
    await expect(pending).resolves.toMatchObject({
      ok: true,
      result: { id: record.id, decision: "allow-once" },
    });
  } finally {
    await exec.drain();
  }
});

it("rechecks retained request authority after the real history read settles", async () => {
  await withOpenClawTestState({ label: "approval-history-custody" }, async (state) => {
    const databaseOptions = { env: state.env };
    openOpenClawStateDatabase(databaseOptions);
    const { exec, plugin, handlers } = createManagers(databaseOptions, "history-custody-test");
    const record = exec.create({ command: "echo history" }, 600_000, "history-custody");
    record.approvalReviewerDeviceIds = ["history-reviewer"];
    const { decision } = await exec.register(record, 600_000);
    await exec.resolve(record.id, "allow-once");
    await expect(decision).resolves.toBe("allow-once");
    const client = createClient({ deviceId: "history-reviewer" });
    const connection = new AbortController();
    client.connectionSignal = connection.signal;
    const invocation = createApprovalInvocation({
      handlers,
      method: "approval.history",
      body: {},
      client,
    });
    const history = operatorApprovalStore.listTerminalOperatorApprovals;
    vi.spyOn(operatorApprovalStore, "listTerminalOperatorApprovals").mockImplementation(
      async (params) => {
        const result = await history(params);
        expect(result.records).toHaveLength(1);
        invalidateGatewayDeviceRevocation(invocation.context, "history-reviewer", "operator");
        return result;
      },
    );
    connection.abort();
    try {
      expect(await invocation.invoke()).toMatchObject({
        ok: false,
        result: undefined,
        error: { message: "approval not found" },
      });
      expect(getOperatorApproval({ id: record.id, databaseOptions })).toMatchObject({
        status: "allowed",
        decision: "allow-once",
      });
    } finally {
      await Promise.all([exec.drain(), plugin.drain()]);
    }
  });
});

it("rejects a revoked lookup waiting for a committed decision without losing the winner", async () => {
  await withOpenClawTestState({ label: "approval-reconciliation-custody" }, async (state) => {
    const databaseOptions = { env: state.env };
    openOpenClawStateDatabase(databaseOptions);
    const onLifecycle = vi.fn();
    const { exec, plugin, handlers } = createManagers(
      databaseOptions,
      "reconciliation-custody-test",
      onLifecycle,
    );
    const record = exec.create({ command: "echo committed" }, 600_000, "reconciliation-custody");
    record.approvalReviewerDeviceIds = ["reconciliation-reviewer"];
    const { decision } = await exec.register(record, 600_000);
    const committed = createDeferred();
    const reply = createDeferred();
    const entered = createDeferred();
    const resolve = operatorApprovalStore.resolveOperatorApproval;
    vi.spyOn(operatorApprovalStore, "resolveOperatorApproval").mockImplementationOnce(
      async (params) => {
        const result = await resolve(params);
        committed.resolve();
        await reply.promise;
        return result;
      },
    );
    const reconcile = exec.reconcileDurableLookup.bind(exec);
    vi.spyOn(exec, "reconcileDurableLookup").mockImplementation((...args) => {
      const result = reconcile(...args);
      entered.resolve();
      return result;
    });
    const invocation = createApprovalInvocation({
      handlers,
      method: "approval.get",
      body: { id: record.id },
      client: createClient({ deviceId: "reconciliation-reviewer" }),
    });
    const resolution = exec.resolve(record.id, "allow-once");
    let lookup: ReturnType<typeof invocation.invoke> | undefined;
    try {
      await committed.promise;
      lookup = invocation.invoke();
      await entered.promise;
      invalidateGatewayDeviceRevocation(invocation.context, "reconciliation-reviewer", "operator");
      reply.resolve();
      await expect(lookup).resolves.toMatchObject({
        ok: false,
        result: undefined,
        error: { message: "approval not found" },
      });
      await expect(resolution).resolves.toBe(true);
      await expect(decision).resolves.toBe("allow-once");
      expect(getOperatorApproval({ id: record.id, databaseOptions })).toMatchObject({
        status: "allowed",
        decision: "allow-once",
      });
      expect(onLifecycle.mock.calls.filter(([event]) => event.phase === "terminal")).toHaveLength(
        1,
      );
      expect(invocation.context.approvalEvents?.publishResolved).not.toHaveBeenCalled();
    } finally {
      reply.resolve();
      await Promise.allSettled([resolution, lookup]);
      await Promise.all([exec.drain(), plugin.drain()]);
    }
  });
});

it.each([
  { code: "closed", operation: "lookup" },
  { code: "overloaded", operation: "deny" },
  { code: "unavailable", operation: "resolve" },
  { code: "lifecycle-invalidated", operation: "lookup" },
  ...(["lookup", "resolve", "deny"] as const).map((operation) => ({
    code: "outcome-unknown" as const,
    operation,
  })),
] as const)(
  "keeps the pending waiter after a $code $operation refusal",
  async ({ code, operation }) => {
    const state = expectDefined(sharedState, "shared approval test state");
    const databaseOptions = { env: state.env };
    const { exec, plugin, handlers } = createManagers(databaseOptions, "worker-refusal-test");
    const record = exec.create(
      { command: "echo refused" },
      600_000,
      `worker-refusal-${code}-${operation}`,
    );
    record.approvalReviewerDeviceIds = ["refusal-reviewer"];
    const { decision } = await exec.register(record, 600_000);
    let settled = false;
    void decision.then(() => {
      settled = true;
    });
    const before = getOperatorApproval({ id: record.id, databaseOptions });
    const client = createClient({ deviceId: "refusal-reviewer" });
    vi.spyOn(
      operatorApprovalStore,
      operation === "lookup"
        ? "getOperatorApprovalDetailed"
        : operation === "resolve"
          ? "resolveOperatorApproval"
          : "forceDenyOperatorApproval",
    ).mockRejectedValueOnce(
      new AggregateError([
        code === "lifecycle-invalidated"
          ? new StateDatabaseReadAdmissionInvalidatedError("synthetic retired admission")
          : new SqliteWorkerError("synthetic worker refusal", code),
      ]),
    );
    try {
      expect(
        await createApprovalInvocation({
          handlers,
          method: operation === "lookup" ? "approval.get" : "approval.resolve",
          body:
            operation === "lookup"
              ? { id: record.id }
              : {
                  id: record.id,
                  kind: "exec",
                  decision: operation === "resolve" ? "allow-once" : "invalid",
                },
          client,
        }).invoke(),
      ).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
      expect(getOperatorApproval({ id: record.id, databaseOptions })).toEqual(before);
      expect(exec.getLiveSnapshot(record.id)).toBe(record);
      expect(record.resolvedAtMs).toBeUndefined();
      expect(settled).toBe(false);
      expect(
        await createApprovalInvocation({
          handlers,
          method: "approval.get",
          body: { id: record.id },
          client,
        }).invoke(),
      ).toMatchObject({ ok: true, result: { approval: { status: "pending" } } });
      expect(settled).toBe(false);
    } finally {
      await Promise.all([exec.drain(), plugin.drain()]);
    }
  },
);
