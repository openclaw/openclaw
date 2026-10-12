import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { callAgentToolGatewayRequest } from "../agents/tools/in-process-gateway.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import {
  loadCronRows,
  loadedCronStoreFromRows,
  upsertCronJobRow,
} from "../cron/store/row-codec.js";
import type { CronStoredJob } from "../cron/types.js";
import { resolveApprovalOverGateway } from "../infra/approval-gateway-resolver.js";
import type { ExecApprovalForwarder } from "../infra/exec-approval-forwarder.js";
import type { ExecApprovalRequestPayload } from "../infra/exec-approvals-core.js";
import { resolveExecApprovalRequestAllowedDecisions } from "../infra/exec-approvals-policy.js";
import type { PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import { APPROVALS_SCOPE } from "./method-scopes.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { buildCronExecOperationBinding } from "./operator-approval-standing-grants.js";
import type { CronStandingGrantMintSpec } from "./operator-approval-standing-grants.types.js";
import { listCronStandingGrants } from "./operator-approval-store.js";
import { createGatewayInstanceRuntime } from "./server-instance-runtime.js";
import { createApprovalHandlers } from "./server-methods/approval.js";
import { getOperatorApproval, createContext } from "./server-methods/approval.test-support.js";
import { createExecApprovalHandlers } from "./server-methods/exec-approval.js";
import { createPluginApprovalHandlers } from "./server-methods/plugin-approval.js";

const { msteamsPlugin } = await loadBundledPluginFacade<{ msteamsPlugin: ChannelPlugin }>({
  pluginId: "msteams",
  artifactBasename: "api.ts",
});

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
beforeAll(async () => {
  state = await createOpenClawTestState({ label: "internal-approval-authority" });
});
beforeEach(() => {
  state.applyEnv();
  setRuntimeConfigSnapshot({});
});
afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
  resetPluginRuntimeStateForTest();
});
afterAll(async () => state.cleanup());

function createFixture(
  standingGrant?: CronStandingGrantMintSpec,
  forwarder?: ExecApprovalForwarder,
) {
  const persistence = {
    runtimeEpoch: "internal-approval-test",
    databaseOptions: { env: state.env },
  };
  const exec = new ExecApprovalManager<ExecApprovalRequestPayload>({
    scheduler: createTestGatewayScheduler(),
    persistence,
    resolveAllowedDecisions: resolveExecApprovalRequestAllowedDecisions,
    resolveStandingGrantMint: () => (standingGrant ? { kind: "cron", ...standingGrant } : null),
  });
  const plugin = new ExecApprovalManager<PluginApprovalRequestPayload>({
    scheduler: createTestGatewayScheduler(),
    approvalKind: "plugin",
    persistence,
  });
  const handlers = {
    ...createExecApprovalHandlers(exec, { forwarder }),
    ...createPluginApprovalHandlers(plugin, { forwarder }),
    ...createApprovalHandlers({
      execApprovalManager: exec,
      pluginApprovalManager: plugin,
      databaseOptions: persistence.databaseOptions,
    }),
  };
  const registry = createGatewayMethodRegistry(
    Object.entries(handlers).map(([name, handler]) => ({
      name,
      handler,
      owner: { kind: "core" as const, area: "approval" },
      scope: APPROVALS_SCOPE,
    })),
  );
  const context = Object.assign(createContext(), {
    trackExecution: trackAsyncWork,
    getGatewayMethodRegistry: () => registry,
  });
  let current = true;
  const runtime = createGatewayInstanceRuntime({
    getContext: () => context,
    getMethodRegistry: () => registry,
    isDispatchAvailable: () => current,
  });
  return {
    exec,
    plugin,
    runtime,
    context,
    databaseOptions: persistence.databaseOptions,
    revoke() {
      current = false;
    },
    async close() {
      runtime.close();
      await Promise.all([exec.drain(), plugin.drain()]);
    },
    resolve(
      id: string,
      route: "channel" | "tool",
      isCurrent = () => true,
      sessionMutationCommitGuard?: () => void,
    ) {
      return route === "channel"
        ? runtime.nativeApprovals.request("approval.resolve", {
            id,
            kind: "exec",
            decision: "allow-once",
          })
        : withGatewayToolCallerIdentity(
            {
              agentId: "main",
              sessionKey: "agent:main:synthetic",
              operationalRunInstance: { instanceId: "synthetic-instance", runId: "synthetic-run" },
              receiptAuthority: isCurrent,
              gatewayContextResolver: () => (current ? context : undefined),
            },
            () =>
              callAgentToolGatewayRequest({
                method: "exec.approval.resolve",
                params: { id, decision: "allow-once" },
                scopes: [APPROVALS_SCOPE],
                sessionMutationCommitGuard,
              }),
          );
    },
  };
}

it.each([
  "unchanged",
  "sibling",
  "account-disabled",
  "channel-disabled",
  "account-removed",
] as const)("enforces real Teams account custody at Gateway settlement: %s", async (scenario) => {
  const senderId = "00000000-0000-4000-8000-000000000001";
  const accounts = {
    support: { appId: "support-app", appPassword: "synthetic-support", allowFrom: [senderId] },
    sales: { appId: "sales-app", appPassword: "synthetic-sales", allowFrom: [senderId] },
  };
  let cfg: OpenClawConfig = {
    channels: {
      msteams: { enabled: true, tenantId: "synthetic-tenant", allowFrom: [senderId], accounts },
    },
  };
  setRuntimeConfigSnapshot(cfg);
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "msteams", plugin: msteamsPlugin, source: "test" }]),
  );
  const fixture = createFixture();
  fixture.context.getRuntimeConfig = () => cfg;
  const record = fixture.exec.create(
    {
      command: "echo synthetic",
      turnSourceChannel: "msteams",
      turnSourceAccountId: "support",
    },
    60_000,
    `teams-custody-${scenario}`,
  );
  const { decision } = await fixture.exec.register(record, 60_000);
  const decisions: Array<string | null> = [];
  void decision.then((value) => decisions.push(value));
  const accountId = scenario === "sibling" ? "sales" : "support";
  const submittedConfig = cfg;
  let transaction = 0;
  let revokedBeforeCommit = false;
  probe.admission(workerAdmission, (request, grant, admit) => {
    if (request.stage === "transaction") {
      transaction++;
    }
    // The first transaction reads the approval; the second commits its decision.
    if (request.stage === "commit" && transaction === 2) {
      if (scenario === "account-disabled") {
        cfg = {
          channels: {
            msteams: {
              enabled: true,
              tenantId: "synthetic-tenant",
              allowFrom: [senderId],
              accounts: { ...accounts, support: { ...accounts.support, enabled: false } },
            },
          },
        };
        revokedBeforeCommit = true;
      } else if (scenario === "channel-disabled" || scenario === "account-removed") {
        cfg = {
          channels: {
            msteams: {
              enabled: scenario !== "channel-disabled",
              tenantId: "synthetic-tenant",
              // Root approvers must not authorize a named account that no longer exists.
              allowFrom: [senderId],
              accounts: scenario === "account-removed" ? { sales: accounts.sales } : accounts,
            },
          },
        };
        revokedBeforeCommit = true;
      }
      if (revokedBeforeCommit) {
        setRuntimeConfigSnapshot(cfg);
      }
    }
    return admit(request, grant);
  });
  try {
    // Both accounts authorize this actor before submission; only support owns the request.
    expect(
      msteamsPlugin.approvalCapability?.authorizeActorAction?.({
        cfg,
        accountId,
        senderId,
        action: "approve",
        approvalKind: "exec",
      })?.authorized,
    ).toBe(true);
    const resolution = resolveApprovalOverGateway({
      cfg: submittedConfig,
      approvalId: record.id,
      approvalKind: "exec",
      decision: "allow-once",
      channel: "msteams",
      accountId,
      senderId,
      gatewayRuntime: fixture.runtime.nativeApprovals,
    });
    if (scenario === "unchanged") {
      await expect(resolution).resolves.toMatchObject({
        applied: true,
        approval: { status: "allowed", decision: "allow-once" },
      });
      await expect(decision).resolves.toBe("allow-once");
      expect(
        getOperatorApproval({ id: record.id, databaseOptions: fixture.databaseOptions }),
      ).toMatchObject({
        status: "allowed",
        resolver: { kind: "channel", id: "msteams:support" },
      });
      expect(fixture.context.approvalEvents?.publishResolved).toHaveBeenCalledOnce();
    } else {
      const outcome = await resolution.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      expect(revokedBeforeCommit).toBe(scenario !== "sibling");
      expect
        .soft(getOperatorApproval({ id: record.id, databaseOptions: fixture.databaseOptions }))
        .toMatchObject({ status: "pending", decision: null });
      expect.soft(decisions).not.toContain("allow-once");
      expect.soft(fixture.context.approvalEvents?.publishResolved).not.toHaveBeenCalled();
      expect(outcome).toHaveProperty("error");
    }
  } finally {
    await fixture.close();
  }
});

it.each(["exec", "plugin"] as const)(
  "acknowledges a %s verdict before its channel notice completes",
  async (kind) => {
    const forwarding = createDeferredCore();
    const releaseForwarding = createDeferredCore();
    const forwarded = createDeferredCore();
    const handleResolved = async () => {
      forwarding.resolve();
      await releaseForwarding.promise;
      forwarded.resolve();
    };
    const fixture = createFixture(undefined, {
      handleRequested: async () => false,
      handleResolved,
      handlePluginApprovalResolved: handleResolved,
      stop: async () => {},
    });
    const register = async <TPayload>(
      manager: ExecApprovalManager<TPayload>,
      request: TPayload,
    ) => {
      const record = manager.create(request, 60_000, `notice-${kind}`);
      return { record, ...(await manager.register(record, 60_000)) };
    };
    const { record, decision } = await (kind === "exec"
      ? register(fixture.exec, { command: "echo synthetic" })
      : register(fixture.plugin, {
          title: "Synthetic operation",
          description: "Confirm the synthetic operation",
        }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const resolution = fixture.runtime.nativeApprovals.request(`${kind}.approval.resolve`, {
      id: record.id,
      decision: "deny",
    });
    const outcome = resolution.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await forwarding.promise;
      await expect(decision).resolves.toBe("deny");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await outcome).toEqual({ value: { ok: true } });
    } finally {
      releaseForwarding.resolve();
      await forwarded.promise;
      await resolution.catch(() => {});
      vi.useRealTimers();
      await fixture.close();
    }
  },
);

it.each(["channel", "tool"] as const)(
  "resolves %s approvals without caller-thread SQL",
  async (route) => {
    const fixture = createFixture();
    const record = fixture.exec.create(
      { command: "echo synthetic" },
      60_000,
      `internal-verdict-${route}`,
    );
    const { decision } = await fixture.exec.register(record, 60_000);
    const sql = observeMainThreadSql();
    try {
      sql.calibrate();
      await fixture.resolve(record.id, route);
      await expect(decision).resolves.toBe("allow-once");
      sql.expectIdle();
    } finally {
      sql.restore();
      await fixture.close();
    }
  },
);

it("runs legacy SDK approval callbacks at worker commit without host SQLite", async () => {
  const fixture = createFixture();
  const record = fixture.exec.create({ command: "echo synthetic" }, 60_000, "opaque-verdict");
  const { decision } = await fixture.exec.register(record, 60_000);
  const callback = vi.fn();
  const sql = observeMainThreadSql();
  try {
    sql.calibrate();
    await fixture.resolve(record.id, "tool", () => true, callback);
    await expect(decision).resolves.toBe("allow-once");
    expect(callback).toHaveBeenCalled();
    sql.expectIdle();
  } finally {
    sql.restore();
    await fixture.close();
  }
});

it("denies a malformed internal verdict through the same worker owner", async () => {
  const fixture = createFixture();
  const record = fixture.exec.create({ command: "echo synthetic" }, 60_000, "malformed-verdict");
  const { decision } = await fixture.exec.register(record, 60_000);
  const sql = observeMainThreadSql();
  try {
    sql.calibrate();
    await expect(
      fixture.runtime.nativeApprovals.request("approval.resolve", {
        id: record.id,
        kind: "plugin",
        decision: "allow-once",
      }),
    ).resolves.toMatchObject({
      applied: true,
      approval: { status: "denied", reason: "malformed-verdict" },
    });
    await expect(decision).resolves.toBe("deny");
    sql.expectIdle();
  } finally {
    sql.restore();
    await fixture.close();
  }
});

it("mints a cron standing grant with the internal approval verdict in the worker", async () => {
  const now = Date.now();
  const job: CronStoredJob = {
    id: "internal-grant-job",
    agentId: "main",
    name: "Synthetic grant job",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "echo synthetic" },
    state: {},
  };
  const database = openOpenClawStateDatabase({ env: state.env });
  const storePath = state.statePath("cron");
  upsertCronJobRow(database.db, storePath, job, 0);
  const loaded = loadedCronStoreFromRows(loadCronRows(database.db, storePath)).store.jobs[0]!;
  const grant = {
    agentId: "main",
    cronJobId: job.id,
    jobConfigRevision: resolveCronJobConfigRevision(loaded),
    operationBinding: buildCronExecOperationBinding({
      command: "echo synthetic",
      cwd: undefined,
      env: undefined,
    }),
  };
  const fixture = createFixture(grant);
  const record = fixture.exec.create(
    { command: "echo synthetic", agentId: "main" },
    60_000,
    "grant-verdict",
  );
  const { decision } = await fixture.exec.register(record, 60_000);
  const sql = observeMainThreadSql();
  try {
    sql.calibrate();
    await fixture.runtime.nativeApprovals.request("approval.resolve", {
      id: record.id,
      kind: "exec",
      decision: "allow-always",
    });
    await expect(decision).resolves.toBe("allow-always");
    expect(await listCronStandingGrants({ databaseOptions: fixture.databaseOptions })).toEqual([
      expect.objectContaining({ ...grant, mintedByApprovalId: record.id, useCount: 0 }),
    ]);
    sql.expectIdle();
  } finally {
    sql.restore();
    await fixture.close();
  }
});

it.each(["channel", "tool"] as const)(
  "refuses %s approval after its owner retires before commit",
  async (route) => {
    const fixture = createFixture();
    const record = fixture.exec.create(
      { command: "echo synthetic" },
      60_000,
      `internal-revoked-${route}`,
    );
    await fixture.exec.register(record, 60_000);
    let current = true;
    let transaction = 0;
    probe.admission(workerAdmission, (request, grant, admit) => {
      if (request.stage === "transaction") {
        transaction++;
      }
      if (request.stage === "commit" && transaction === (route === "channel" ? 2 : 1)) {
        current = false;
        if (route === "channel") {
          fixture.revoke();
        }
      }
      return admit(request, grant);
    });
    try {
      await expect(fixture.resolve(record.id, route, () => current)).rejects.toThrow();
      expect(transaction).toBe(route === "channel" ? 2 : 1);
      expect(
        getOperatorApproval({ id: record.id, databaseOptions: fixture.databaseOptions }),
      ).toMatchObject({ status: "pending", decision: null });
      expect(record.resolvedAtMs).toBeUndefined();
      expect(fixture.context.approvalEvents?.publishResolved).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  },
);
