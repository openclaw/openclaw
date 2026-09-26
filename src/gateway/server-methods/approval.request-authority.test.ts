import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveExecApprovalRequestAllowedDecisions,
  type ExecApprovalRequestPayload,
} from "../../infra/exec-approvals.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { StateDatabaseReadAdmissionInvalidatedError } from "../../state/openclaw-state-db-async-lifecycle.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  withOpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { invalidateGatewayDeviceRevocation } from "../device-revocation.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
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

let sharedState: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
beforeAll(async () => {
  sharedState = await createOpenClawTestState({ label: "approval-request-custody" });
});
beforeEach(() => sharedState?.applyEnv());
afterEach(() => vi.restoreAllMocks());
afterAll(async () => sharedState?.cleanup());

it.each([
  "current",
  "lookup",
  "verdict",
  "verdict-reviewer",
  "verdict-source",
  "native",
  "native-refused",
  "native-config-equivalent",
  "native-config-unrelated",
  "native-config-role-aba",
  "native-config-routing-aba",
  "access",
  "reviewer",
  "source",
  "binding",
  "profile",
  "config",
  "config-equivalent",
  "config-unrelated",
  "config-role-revoked",
  "config-role-aba",
  "config-routing-aba",
  "transport-reviewer",
  "transport-source",
] as const)("preserves disconnected request custody with %s authority", async (revocation) => {
  const verdictChange = revocation.startsWith("verdict");
  const native = revocation.startsWith("native");
  const revoke = ![
    "current",
    "native",
    "config-equivalent",
    "config-unrelated",
    "native-config-equivalent",
    "native-config-unrelated",
  ].includes(revocation);
  const state = expectDefined(sharedState, "shared approval test state");
  {
    const databaseOptions = { env: state.env };
    openOpenClawStateDatabase(databaseOptions);
    const persistence = { runtimeEpoch: "request-custody-test", databaseOptions };
    const exec = new ExecApprovalManager<ExecApprovalRequestPayload>({
      persistence,
      resolveAllowedDecisions: resolveExecApprovalRequestAllowedDecisions,
    });
    const plugin = new ExecApprovalManager<PluginApprovalRequestPayload>({
      approvalKind: "plugin",
      persistence,
    });
    const record = exec.create(
      { command: "echo fixture" },
      600_000,
      `request-custody-${revocation}`,
    );
    record.approvalReviewerDeviceIds = ["reviewer"];
    const { decision } = await exec.register(record, 600_000);
    let settled = false;
    void decision.then(() => {
      settled = true;
    });
    const handlers = createApprovalHandlers({
      execApprovalManager: exec,
      pluginApprovalManager: plugin,
      databaseOptions,
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
    let currentConfig = initialConfig;
    invocation.context.getRuntimeConfig = () => currentConfig;
    const publishConfig = (config: OpenClawConfig) => {
      currentConfig = config;
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
    const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (admit, attachment) =>
        createAdmission((request, grant) => {
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
                case "current":
                case "lookup":
                case "native":
                case "native-refused":
                case "native-config-equivalent":
                case "native-config-unrelated":
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
                case "config-equivalent":
                  publishConfig(structuredClone(initialConfig));
                  break;
                case "config-unrelated":
                  publishConfig({ ...initialConfig, messages: { ackReaction: "ok" } });
                  break;
                case "config-role-revoked":
                  publishConfig(rolePolicyConfig());
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
        }, attachment),
    );
    try {
      const pending = invocation.invoke();
      if (revocation === "native-refused") {
        nativeRevoked = true;
      }
      if (revocation === "native-config-equivalent") {
        publishConfig(structuredClone(initialConfig));
      } else if (revocation === "native-config-unrelated") {
        publishConfig({ ...initialConfig, messages: { ackReaction: "ok" } });
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
        const stored = getOperatorApproval({ id: record.id, databaseOptions });
        expect({
          ok: response.ok,
          status: stored?.status,
          decision: stored?.decision,
          settled,
        }).toEqual({
          ok: false,
          status: "pending",
          decision: null,
          settled: false,
        });
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

it("rechecks retained request authority after the real history read settles", async () => {
  await withOpenClawTestState({ label: "approval-history-custody" }, async (state) => {
    const databaseOptions = { env: state.env };
    openOpenClawStateDatabase(databaseOptions);
    const persistence = { runtimeEpoch: "history-custody-test", databaseOptions };
    const exec = new ExecApprovalManager<ExecApprovalRequestPayload>({
      persistence,
      resolveAllowedDecisions: resolveExecApprovalRequestAllowedDecisions,
    });
    const plugin = new ExecApprovalManager<PluginApprovalRequestPayload>({
      approvalKind: "plugin",
      persistence,
    });
    const record = exec.create({ command: "echo history" }, 600_000, "history-custody");
    record.approvalReviewerDeviceIds = ["history-reviewer"];
    const { decision } = await exec.register(record, 600_000);
    await exec.resolve(record.id, "allow-once");
    await expect(decision).resolves.toBe("allow-once");
    const handlers = createApprovalHandlers({
      execApprovalManager: exec,
      pluginApprovalManager: plugin,
      databaseOptions,
    });
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
    const persistence = { runtimeEpoch: "reconciliation-custody-test", databaseOptions };
    const onLifecycle = vi.fn();
    const exec = new ExecApprovalManager<ExecApprovalRequestPayload>({
      persistence,
      resolveAllowedDecisions: resolveExecApprovalRequestAllowedDecisions,
      onLifecycle,
    });
    const plugin = new ExecApprovalManager<PluginApprovalRequestPayload>({
      approvalKind: "plugin",
      persistence,
    });
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
    const handlers = createApprovalHandlers({
      execApprovalManager: exec,
      pluginApprovalManager: plugin,
      databaseOptions,
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

it.each(
  (
    ["closed", "overloaded", "unavailable", "outcome-unknown", "lifecycle-invalidated"] as const
  ).flatMap((code) =>
    (["lookup", "resolve", "deny"] as const).map((operation) => ({ code, operation })),
  ),
)("keeps the pending waiter after a $code $operation refusal", async ({ code, operation }) => {
  const state = expectDefined(sharedState, "shared approval test state");
  const databaseOptions = { env: state.env };
  const persistence = { runtimeEpoch: "worker-refusal-test", databaseOptions };
  const exec = new ExecApprovalManager<ExecApprovalRequestPayload>({
    persistence,
    resolveAllowedDecisions: resolveExecApprovalRequestAllowedDecisions,
  });
  const plugin = new ExecApprovalManager<PluginApprovalRequestPayload>({
    approvalKind: "plugin",
    persistence,
  });
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
  const handlers = createApprovalHandlers({
    execApprovalManager: exec,
    pluginApprovalManager: plugin,
    databaseOptions,
  });
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
});
