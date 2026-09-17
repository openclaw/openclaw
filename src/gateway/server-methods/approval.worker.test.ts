import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, it, expect, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import type { SystemAgentApprovalRequestPayload } from "../../infra/system-agent-approvals.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { bumpGatewayAccessRevision } from "../gateway-access-revision.js";
import * as operatorApprovalStore from "../operator-approval-store.async.js";
import * as nativeOperatorApprovalStore from "../operator-approval-store.js";
import { createApprovalHandlers } from "./approval.js";
import { createClient, createContext, invoke } from "./approval.test-support.js";

function createFixture() {
  const persistence = { runtimeEpoch: "deferred-lookup-test" };
  const managers = {
    exec: new ExecApprovalManager({ persistence }),
    plugin: new ExecApprovalManager<PluginApprovalRequestPayload>({ persistence }),
    systemAgent: new ExecApprovalManager<SystemAgentApprovalRequestPayload>({ persistence }),
  };
  const handlers = createApprovalHandlers({
    execApprovalManager: managers.exec,
    pluginApprovalManager: managers.plugin,
    systemAgentApprovalManager: managers.systemAgent,
  });
  return { managers, handlers };
}

function createPendingFixture() {
  const { managers, handlers } = createFixture();
  const record = managers.exec.create({ command: "echo fixture" }, 60_000, "refused-lookup");
  let stored: nativeOperatorApprovalStore.OperatorApprovalRecord | undefined;
  vi.spyOn(nativeOperatorApprovalStore, "insertOperatorApproval").mockImplementation(
    ({ approval }) => {
      stored = {
        ...approval,
        resolutionRef: "fixture:refused-lookup",
        status: "pending",
        requester: { deviceId: null, clientId: null, deviceTokenAuth: false },
        reviewerDeviceIds: [],
        source: {
          agentId: null,
          sessionKey: null,
          sessionId: null,
          runId: null,
          toolCallId: null,
          toolName: null,
        },
        audienceSessionKeys: [],
        updatedAtMs: approval.createdAtMs,
        decision: null,
        terminalReason: null,
        resolvedAtMs: null,
        resolver: null,
        consumedAtMs: null,
        consumedBy: null,
      };
      return { outcome: "inserted", record: stored };
    },
  );
  const deny = vi
    .spyOn(nativeOperatorApprovalStore, "forceDenyOperatorApproval")
    .mockReturnValue({ outcome: "not-found" });
  const decision = managers.exec.register(record, 60_000);
  return {
    managers,
    handlers,
    record,
    stored: expectDefined(stored, "registered fixture"),
    deny,
    decision,
  };
}

afterEach(() => vi.restoreAllMocks());

it.each([
  { method: "approval.get" as const, rejects: false },
  { method: "approval.get" as const, rejects: true },
  { method: "approval.resolve" as const, rejects: false },
  { method: "approval.resolve" as const, rejects: true },
])(
  "does not reconcile revoked access after $method storage wait (rejects=$rejects)",
  async ({ method, rejects }) => {
    const { managers, handlers } = createFixture();
    const started = createDeferred();
    const lookup =
      createDeferred<
        Awaited<ReturnType<typeof operatorApprovalStore.getOperatorApprovalDetailedAsync>>
      >();
    vi.spyOn(operatorApprovalStore, "getOperatorApprovalDetailedAsync").mockImplementation(() => {
      started.resolve();
      return lookup.promise;
    });
    const reconciliations = [managers.exec, managers.plugin, managers.systemAgent].map((manager) =>
      vi.spyOn(manager, "reconcileDurableLookup"),
    );
    const client = createClient({ deviceId: "reviewer" });
    if (!client) {
      throw new Error("expected fixture client");
    }
    const pending = invoke({
      handlers,
      method,
      body:
        method === "approval.get"
          ? { id: "revoked-lookup" }
          : { id: "revoked-lookup", kind: "exec", decision: "allow-once" },
      client,
    });
    await started.promise;
    client.connect.scopes = [];
    if (rejects) {
      lookup.reject(new Error("controlled lookup failure"));
    } else {
      lookup.resolve({ outcome: "not-found" });
    }
    expect(await pending).toMatchObject({ ok: false, error: { message: "approval not found" } });
    for (const reconcile of reconciliations) {
      expect(reconcile).not.toHaveBeenCalled();
    }
  },
);

it.each(["closed", "overloaded", "unavailable", "outcome-unknown"] as const)(
  "preserves a pending approval after a %s worker lookup refusal",
  async (code) => {
    const { managers, handlers, record, stored, deny, decision } = createPendingFixture();
    try {
      let decided = false;
      void decision.then(() => {
        decided = true;
      });
      const lookup = vi
        .spyOn(operatorApprovalStore, "getOperatorApprovalDetailedAsync")
        .mockRejectedValueOnce(
          new AggregateError([new SqliteWorkerError("controlled worker refusal", code)]),
        )
        .mockResolvedValue({
          outcome: "found",
          record: stored,
        });
      const client = createClient({ deviceId: "reviewer" });
      expect(
        await invoke({ handlers, method: "approval.get", body: { id: record.id }, client }),
      ).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
      expect(record.resolvedAtMs).toBeUndefined();
      expect(record.terminalReason).toBeUndefined();
      expect(decided).toBe(false);
      expect(managers.exec.getLiveSnapshot(record.id)).toBe(record);
      expect(
        await invoke({ handlers, method: "approval.get", body: { id: record.id }, client }),
      ).toMatchObject({ ok: true, result: { approval: { status: "pending" } } });
      expect(lookup).toHaveBeenCalledTimes(2);
      expect(deny).not.toHaveBeenCalled();
      expect(decided).toBe(false);
    } finally {
      await Promise.all(Object.values(managers).map((manager) => manager.drain()));
    }
  },
);

it.each(["approval.get", "approval.history"] as const)(
  "continues accepted %s work after a transport disconnect",
  async (method) => {
    const { managers, handlers, record, stored, deny } = createPendingFixture();
    const started = createDeferred();
    const lookup =
      createDeferred<
        Awaited<ReturnType<typeof operatorApprovalStore.getOperatorApprovalDetailedAsync>>
      >();
    const history =
      createDeferred<
        Awaited<ReturnType<typeof operatorApprovalStore.listTerminalOperatorApprovalsAsync>>
      >();
    let assertCurrent: (() => void) | undefined;
    vi.spyOn(operatorApprovalStore, "getOperatorApprovalDetailedAsync").mockImplementation(
      (params) => {
        assertCurrent = params.assertCurrent;
        started.resolve();
        return lookup.promise;
      },
    );
    vi.spyOn(operatorApprovalStore, "listTerminalOperatorApprovalsAsync").mockImplementation(() => {
      started.resolve();
      return history.promise;
    });
    const controller = new AbortController();
    const client = expectDefined(createClient({ deviceId: "reviewer" }), "fixture client");
    client.connectionSignal = controller.signal;
    const pending = invoke({
      handlers,
      method,
      body: method === "approval.get" ? { id: record.id } : {},
      client,
    });
    try {
      await started.promise;
      controller.abort();
      if (method === "approval.get") {
        expect(expectDefined(assertCurrent, "lookup admission")).not.toThrow();
      }
      lookup.resolve({ outcome: "found", record: stored });
      history.resolve({ records: [] });
      expect(await pending).toMatchObject({
        ok: true,
        result: method === "approval.get" ? { approval: { status: "pending" } } : { items: [] },
      });
      expect(managers.exec.getLiveSnapshot(record.id)).toBe(record);
      expect(record.resolvedAtMs).toBeUndefined();
      expect(deny).not.toHaveBeenCalled();
    } finally {
      lookup.resolve({ outcome: "found", record: stored });
      history.resolve({ records: [] });
      await pending;
      await Promise.all(Object.values(managers).map((manager) => manager.drain()));
    }
  },
);

it.each(["scope", "invalidated"] as const)(
  "does not publish history after %s revocation during its storage wait",
  async (change) => {
    const { handlers } = createFixture();
    const started = createDeferred();
    const history =
      createDeferred<
        Awaited<ReturnType<typeof operatorApprovalStore.listTerminalOperatorApprovalsAsync>>
      >();
    vi.spyOn(operatorApprovalStore, "listTerminalOperatorApprovalsAsync").mockImplementation(() => {
      started.resolve();
      return history.promise;
    });
    const client = createClient({ deviceId: "reviewer" });
    if (!client) {
      throw new Error("expected fixture client");
    }
    const pending = invoke({ handlers, method: "approval.history", body: {}, client });
    await started.promise;
    if (change === "scope") {
      client.connect.scopes = [];
    } else {
      client.invalidated = true;
    }
    history.resolve({ records: [] });
    expect(await pending).toMatchObject({ ok: false, error: { message: "approval not found" } });
  },
);

it("preserves history access for approval-scoped clients without a device", async () => {
  const { handlers } = createFixture();
  vi.spyOn(operatorApprovalStore, "listTerminalOperatorApprovalsAsync").mockResolvedValue({
    records: [],
  });
  const response = await invoke({
    handlers,
    method: "approval.history",
    body: {},
    client: createClient({}),
  });
  expect(response).toMatchObject({ ok: true, result: { items: [] } });
});

it.each(["access", "reviewer", "source", "binding", "profile", "config"] as const)(
  "refuses %s changes at lookup admission without corruption reconciliation",
  async (change) => {
    const { managers, handlers } = createFixture();
    const record = managers.exec.create(
      { command: "echo fixture", sessionKey: "agent:main:fixture" },
      60_000,
    );
    record.approvalReviewerDeviceIds = ["reviewer"];
    const live = vi.spyOn(managers.exec, "getLiveSnapshot").mockReturnValue(record);
    const binding = vi.spyOn(managers.exec, "hasRegisteredRecord").mockReturnValue(true);
    const reconcile = vi.spyOn(managers.exec, "reconcileDurableLookup");
    const started = createDeferred<() => void>();
    const lookup =
      createDeferred<
        Awaited<ReturnType<typeof operatorApprovalStore.getOperatorApprovalDetailedAsync>>
      >();
    vi.spyOn(operatorApprovalStore, "getOperatorApprovalDetailedAsync").mockImplementation(
      (params) => {
        started.resolve(expectDefined(params.assertCurrent, "lookup admission guard"));
        return lookup.promise;
      },
    );
    const client = expectDefined(createClient({ deviceId: "reviewer" }), "fixture client");
    const context = createContext();
    const pending = invoke({
      handlers,
      method: "approval.get",
      body: { id: record.id },
      client,
      context,
    });
    const guard = await started.promise;
    switch (change) {
      case "access":
        bumpGatewayAccessRevision();
        break;
      case "reviewer":
        record.approvalReviewerDeviceIds = ["other-reviewer"];
        break;
      case "source":
        record.request.sessionKey = "agent:main:other";
        break;
      case "binding":
        live.mockReturnValue(null);
        binding.mockReturnValue(false);
        break;
      case "profile":
        client.authenticatedUserId = "other-user";
        break;
      case "config":
        context.getRuntimeConfig = () => ({});
        break;
    }
    expect(guard).toThrow("Approval lookup authority is no longer active");
    lookup.reject(new Error("controlled admission refusal"));
    expect(await pending).toMatchObject({ ok: false, error: { message: "approval not found" } });
    expect(reconcile).not.toHaveBeenCalled();
  },
);
