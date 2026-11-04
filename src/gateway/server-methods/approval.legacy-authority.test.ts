import { afterEach, expect, it, vi, type TestContext } from "vitest";
import type { ExecApprovalRequestPayload } from "../../infra/exec-approvals.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import { invalidateGatewayDeviceRevocation } from "../device-revocation.js";
import type { ExecApprovalManager } from "../exec-approval-manager.js";
import { createPreparedTestApprovalManager } from "../exec-approval-manager.test-support.js";
import * as approvalStore from "../operator-approval-store.js";
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

type Payload = ExecApprovalRequestPayload | PluginApprovalRequestPayload;
type Fixture<T> = {
  manager: ExecApprovalManager<T>;
  handlers: GatewayRequestHandlers;
  databaseOptions: OpenClawStateDatabaseOptions;
};
const runtimeIdentity = { agentId: "main", sessionKey: "agent:main:legacy" };
const legacyCommand = { command: "echo legacy" };
const autoReviewCommand = {
  ...legacyCommand,
  ...runtimeIdentity,
  commandArgv: ["echo", "legacy"],
  host: "node",
  nodeId: "synthetic-node",
  systemRunPlan: {
    ...runtimeIdentity,
    argv: ["echo", "legacy"],
    cwd: "/tmp",
    commandText: "echo legacy",
  },
};

function after<A extends unknown[], R>(fn: (...args: A) => Promise<R>, effect: () => void) {
  return async (...args: A) => {
    const result = await fn(...args);
    effect();
    return result;
  };
}

async function withKind(
  test: TestContext,
  kind: "exec" | "plugin",
  run: <T extends Payload>(fixture: Fixture<T>, payload: T) => Promise<void>,
) {
  if (kind === "exec") {
    const fixture = await createExecApprovalFixture(test);
    return fixture.run(() => run(fixture, legacyCommand));
  }
  const fixture = await createPreparedTestApprovalManager<PluginApprovalRequestPayload>(test, {
    approvalKind: "plugin",
  });
  return fixture.run(() =>
    run(
      { ...fixture, handlers: createPluginApprovalHandlers(fixture.manager) },
      {
        title: "Synthetic action",
        description: "Approve a synthetic plugin operation",
        allowedDecisions: ["allow-once", "deny"],
      },
    ),
  );
}

async function register<T>(fixture: Fixture<T>, payload: T, id?: string, reviewer = false) {
  const { manager, databaseOptions } = fixture;
  const record = manager.create(payload, 60_000, id);
  if (reviewer) {
    record.approvalReviewerDeviceIds = ["legacy-reviewer"];
  }
  const { decision } = await manager.register(record, 60_000);
  const state = { settled: false };
  void decision.then(() => {
    state.settled = true;
  });
  const read = (nowMs?: number) => getOperatorApproval({ id: record.id, databaseOptions, nowMs });
  const before = read(record.createdAtMs);
  const expectUnchanged = () => {
    expect(read(record.createdAtMs)).toEqual(before);
    expect({ resolvedAtMs: record.resolvedAtMs, ...state }).toEqual({
      resolvedAtMs: undefined,
      settled: false,
    });
  };
  return { record, decision, read, expectUnchanged };
}

function retireAtCommit(
  invocation: ReturnType<typeof createApprovalInvocation>,
  connection: AbortController,
  revoke: boolean,
  stage: string,
) {
  const stages: string[] = [];
  probe.admission(workerAdmission, (request, grant, admit) => {
    if (request.stage === "transaction") {
      connection.abort();
      stages.push("transport-retired");
    } else if (request.stage === "commit") {
      stages.push(stage);
      if (revoke) {
        invalidateGatewayDeviceRevocation(invocation.context, "legacy-reviewer", "operator");
      }
    }
    return admit(request, grant);
  });
  return stages;
}

it.for([
  { operation: "list", stage: "settlement" },
  { operation: "revoke", stage: "settlement" },
  { operation: "revoke", stage: "commit" },
] as const)(
  "rechecks grant $operation RPC authority at $stage",
  async ({ operation, stage }, test) => {
    const fixture = await createExecApprovalFixture(test);
    await fixture.run(async () => {
      const client = createClient({ deviceId: "grant-reviewer", scopes: ["operator.admin"] });
      const invocation = createApprovalInvocation({
        handlers: fixture.handlers,
        method: operation === "list" ? "exec.approval.grants.list" : "exec.approval.grants.revoke",
        body: operation === "list" ? {} : { grantId: "missing" },
        client,
      });
      const invalidate = () => {
        client.invalidated = true;
      };
      if (operation === "list") {
        const list = approvalStore.listCronStandingGrants;
        vi.spyOn(approvalStore, "listCronStandingGrants").mockImplementationOnce(
          after(
            (params: Parameters<typeof list>[0]) =>
              list({ ...params, databaseOptions: fixture.databaseOptions }),
            invalidate,
          ),
        );
      } else {
        const revoke = approvalStore.revokeCronStandingGrant;
        vi.spyOn(approvalStore, "revokeCronStandingGrant").mockImplementationOnce(
          after(
            (params: Parameters<typeof revoke>[0]) =>
              revoke({ ...params, databaseOptions: fixture.databaseOptions }),
            () => {
              if (stage === "settlement") {
                invalidate();
              }
            },
          ),
        );
      }
      if (stage === "commit") {
        probe.admission(workerAdmission, (request, grant, admit) => {
          if (request.stage === "commit") {
            client.invalidated = true;
          }
          return admit(request, grant);
        });
      }
      await expect(invocation.invoke()).rejects.toThrow(/authority/i);
      expect(invocation.respond).not.toHaveBeenCalled();
    });
  },
);

it.for(["exec.approval.get", "exec.approval.list", "plugin.approval.list"] as const)(
  "rechecks authority after the lookup helper returns for %s",
  (method, test) =>
    withKind(
      test,
      method === "plugin.approval.list" ? "plugin" : "exec",
      async (fixture, payload) => {
        const { record, expectUnchanged } = await register(fixture, payload);
        let revoked = false;
        const invocation = createApprovalInvocation({
          handlers: fixture.handlers,
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
        const invalidate = () => {
          revoked = true;
        };
        if (method === "exec.approval.get") {
          const lookup = recordLookup.resolvePendingApprovalRecord;
          vi.spyOn(recordLookup, "resolvePendingApprovalRecord").mockImplementationOnce(
            after(lookup, invalidate),
          );
        } else {
          const list = recordLookup.listVisiblePendingApprovalRequests;
          vi.spyOn(recordLookup, "listVisiblePendingApprovalRequests").mockImplementationOnce(
            after(list, invalidate),
          );
        }
        await expect(invocation.invoke()).rejects.toThrow("synthetic response authority revoked");
        expect(invocation.respond).not.toHaveBeenCalled();
        expectUnchanged();
      },
    ),
);

it.for([
  { kind: "exec", revoke: true },
  { kind: "plugin", revoke: false },
  { kind: "auto-review", revoke: false },
  { kind: "auto-review", revoke: true },
] as const)(
  "retains $kind verdict authority after disconnect (revoked: $revoke)",
  ({ kind, revoke }, test) =>
    withKind(test, kind === "plugin" ? "plugin" : "exec", async (fixture, base) => {
      const autoReview = kind === "auto-review";
      const payload = { ...base, ...(autoReview ? autoReviewCommand : {}) };
      const { manager, handlers } = fixture;
      const { record, decision, read, expectUnchanged } = await register(
        fixture,
        payload,
        `legacy-${kind}-${revoke}`,
        true,
      );
      const connection = new AbortController();
      const client = createClient({ deviceId: "legacy-reviewer" });
      client.connectionSignal = connection.signal;
      if (autoReview) {
        client.internal = createApprovalRuntimeClient(
          "legacy-auto",
          "legacy-reviewer",
          runtimeIdentity,
        )?.internal;
      }
      let nativeRevoked = false;
      const nativeGuard = vi.fn(() => {
        if (nativeRevoked) {
          throw new Error("synthetic SDK guard revoked");
        }
      });
      const invocation = createApprovalInvocation({
        handlers,
        method: kind === "plugin" ? "plugin.approval.resolve" : "exec.approval.resolve",
        body: { id: record.id, decision: "allow-once" },
        client,
        ...(autoReview
          ? { transport: "sdk" as const, sessionMutationCommitGuard: nativeGuard }
          : {}),
      });
      let stages: string[] = [];
      if (autoReview) {
        const resolve = manager.resolveAutoReview.bind(manager);
        vi.spyOn(manager, "resolveAutoReview").mockImplementationOnce((...args) => {
          connection.abort();
          stages.push("transport-retired", "sdk-verdict");
          nativeRevoked = revoke;
          return resolve(...args);
        });
      } else {
        stages = retireAtCommit(invocation, connection, revoke, "verdict-commit");
      }
      const response = await invocation.invoke();
      expect(stages).toEqual(["transport-retired", autoReview ? "sdk-verdict" : "verdict-commit"]);
      if (autoReview) {
        expect(nativeGuard).toHaveBeenCalled();
      }
      if (revoke) {
        expectUnchanged();
        expect(response.ok).toBe(false);
        expect(client.invalidated).not.toBe(true);
        expect(invocation.context.approvalEvents?.publishResolved).not.toHaveBeenCalled();
        expect(invocation.context.broadcastToConnIds).not.toHaveBeenCalled();
      } else {
        expect(response.ok).toBe(true);
        expect(read()).toMatchObject({
          status: "allowed",
          decision: "allow-once",
        });
        await expect(decision).resolves.toBe("allow-once");
        expect(record.resolutionSource).toBe(autoReview ? "auto-review" : "operator");
        expect(invocation.context.approvalEvents?.publishResolved).toHaveBeenCalledTimes(1);
      }
    }),
);

it.for([false, true])(
  "retains legacy lookup expiry authority after disconnect (revoked: %s)",
  async (revoke, test) => {
    const fixture = await createExecApprovalFixture(test);
    await fixture.run(async () => {
      const { record, decision, read, expectUnchanged } = await register(
        fixture,
        { command: "echo expiry" },
        `legacy-expiry-${revoke}`,
        true,
      );
      const connection = new AbortController();
      const client = createClient({
        deviceId: "legacy-reviewer",
        scopes: ["operator.admin"],
      });
      client.connectionSignal = connection.signal;
      const invocation = createApprovalInvocation({
        handlers: fixture.handlers,
        method: "exec.approval.get",
        body: { id: record.id },
        client,
      });
      vi.spyOn(Date, "now").mockReturnValue(record.expiresAtMs);
      const stages = retireAtCommit(invocation, connection, revoke, "expiry-commit");
      if (revoke) {
        await expect(invocation.invoke()).rejects.toThrow(/authority/u);
        expectUnchanged();
      } else {
        expect(await invocation.invoke()).toMatchObject({ ok: false });
        expect(read()).toMatchObject({
          status: "expired",
          terminalReason: "timeout",
        });
        await expect(decision).resolves.toBeNull();
      }
      expect(stages).toEqual(["transport-retired", "expiry-commit"]);
    });
  },
);
