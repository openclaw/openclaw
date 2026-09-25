import { afterEach, expect, it, vi, type TestContext } from "vitest";
import type { ExecApprovalRequestPayload } from "../../infra/exec-approvals.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import { invalidateGatewayDeviceRevocation } from "../device-revocation.js";
import type { ExecApprovalManager } from "../exec-approval-manager.js";
import { createPreparedTestApprovalManager } from "../exec-approval-manager.test-support.js";
import * as recordLookup from "./approval-record-lookup.js";
import {
  createApprovalInvocation,
  createClient,
  getOperatorApproval,
} from "./approval.test-support.js";
import {
  createExecApprovalFixture,
  createApprovalRuntimeClient,
} from "./exec-approval.test-support.js";
import { createPluginApprovalHandlers } from "./plugin-approval.js";
import type { GatewayRequestHandlers } from "./types.js";

afterEach(() => vi.restoreAllMocks());

type LegacyReadMethod = "exec.approval.get" | "exec.approval.list" | "plugin.approval.list";

async function proveLegacyResponseAuthority<TPayload>(
  fixture: {
    manager: ExecApprovalManager<TPayload>;
    handlers: GatewayRequestHandlers;
    databaseOptions: OpenClawStateDatabaseOptions;
  },
  payload: TPayload,
  method: LegacyReadMethod,
) {
  const { manager, databaseOptions, handlers } = fixture;
  const record = manager.create(payload, 60_000);
  const { decision } = await manager.register(record, 60_000);
  let settled = false;
  void decision.then(() => {
    settled = true;
  });
  const before = getOperatorApproval({ id: record.id, databaseOptions });
  let revoked = false;
  const invocation = createApprovalInvocation({
    handlers,
    method,
    body: { id: record.id },
    client: createClient({ deviceId: "response-reviewer", scopes: ["operator.admin"] }),
    transport: "sdk",
    sessionMutationCommitGuard: () => {
      if (revoked) {
        throw new Error("synthetic response authority revoked");
      }
    },
  });
  if (method === "exec.approval.get") {
    const lookup = recordLookup.resolvePendingApprovalRecord;
    vi.spyOn(recordLookup, "resolvePendingApprovalRecord").mockImplementationOnce(
      async (params) => {
        const result = await lookup(params);
        revoked = true;
        return result;
      },
    );
  } else {
    const list = recordLookup.listVisiblePendingApprovalRequests;
    vi.spyOn(recordLookup, "listVisiblePendingApprovalRequests").mockImplementationOnce(
      async (params) => {
        const result = await list(params);
        revoked = true;
        return result;
      },
    );
  }
  await expect(invocation.invoke()).rejects.toThrow("synthetic response authority revoked");
  expect(invocation.respond).not.toHaveBeenCalled();
  expect(getOperatorApproval({ id: record.id, databaseOptions })).toEqual(before);
  expect(record.resolvedAtMs).toBeUndefined();
  expect(settled).toBe(false);
}

it.for(["exec.approval.get", "exec.approval.list"] as const)(
  "rechecks authority after the lookup helper returns for %s",
  async (method, test) => {
    const fixture = await createExecApprovalFixture(test);
    await fixture.run(() =>
      proveLegacyResponseAuthority(fixture, { command: "echo private approval" }, method),
    );
  },
);

it("rechecks authority after the lookup helper returns for plugin.approval.list", async (test) => {
  const fixture = await createPreparedTestApprovalManager<PluginApprovalRequestPayload>(test, {
    approvalKind: "plugin",
  });
  await fixture.run(() =>
    proveLegacyResponseAuthority(
      { ...fixture, handlers: createPluginApprovalHandlers(fixture.manager) },
      {
        title: "Private plugin approval",
        description: "Synthetic plugin approval",
        allowedDecisions: ["allow-once", "deny"],
      },
      "plugin.approval.list",
    ),
  );
});

async function proveLegacyAuthority<
  TPayload extends ExecApprovalRequestPayload | PluginApprovalRequestPayload,
>(
  fixture: {
    manager: ExecApprovalManager<TPayload>;
    handlers: GatewayRequestHandlers;
    databaseOptions: OpenClawStateDatabaseOptions;
  },
  payload: TPayload,
  kind: "exec" | "plugin",
  revoke: boolean,
  autoReview = false,
) {
  const { manager, handlers, databaseOptions } = fixture;
  const record = manager.create(payload, 60_000, `legacy-${kind}-${revoke}`);
  record.approvalReviewerDeviceIds = ["legacy-reviewer"];
  const { decision } = await manager.register(record, 60_000);
  let settled = false;
  void decision.then(() => {
    settled = true;
  });
  const before = getOperatorApproval({ id: record.id, databaseOptions });
  const connection = new AbortController();
  const client = createClient({ deviceId: "legacy-reviewer" });
  client.connectionSignal = connection.signal;
  if (autoReview) {
    client.internal = createApprovalRuntimeClient("legacy-auto", "legacy-reviewer", {
      agentId: "main",
      sessionKey: "agent:main:legacy",
    })?.internal;
  }
  let nativeRevoked = false;
  const nativeGuard = vi.fn(() => {
    getOperatorApproval({ id: record.id, databaseOptions });
    if (nativeRevoked) {
      throw new Error("synthetic SDK guard revoked");
    }
  });
  const invocation = createApprovalInvocation({
    handlers,
    method: kind === "exec" ? "exec.approval.resolve" : "plugin.approval.resolve",
    body: { id: record.id, decision: "allow-once" },
    client,
    ...(autoReview ? { transport: "sdk" as const, sessionMutationCommitGuard: nativeGuard } : {}),
  });
  const stages: string[] = [];
  if (autoReview) {
    const resolve = manager.resolveAutoReview.bind(manager);
    vi.spyOn(manager, "resolveAutoReview").mockImplementationOnce((...args) => {
      connection.abort();
      stages.push("transport-retired", "sdk-verdict");
      nativeRevoked = revoke;
      return resolve(...args);
    });
  } else {
    const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (admit, attachment) =>
        createAdmission((request, grant) => {
          if (request.stage === "transaction") {
            connection.abort();
            stages.push("transport-retired");
          } else if (request.stage === "commit") {
            stages.push("verdict-commit");
            if (revoke) {
              invalidateGatewayDeviceRevocation(invocation.context, "legacy-reviewer", "operator");
            }
          }
          return admit(request, grant);
        }, attachment),
    );
  }
  const response = await invocation.invoke();
  expect(stages).toEqual(["transport-retired", autoReview ? "sdk-verdict" : "verdict-commit"]);
  if (autoReview) {
    expect(nativeGuard).toHaveBeenCalled();
  }
  if (revoke) {
    expect(getOperatorApproval({ id: record.id, databaseOptions })).toEqual(before);
    expect(record.resolvedAtMs).toBeUndefined();
    expect(settled).toBe(false);
    expect(response.ok).toBe(false);
    expect(client.invalidated).not.toBe(true);
    expect(invocation.context.approvalEvents?.publishResolved).not.toHaveBeenCalled();
    expect(invocation.context.broadcastToConnIds).not.toHaveBeenCalled();
  } else {
    expect(response.ok).toBe(true);
    expect(getOperatorApproval({ id: record.id, databaseOptions })).toMatchObject({
      status: "allowed",
      decision: "allow-once",
    });
    await expect(decision).resolves.toBe("allow-once");
    expect(record.resolutionSource).toBe(autoReview ? "auto-review" : "operator");
    expect(invocation.context.approvalEvents?.publishResolved).toHaveBeenCalledTimes(1);
  }
}

it.for([false, true])(
  "retains exec RPC authority after disconnect (revoked: %s)",
  async (revoke, test: TestContext) => {
    const fixture = await createExecApprovalFixture(test);
    await fixture.run(() =>
      proveLegacyAuthority(fixture, { command: "echo legacy" }, "exec", revoke),
    );
  },
);

it.for([false, true])(
  "retains plugin RPC authority after disconnect (revoked: %s)",
  async (revoke, test: TestContext) => {
    const fixture = await createPreparedTestApprovalManager<PluginApprovalRequestPayload>(test, {
      approvalKind: "plugin",
    });
    await fixture.run(() =>
      proveLegacyAuthority(
        { ...fixture, handlers: createPluginApprovalHandlers(fixture.manager) },
        {
          title: "Synthetic action",
          description: "Approve a synthetic plugin operation",
          allowedDecisions: ["allow-once", "deny"],
        },
        "plugin",
        revoke,
      ),
    );
  },
);

it.for([false, true])(
  "retains auto-review through the opaque SDK guard (revoked: %s)",
  async (revoke, test) => {
    const fixture = await createExecApprovalFixture(test);
    await fixture.run(() =>
      proveLegacyAuthority(
        fixture,
        {
          command: "echo legacy",
          commandArgv: ["echo", "legacy"],
          host: "node",
          nodeId: "synthetic-node",
          agentId: "main",
          sessionKey: "agent:main:legacy",
          systemRunPlan: {
            argv: ["echo", "legacy"],
            cwd: "/tmp",
            commandText: "echo legacy",
            agentId: "main",
            sessionKey: "agent:main:legacy",
          },
        },
        "exec",
        revoke,
        true,
      ),
    );
  },
);

it.for([false, true])(
  "retains legacy lookup expiry authority after disconnect (revoked: %s)",
  async (revoke, test) => {
    const fixture = await createExecApprovalFixture(test);
    await fixture.run(async () => {
      const { manager, handlers, databaseOptions } = fixture;
      const record = manager.create({ command: "echo expiry" }, 60_000, `legacy-expiry-${revoke}`);
      record.approvalReviewerDeviceIds = ["legacy-expiry-reviewer"];
      const { decision } = await manager.register(record, 60_000);
      let settled = false;
      void decision.then(() => {
        settled = true;
      });
      const before = getOperatorApproval({
        id: record.id,
        nowMs: record.createdAtMs,
        databaseOptions,
      });
      const connection = new AbortController();
      const client = createClient({
        deviceId: "legacy-expiry-reviewer",
        scopes: ["operator.admin"],
      });
      client.connectionSignal = connection.signal;
      const invocation = createApprovalInvocation({
        handlers,
        method: "exec.approval.get",
        body: { id: record.id },
        client,
      });
      vi.spyOn(Date, "now").mockReturnValue(record.expiresAtMs);
      const stages: string[] = [];
      const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
      vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
        (admit, attachment) =>
          createAdmission((request, grant) => {
            if (request.stage === "transaction") {
              connection.abort();
              stages.push("transport-retired");
            } else if (request.stage === "commit") {
              stages.push("expiry-commit");
              if (revoke) {
                invalidateGatewayDeviceRevocation(
                  invocation.context,
                  "legacy-expiry-reviewer",
                  "operator",
                );
              }
            }
            return admit(request, grant);
          }, attachment),
      );
      if (revoke) {
        await expect(invocation.invoke()).rejects.toThrow(/authority/u);
        expect(
          getOperatorApproval({ id: record.id, nowMs: record.createdAtMs, databaseOptions }),
        ).toEqual(before);
        expect(record.resolvedAtMs).toBeUndefined();
        expect(settled).toBe(false);
      } else {
        expect(await invocation.invoke()).toMatchObject({ ok: false });
        expect(getOperatorApproval({ id: record.id, databaseOptions })).toMatchObject({
          status: "expired",
          terminalReason: "timeout",
        });
        await expect(decision).resolves.toBeNull();
      }
      expect(stages).toEqual(["transport-retired", "expiry-commit"]);
    });
  },
);
