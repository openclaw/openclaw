import { expectDefined } from "@openclaw/normalization-core";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import type { ExecApprovalManager } from "../exec-approval-manager.js";
import { createTestApprovalManager } from "../exec-approval-manager.test-support.js";
import { createPluginApprovalHandlers } from "./plugin-approval.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

function createApprovalContext(hasExecApprovalClients = () => true) {
  return {
    getRuntimeConfig: () => ({}),
    broadcast: vi.fn(),
    logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    hasExecApprovalClients,
  } as unknown as GatewayRequestHandlerOptions["context"];
}

function createClient(
  params: {
    connId?: string;
    clientId?: string;
    deviceId?: string;
    scopes?: string[];
    approvalRuntime?: boolean;
    pluginApprovalRequestOwnerId?: string;
  } = {},
): GatewayRequestHandlerOptions["client"] {
  return {
    connId: params.connId ?? "conn-test-client",
    connect: {
      client: { id: params.clientId ?? "test-client", displayName: "Test Client" },
      ...(params.deviceId ? { device: { id: params.deviceId } } : {}),
      ...(params.scopes ? { scopes: params.scopes } : {}),
    },
    ...(params.approvalRuntime || params.pluginApprovalRequestOwnerId
      ? {
          internal: {
            ...(params.approvalRuntime ? { approvalRuntime: true } : {}),
            ...(params.pluginApprovalRequestOwnerId
              ? { pluginApprovalRequestOwnerId: params.pluginApprovalRequestOwnerId }
              : {}),
          },
        }
      : {}),
  } as unknown as GatewayRequestHandlerOptions["client"];
}

function createMockOptions(
  method: string,
  params: Record<string, unknown>,
  overrides?: Partial<GatewayRequestHandlerOptions>,
): GatewayRequestHandlerOptions {
  return {
    req: { method, params, id: "req-1" },
    params,
    client: createClient(),
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: createApprovalContext(),
    ...overrides,
  } as unknown as GatewayRequestHandlerOptions;
}

function invokeHandler(
  handlers: ReturnType<typeof createPluginApprovalHandlers>,
  options: GatewayRequestHandlerOptions,
) {
  return expectDefined(handlers[options.req.method], "plugin approval handler")(options);
}

type MockCallSource = {
  mock: {
    calls: ArrayLike<ReadonlyArray<unknown>>;
  };
};

const requireRecord = createRequireRecord("object", "expected-label");

function mockCall(source: unknown, index: number, label: string) {
  return expectDefined((source as MockCallSource).mock.calls[index], label);
}

function responseCall(source: unknown, index = 0) {
  const [ok, result, error] = mockCall(source, index, `response call ${index}`);
  return { ok, result, error };
}

function expectResponseOk(source: unknown, index = 0) {
  const call = responseCall(source, index);
  expect(call.ok).toBe(true);
  expect(call.error).toBeUndefined();
  return requireRecord(call.result, `response result ${index}`);
}

function expectResponseRejected(source: unknown, index = 0) {
  const call = responseCall(source, index);
  expect(call.ok).toBe(false);
  return requireRecord(call.error, `response error ${index}`);
}

function createOwnedClient(owner: "owner" | "other" = "owner", scopes?: string[]) {
  return createClient({
    connId: `conn-${owner}`,
    clientId: `client-${owner}`,
    deviceId: `device-${owner}`,
    scopes,
  });
}

async function registerApproval(
  approvalManager: ExecApprovalManager<PluginApprovalRequestPayload>,
  params: {
    title?: string;
    id?: string;
    allowedDecisions?: PluginApprovalRequestPayload["allowedDecisions"];
  } = {},
) {
  const request = {
    title: params.title ?? "T",
    description: "D",
    ...(params.allowedDecisions ? { allowedDecisions: params.allowedDecisions } : {}),
  };
  const record = approvalManager.create(request, 60_000, params.id);
  await approvalManager.register(record, 60_000);
  return record;
}

async function registerOwnedApproval(
  approvalManager: ExecApprovalManager<PluginApprovalRequestPayload>,
  params: { title: string; id?: string; owner?: "owner" | "other" },
) {
  const record = await registerApproval(approvalManager, { title: params.title, id: params.id });
  const owner = params.owner ?? "owner";
  record.requestedByDeviceId = `device-${owner}`;
  record.requestedByConnId = `conn-${owner}`;
  record.requestedByClientId = `client-${owner}`;
  return record;
}

function broadcastCall(opts: GatewayRequestHandlerOptions, index = 0) {
  const call = mockCall(opts.context.broadcast, index, "broadcast call");
  return {
    event: call?.[0],
    payload: requireRecord(call?.[1], "broadcast payload"),
    options: call?.[2],
  };
}

describe("createPluginApprovalHandlers", () => {
  let manager: ExecApprovalManager<PluginApprovalRequestPayload>;
  let handlers: ReturnType<typeof createPluginApprovalHandlers>;

  beforeEach((testContext) => {
    manager = createTestApprovalManager<PluginApprovalRequestPayload>(testContext, {
      approvalKind: "plugin",
    });
    handlers = createPluginApprovalHandlers(manager);
  });

  async function startRequest(
    params: Record<string, unknown> = {},
    overrides: Partial<GatewayRequestHandlerOptions> = {},
    requestHandlers = handlers,
  ) {
    const firstResponse = createDeferred();
    const respond = vi.fn(() => firstResponse.resolve());
    const opts = createMockOptions(
      "plugin.approval.request",
      { title: "Sensitive action", description: "Desc", twoPhase: true, ...params },
      { ...overrides, respond },
    );
    const pending = invokeHandler(requestHandlers, opts);
    await firstResponse.promise;
    const accepted = expectResponseOk(respond);
    expect(accepted.status).toBe("accepted");
    const id = accepted.id;
    if (typeof id !== "string") {
      throw new Error("Expected accepted approval id");
    }
    return { opts, respond, pending, id };
  }

  async function call(
    method: string,
    params: Record<string, unknown> = {},
    overrides: Partial<GatewayRequestHandlerOptions> = {},
  ) {
    const opts = createMockOptions(`plugin.approval.${method}`, params, overrides);
    await invokeHandler(handlers, opts);
    return opts.respond;
  }

  async function settle(
    { id, pending }: { id: string; pending: ReturnType<typeof invokeHandler> },
    decision: "allow-once" | "deny" = "allow-once",
  ) {
    await manager.resolve(id, decision);
    await pending;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("plugin.approval.request", () => {
    it("binds a host-authorized request to its real plugin owner and reviewer devices", async () => {
      const approval = await startRequest(
        { approvalReviewerDeviceIds: ["reviewer-device"] },
        { client: createClient({ pluginApprovalRequestOwnerId: "lobster" }) },
      );
      const { opts, respond, id } = approval;
      expect(await manager.getSnapshot(id)).toMatchObject({
        requestedByClientId: "test-client",
        request: { pluginId: "lobster", detail: null },
        approvalReviewerDeviceIds: ["reviewer-device"],
      });
      expect(broadcastCall(opts)).toMatchObject({
        event: "plugin.approval.requested",
        payload: { approvalKind: "plugin", id },
      });
      expect(broadcastCall(opts).options).toEqual({ dropIfSlow: true });
      await settle(approval);
      expect(expectResponseOk(respond, 1)).toMatchObject({ id, decision: "allow-once" });
    });

    it("rejects a host-authorized request claiming a different plugin", async () => {
      const respond = await call(
        "request",
        { pluginId: "different", title: "Review workflow", description: "Approve one action" },
        { client: createClient({ pluginApprovalRequestOwnerId: "lobster" }) },
      );
      expect(expectResponseRejected(respond).message).toMatch(/owner does not match host/);
      expect(await manager.listPendingRecords()).toHaveLength(0);
    });

    it("sanitizes title/description/detail at creation so every surface gets safe text", async () => {
      const { opts, respond, pending, id } = await startRequest({
        // Bidi override + zero-width space: the classic reviewer-spoof pair.
        title: "Deploy‮yolped",
        description: "safe​text",
        // Passes the protocol's 16,384 raw cap but expands past it once
        // invisibles become \u{...} escapes — the storage cap must re-apply.
        detail: `line‪one${"‮".repeat(2_100)}`,
        severity: "warning",
        // Metadata is interpolated into channel approval text lines.
        pluginId: "plug‮in",
        toolName: "tool​run",
        agentId: "agent‪x",
      });
      const stored = (await manager.getSnapshot(id))?.request;
      expect(stored).toMatchObject({
        title: "Deploy\\u{202E}yolped",
        description: "safe\\u{200B}text",
        pluginId: "plug\\u{202E}in",
        toolName: "tool\\u{200B}run",
        agentId: "agent\\u{202A}x",
      });
      expect(stored?.detail?.startsWith("line\\u{202A}one")).toBe(true);
      // Stored detail is capped like the durable presentation's copy.
      expect(Array.from(stored?.detail ?? "").length).toBeLessThanOrEqual(16_384);
      expect(stored?.detail?.endsWith("…[truncated]")).toBe(true);
      // The live broadcast payload is built from the stored record, so it is
      // now safe for channels/push/web without per-surface re-sanitizing.
      const requestedBroadcast = broadcastCall(opts);
      expect(requestedBroadcast.payload.request).toMatchObject({
        title: "Deploy\\u{202E}yolped",
        description: "safe\\u{200B}text",
      });
      await settle({ id, pending }, "deny");
      expect(expectResponseOk(respond, 1)).toMatchObject({ id, decision: "deny" });
    });

    it("sanitizes owner-declared scope before storing or broadcasting the approval", async () => {
      const { pending, id } = await startRequest({
        scope: {
          kind: "message-send",
          target: "email\u202Esystem",
          recipientCount: 3,
          recipients: ["alice\u200B@example.com", "bob@example.com"],
          audience: "external",
        },
      });
      expect((await manager.getSnapshot(id))?.request.scope).toEqual({
        kind: "message-send",
        target: "email\\u{202E}system",
        recipientCount: 3,
        recipients: ["alice\\u{200B}@example.com", "bob@example.com"],
        audience: "external",
      });
      await settle({ id, pending });
    });

    it("drops scope after escaped text exceeds its bounds without rejecting approval", async () => {
      const { pending, id } = await startRequest({
        scope: {
          kind: "external-post",
          target: `github${"\u202E".repeat(20)}`,
          visibility: "public",
        },
      });
      expect((await manager.getSnapshot(id))?.request.scope).toBeNull();
      await settle({ id, pending });
    });

    it.each([
      { kind: "untyped", target: "email" },
      { kind: "external-post", target: "github", visibility: "public", extra: true },
    ])("rejects malformed or non-closed owner-declared scope %j", async (scope) => {
      const opts = createMockOptions("plugin.approval.request", {
        title: "Sensitive action",
        description: "Review the action",
        scope,
        twoPhase: true,
      });
      await invokeHandler(handlers, opts);

      expect(opts.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: expect.any(String) }),
      );
      expect(await manager.listPendingRecords()).toHaveLength(0);
    });

    it("rejects a title whose sanitized form exceeds the display limit", async () => {
      // 20 invisibles expand to \u{202E} escapes (8 chars each = 160 > 80 cap)
      // while the raw title passes protocol validation at 26 code points.
      const respond = await call("request", {
        title: `spoof${"‮".repeat(20)}x`,
        description: "plain description",
        twoPhase: true,
      });
      const error = expectResponseRejected(respond);
      expect(error.message).toContain("exceeds the display limit");
    });

    it("delivers requests to iOS push with the exec-equivalent visibility gate", async () => {
      const handleRequested = vi.fn(async () => true);
      const iosPushDelivery = { handleRequested };
      const { pending, id } = await startRequest(
        { approvalReviewerDeviceIds: ["ios-reviewer"] },
        {
          client: createClient({ clientId: "gateway-client", approvalRuntime: true }),
          context: createApprovalContext(() => false),
        },
        createPluginApprovalHandlers(manager, { iosPushDelivery }),
      );

      expect(handleRequested).toHaveBeenCalledTimes(1);
      expect(handleRequested.mock.contexts).toEqual([iosPushDelivery]);
      const requestCall = mockCall(handleRequested, 0, "iOS request delivery");
      expect(requireRecord(requestCall[0], "iOS request").id).toBe(id);
      const deliveryOptions = requireRecord(requestCall[1], "iOS delivery options");
      const isTargetVisible = deliveryOptions.isTargetVisible;
      expect(isTargetVisible).toBeTypeOf("function");
      const visibility = isTargetVisible as (target: {
        deviceId: string;
        scopes: readonly string[];
      }) => boolean;
      expect(
        visibility({
          deviceId: "ios-reviewer",
          scopes: ["operator.approvals", "operator.read"],
        }),
      ).toBe(true);
      expect(
        visibility({
          deviceId: "other-device",
          scopes: ["operator.approvals", "operator.read"],
        }),
      ).toBe(false);

      await settle({ id, pending });
    });

    it("sends an iOS cleanup wake when a plugin request expires", async () => {
      const handleExpired = vi.fn(async () => {});
      const { pending, id } = await startRequest(
        {},
        { context: createApprovalContext(() => false) },
        createPluginApprovalHandlers(manager, {
          iosPushDelivery: { handleRequested: vi.fn(async () => true), handleExpired },
        }),
      );
      await manager.expire(id, "timeout");
      await pending;

      expect(handleExpired).toHaveBeenCalledTimes(1);
      expect(
        requireRecord(mockCall(handleExpired, 0, "expired push")[0], "expired request").id,
      ).toBe(id);
    });

    it("expires immediately when no approval route", async () => {
      const hasExecApprovalClients = vi.fn(() => false);
      const client = createClient();
      const respond = await call(
        "request",
        { title: "Sensitive action", description: "Desc" },
        {
          client,
          context: createApprovalContext(hasExecApprovalClients),
        },
      );
      expect(expectResponseOk(respond).decision).toBeNull();
      expect(hasExecApprovalClients).toHaveBeenCalledWith(client?.connId);
    });

    it("keeps plugin approvals pending when the originating chat can handle /approve directly", async () => {
      setRuntimeConfigSnapshot({});
      vi.useFakeTimers();
      try {
        const { respond, pending, id } = await startRequest(
          { turnSourceChannel: "slack", turnSourceTo: "C123" },
          { context: createApprovalContext(() => false) },
        );
        expect(expectResponseOk(respond).deliveryRoute).toBe("turn-source");
        await settle({ id, pending });
      } finally {
        vi.useRealTimers();
        clearRuntimeConfigSnapshot();
      }
    });

    it("rejects plugin-provided id field", async () => {
      const respond = await call("request", {
        id: "plugin-provided-id",
        title: "T",
        description: "D",
      });
      expect(expectResponseRejected(respond).message).toContain("unexpected property");
    });

    it("stores scoped allowed decisions on plugin approval requests", async () => {
      const { pending, id } = await startRequest({
        allowedDecisions: ["allow-once", "allow-once"],
      });
      expect((await manager.getSnapshot(id))?.request.allowedDecisions).toEqual([
        "allow-once",
        "deny",
      ]);
      await settle({ id, pending }, "deny");
    });

    it("binds an initiating TUI as the least-privilege approval reviewer", async () => {
      const reviewerClient = createClient({
        connId: "conn-tui-reviewer",
        clientId: "openclaw-tui",
        deviceId: "device-tui-reviewer",
        scopes: ["operator.approvals"],
      });
      const broadcastToConnIds = vi.fn();
      const context = {
        ...createApprovalContext(),
        broadcastToConnIds,
        getApprovalClientConnIds: ({
          filter,
        }: {
          filter: (client: GatewayRequestHandlerOptions["client"]) => boolean;
        }) =>
          filter(reviewerClient)
            ? new Set([reviewerClient?.connId ?? "conn-tui-reviewer"])
            : new Set<string>(),
      } as unknown as GatewayRequestHandlerOptions["context"];
      const requestClient = createClient({
        connId: "conn-approval-runtime",
        clientId: "gateway-client",
        deviceId: "device-approval-runtime",
        scopes: ["operator.approvals"],
        approvalRuntime: true,
      });
      const { pending, id } = await startRequest(
        { approvalReviewerDeviceIds: ["device-tui-reviewer"] },
        { client: requestClient, context },
      );

      expect((await manager.getSnapshot(id))?.approvalReviewerDeviceIds).toEqual([
        "device-tui-reviewer",
      ]);
      expect(broadcastToConnIds).toHaveBeenCalledWith(
        "plugin.approval.requested",
        expect.objectContaining({ id }),
        new Set(["conn-tui-reviewer"]),
        { dropIfSlow: true },
      );

      const listRespond = await call("list", {}, { client: reviewerClient });
      expect(responseCall(listRespond).result).toEqual([expect.objectContaining({ id })]);

      const resolveRespond = await call(
        "resolve",
        { id, decision: "allow-once" },
        { client: reviewerClient, context },
      );
      expect(resolveRespond).toHaveBeenCalledWith(true, { ok: true }, undefined);
      await pending;
    });

    it("ignores reviewer devices from non-runtime plugin approval clients", async () => {
      const { pending, id } = await startRequest(
        { approvalReviewerDeviceIds: ["device-tui-reviewer"] },
        {
          client: createClient({
            connId: "conn-untrusted",
            clientId: "untrusted-client",
            deviceId: "device-untrusted",
            scopes: ["operator.approvals"],
          }),
        },
      );

      expect((await manager.getSnapshot(id))?.approvalReviewerDeviceIds).toBeUndefined();
      await settle({ id, pending }, "deny");
    });
  });

  describe("plugin.approval.list", () => {
    it("lists only plugin approvals owned by the caller", async () => {
      await registerOwnedApproval(manager, { title: "Visible", id: "plugin:visible" });
      await registerOwnedApproval(manager, {
        title: "Hidden",
        id: "plugin:hidden",
        owner: "other",
      });

      const listRespond = await call("list", {}, { client: createOwnedClient() });

      expect(responseCall(listRespond)).toMatchObject({
        ok: true,
        result: [expect.objectContaining({ id: "plugin:visible" })],
      });
    });
  });

  describe("plugin.approval.waitDecision", () => {
    it("rejects missing id", async () => {
      expect(expectResponseRejected(await call("waitDecision")).message).toContain(
        "id is required",
      );
    });

    it("returns not found for approvals hidden from the caller", async () => {
      const record = await registerOwnedApproval(manager, { title: "T" });
      await manager.resolve(record.id, "allow-once");

      const respond = await call(
        "waitDecision",
        { id: record.id },
        {
          client: createOwnedClient("other", ["operator.approvals"]),
        },
      );
      expect(expectResponseRejected(respond).message).toContain("expired or not found");
    });

    it("returns decision when resolved", async () => {
      const record = await registerApproval(manager);

      await manager.resolve(record.id, "allow-once");
      expect(expectResponseOk(await call("waitDecision", { id: record.id }))).toMatchObject({
        id: record.id,
        decision: "allow-once",
      });
    });
  });

  describe("plugin.approval.resolve", () => {
    it("rejects invalid decision", async () => {
      const record = await registerApproval(manager);
      const respond = await call("resolve", {
        id: record.id,
        decision: "invalid",
      });
      expect(expectResponseRejected(respond).message).toBe("invalid decision");
    });

    it("sends an iOS cleanup wake when a plugin approval resolves", async () => {
      const handleResolved = vi.fn(async () => {});
      const resolveHandlers = createPluginApprovalHandlers(manager, {
        iosPushDelivery: { handleResolved },
      });
      const record = await registerApproval(manager);

      const opts = createMockOptions("plugin.approval.resolve", {
        id: record.id,
        decision: "deny",
      });
      await invokeHandler(resolveHandlers, opts);

      expect(opts.respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
      expect(broadcastCall(opts)).toMatchObject({
        event: "plugin.approval.resolved",
        payload: { id: record.id, decision: "deny" },
        options: { dropIfSlow: true },
      });
      expect(handleResolved).toHaveBeenCalledTimes(1);
      expect(
        requireRecord(mockCall(handleResolved, 0, "resolved push")[0], "resolved event"),
      ).toMatchObject({
        id: record.id,
        decision: "deny",
        request: record.request,
      });
    });

    it("resolves only plugin approvals owned by the caller", async () => {
      const visible = await registerOwnedApproval(manager, {
        title: "Visible",
        id: "plugin:abcd-visible",
      });
      const hidden = await registerOwnedApproval(manager, {
        title: "Hidden",
        id: "plugin:abcd-hidden",
        owner: "other",
      });

      const ownerClient = createOwnedClient();
      const resolveRespond = await call(
        "resolve",
        { id: "plugin:abcd", decision: "allow-once" },
        { client: ownerClient },
      );
      expect(resolveRespond).toHaveBeenCalledWith(true, { ok: true }, undefined);
      expect((await manager.getSnapshot(visible.id))?.decision).toBe("allow-once");
      expect((await manager.getSnapshot(hidden.id))?.decision).toBeUndefined();

      const hiddenRespond = await call(
        "resolve",
        { id: hidden.id, decision: "deny" },
        { client: ownerClient },
      );
      const error = expectResponseRejected(hiddenRespond);
      expect(error).toMatchObject({
        code: "INVALID_REQUEST",
        message: "unknown or expired approval id",
        details: { reason: "APPROVAL_NOT_FOUND" },
      });
      expect((await manager.getSnapshot(hidden.id))?.decision).toBeUndefined();
    });

    it("rejects decisions outside plugin approval allowed decisions", async () => {
      const record = await registerApproval(manager, {
        allowedDecisions: ["allow-once", "deny"],
      });

      const respond = await call("resolve", {
        id: record.id,
        decision: "allow-always",
      });
      const error = expectResponseRejected(respond);
      expect(error).toMatchObject({
        code: "INVALID_REQUEST",
        message: "allow-always is unavailable for this plugin approval",
      });
      expect(error.details).toEqual({ allowedDecisions: ["allow-once", "deny"] });
      expect((await manager.getSnapshot(record.id))?.decision).toBeUndefined();
    });

    it("does not leak candidate ids when prefixes are ambiguous", async () => {
      await registerApproval(manager, { title: "A", id: "plugin:abc-1111" });
      await registerApproval(manager, { title: "B", id: "plugin:abc-2222" });

      const respond = await call("resolve", {
        id: "plugin:abc",
        decision: "deny",
      });
      expect(expectResponseRejected(respond)).toMatchObject({
        code: "INVALID_REQUEST",
        message: "unknown or expired approval id",
      });
    });
  });
});
