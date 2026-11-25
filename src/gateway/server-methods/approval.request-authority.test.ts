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
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureGatewayAuthPolicy } from "../auth-policy.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import type { ExecApprovalManagerOptions } from "../exec-approval-manager.types.js";
import { bumpGatewayAccessRevision } from "../gateway-access-revision.js";
import * as operatorApprovalStore from "../operator-approval-store.js";
import { publishOperatorRoleConfigChange } from "../operator-role-policy.js";
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

async function createFixture(
  id: string,
  state = expectDefined(sharedState, "shared approval test state"),
  request: Partial<ExecApprovalRequestPayload> = {},
  onLifecycle?: ExecApprovalManagerOptions<ExecApprovalRequestPayload>["onLifecycle"],
) {
  const databaseOptions = { env: state.env };
  openOpenClawStateDatabase(databaseOptions);
  const runtimeEpoch = id.startsWith("request-custody-")
    ? "request-custody-test"
    : id.startsWith("worker-refusal-")
      ? "worker-refusal-test"
      : `${id}-test`;
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
  const record = exec.create({ command: "echo fixture", ...request }, 600_000, id);
  record.approvalReviewerDeviceIds = ["reviewer"];
  const { decision } = await exec.register(record, 600_000);
  const client = createClient({ deviceId: "reviewer" });
  let settled = false;
  void decision.then(() => {
    settled = true;
  });
  return {
    exec,
    record,
    decision,
    state,
    client,
    settled: () => settled,
    invoke: (
      method: Parameters<typeof createApprovalInvocation>[0]["method"],
      body: Record<string, unknown> = { id },
      overrides: Partial<Parameters<typeof createApprovalInvocation>[0]> = {},
    ) => createApprovalInvocation({ handlers, client, method, body, ...overrides }),
    read: () => getOperatorApproval({ id, databaseOptions }),
    drain: () => Promise.all([exec.drain(), plugin.drain()]),
  };
}

function configure(
  invocation: ReturnType<typeof createApprovalInvocation>,
  client: ReturnType<typeof createClient>,
  initialConfig: OpenClawConfig = {},
) {
  let currentConfig = initialConfig;
  setRuntimeConfigSnapshot(initialConfig);
  client.authPolicy = captureGatewayAuthPolicy(initialConfig, {
    role: "operator",
    verifiedIdentity: "reviewer@example.test",
  });
  invocation.context.getRuntimeConfig = () => currentConfig;
  return (config: OpenClawConfig) => {
    currentConfig = config;
    setRuntimeConfigSnapshot(config);
    publishOperatorRoleConfigChange(invocation.context);
  };
}

const unrelatedAgentConfig: OpenClawConfig = {
  agents: {
    ownership: "explicit",
    defaults: { systemAgent: { agentId: "main" } },
    entries: { main: {}, other: {} },
  },
};

it("acknowledges committed exec approval before follow-up session changes", async () => {
  const state = expectDefined(sharedState, "shared approval test state");
  const databaseOptions = { env: state.env };
  const exec = new ExecApprovalManager<ExecApprovalRequestPayload>({
    scheduler: createTestGatewayScheduler(),
    persistence: { runtimeEpoch: "approval-committed-ack", databaseOptions },
    resolveAllowedDecisions: resolveExecApprovalRequestAllowedDecisions,
  });
  const record = exec.create({ command: "echo committed" }, 600_000, "approval-committed-ack");
  record.approvalReviewerDeviceIds = ["reviewer"];
  const { decision } = await exec.register(record, 600_000);
  const entered = createDeferred();
  const release = createDeferred();
  const handleResolved = vi.fn(async () => {
    bumpGatewayAccessRevision();
    entered.resolve();
    await release.promise;
  });
  const invocation = createApprovalInvocation({
    handlers: createExecApprovalHandlers(exec, { iosPushDelivery: { handleResolved } }),
    method: "exec.approval.resolve",
    body: { id: record.id, decision: "allow-once" },
    client: createClient({ deviceId: "reviewer" }),
  });
  const resolution = invocation.invoke();
  try {
    await entered.promise;
    expect(getOperatorApproval({ id: record.id, databaseOptions })).toMatchObject({
      status: "allowed",
      decision: "allow-once",
    });
    await expect(decision).resolves.toBe("allow-once");
    expect(invocation.respond).toHaveBeenCalledExactlyOnceWith(true, { ok: true }, undefined);
    release.resolve();
    await expect(resolution).resolves.toMatchObject({ ok: true, result: { ok: true } });
    expect(handleResolved).toHaveBeenCalledTimes(1);
    expect(invocation.context.approvalEvents?.publishResolved).toHaveBeenCalledExactlyOnceWith(
      "exec",
      expect.objectContaining({ id: record.id, decision: "allow-once" }),
    );
  } finally {
    release.resolve();
    await Promise.allSettled([resolution]);
    await exec.drain();
  }
});

it.each([
  "verdict-source",
  "native-refused",
  "native-config-unrelated",
  "native-config-unrelated-agent",
  "source",
  "binding",
  "config-unrelated",
  "config-unrelated-agent",
  "config-other-identity",
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
    "transport-unrelated-agent",
    "native-config-unrelated-agent",
  ].includes(revocation);
  const targetsMainSession = revocation.endsWith("unrelated-agent");
  const { exec, invoke, record, decision, client, read, drain, settled } = await createFixture(
    `request-custody-${revocation}`,
    undefined,
    targetsMainSession ? { sessionKey: "agent:main:main", agentId: "main" } : {},
  );
  const connection = new AbortController();
  client.connectionSignal = connection.signal;
  let nativeRevoked = false;
  const nativeGuard = vi.fn(() => {
    if (nativeRevoked) {
      throw new Error("synthetic native guard revoked");
    }
  });
  const before = read();
  const invocation = invoke(
    "approval.resolve",
    {
      id: revocation.startsWith("transport-")
        ? expectDefined(before, "persisted approval").resolutionRef
        : record.id,
      kind: "exec",
      decision: "allow-once",
    },
    native ? { sessionMutationCommitGuard: nativeGuard } : {},
  );
  const initialConfig: OpenClawConfig = {};
  const publishConfig = configure(invocation, client, initialConfig);
  const changeConfig = (change: string) => {
    const identity = (email: string): OpenClawConfig => ({
      gateway: { auth: { identityScopes: { [email]: ["operator.approvals"] } } },
    });
    const configs: Record<string, OpenClawConfig> = {
      "config-unrelated": { ...initialConfig, messages: { ackReaction: "ok" } },
      "config-unrelated-agent": unrelatedAgentConfig,
      "transport-unrelated-agent": unrelatedAgentConfig,
      "config-other-identity": identity("other@example.test"),
    };
    const config = configs[change];
    if (config) {
      publishConfig(config);
      if (change.endsWith("-aba") || change === "config-other-identity") {
        publishConfig(initialConfig);
      }
    }
  };
  expect(before).toMatchObject({
    status: "pending",
    decision: null,
    resolvedAtMs: null,
    terminalReason: null,
    resolver: null,
  });
  const lookup = vi.spyOn(operatorApprovalStore, "getOperatorApprovalDetailed");
  const mutations: Record<string, () => void> = {
    source: () => {
      record.request.sessionKey = "agent:main:other";
    },
    binding: () => exec.retire(),
  };
  const mutate = (change: string) => {
    const mutation = mutations[change.replace(/^(transport|verdict)-/, "")];
    if (mutation) {
      mutation();
    } else {
      changeConfig(change);
    }
  };
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
        if (!verdictChange) {
          mutate(revocation);
        }
      }
      if (transaction === 2 && verdictChange) {
        stages.push("verdict-precommit");
        mutate(revocation);
      }
    }
    admit(request, grant);
  });
  try {
    const pending = invocation.invoke();
    if (revocation === "native-refused") {
      nativeRevoked = true;
    }
    if (native) {
      changeConfig(revocation.slice("native-".length));
    }
    const response = await pending;
    expect(stages).toEqual(
      native && revoke
        ? []
        : [
            "transport-retired",
            "lookup-completed",
            ...(verdictChange ? ["verdict-precommit"] : []),
          ],
    );
    if (native) {
      expect(nativeGuard).toHaveBeenCalled();
    }
    if (native && revoke) {
      expect(lookup).not.toHaveBeenCalled();
    } else {
      expect(client.connectionSignal.aborted).toBe(true);
      expect(lookup).toHaveBeenCalledOnce();
    }
    if (revoke) {
      expect(response).toMatchObject({ ok: false, error: { message: "approval not found" } });
      expect(read()).toEqual(before);
      expect(exec.getLiveSnapshot(record.id)).toBe(revocation === "binding" ? null : record);
      expect(record.resolvedAtMs).toBeUndefined();
      expect(settled()).toBe(false);
      expect(invocation.context.approvalEvents?.publishResolved).not.toHaveBeenCalled();
      expect(invocation.context.broadcast).not.toHaveBeenCalled();
      expect(invocation.context.broadcastToConnIds).not.toHaveBeenCalled();
    } else {
      expect(response).toMatchObject({
        ok: true,
        result: { approval: { id: record.id, status: "allowed" } },
      });
      expect(read()).toMatchObject({
        status: "allowed",
      });
      await expect(decision).resolves.toBe("allow-once");
    }
  } finally {
    await drain();
  }
});

it("keeps a legacy decision wait when an unrelated agent is added", async () => {
  const { exec, invoke, record, client, drain } = await createFixture(
    "wait-unrelated-agent",
    undefined,
    { sessionKey: "agent:main:main", agentId: "main" },
  );
  const waiting = createDeferred();
  const awaitDecision = exec.awaitDecision.bind(exec);
  vi.spyOn(exec, "awaitDecision").mockImplementation((id) => {
    const decision = awaitDecision(id);
    waiting.resolve();
    return decision;
  });
  const invocation = invoke(
    "exec.approval.waitDecision",
    { id: record.id },
    {
      handlers: createExecApprovalHandlers(exec),
    },
  );
  const publishConfig = configure(invocation, client);
  try {
    const pending = invocation.invoke();
    await waiting.promise;
    publishConfig(unrelatedAgentConfig);
    await expect(exec.resolve(record.id, "allow-once")).resolves.toBe(true);
    await expect(pending).resolves.toMatchObject({
      ok: true,
      result: { id: record.id, decision: "allow-once" },
    });
  } finally {
    await drain();
  }
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
    const { exec, invoke, record, read, drain, settled } = await createFixture(
      `worker-refusal-${code}-${operation}`,
    );
    const before = read();
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
        await invoke(
          operation === "lookup" ? "approval.get" : "approval.resolve",
          operation === "lookup"
            ? { id: record.id }
            : {
                id: record.id,
                kind: "exec",
                decision: operation === "resolve" ? "allow-once" : "invalid",
              },
        ).invoke(),
      ).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
      expect(read()).toEqual(before);
      expect(exec.getLiveSnapshot(record.id)).toBe(record);
      expect(record.resolvedAtMs).toBeUndefined();
      expect(settled()).toBe(false);
      expect(await invoke("approval.get").invoke()).toMatchObject({
        ok: true,
        result: { approval: { status: "pending" } },
      });
      expect(settled()).toBe(false);
    } finally {
      await drain();
    }
  },
);
