import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { createPluginApprovalHandlers } from "./plugin-approval.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

function createManager() {
  return new ExecApprovalManager<PluginApprovalRequestPayload>();
}

function createMockOptions(
  method: string,
  params: Record<string, unknown>,
  overrides?: Partial<GatewayRequestHandlerOptions>,
): GatewayRequestHandlerOptions {
  return {
    req: { method, params, id: "req-1" },
    params,
    client: {
      connect: {
        client: { id: "test-client", displayName: "Test Client" },
      },
    },
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: {
      broadcast: vi.fn(),
      logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      hasExecApprovalClients: () => true,
    },
    ...overrides,
  } as unknown as GatewayRequestHandlerOptions;
}

describe("createPluginApprovalHandlers", () => {
  let manager: ExecApprovalManager<PluginApprovalRequestPayload>;

  beforeEach(() => {
    manager = createManager();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns handlers for all three plugin approval methods", () => {
    const handlers = createPluginApprovalHandlers(manager);
    expect(handlers).toHaveProperty("plugin.approval.request");
    expect(handlers).toHaveProperty("plugin.approval.waitDecision");
    expect(handlers).toHaveProperty("plugin.approval.resolve");
    expect(typeof handlers["plugin.approval.request"]).toBe("function");
    expect(typeof handlers["plugin.approval.waitDecision"]).toBe("function");
    expect(typeof handlers["plugin.approval.resolve"]).toBe("function");
  });

  describe("plugin.approval.request", () => {
    it("rejects invalid params", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const opts = createMockOptions("plugin.approval.request", {});
      await handlers["plugin.approval.request"](opts);
      expect(opts.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: expect.any(String),
        }),
      );
    });

    it("creates and registers approval with twoPhase", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const respond = vi.fn();
      const opts = createMockOptions(
        "plugin.approval.request",
        {
          title: "Sensitive action",
          description: "This tool modifies production data",
          severity: "warning",
          twoPhase: true,
        },
        { respond },
      );

      // Don't await — the handler blocks waiting for the decision.
      // Instead, let it run and resolve the approval after the accepted response.
      const handlerPromise = handlers["plugin.approval.request"](opts);

      // Wait for the twoPhase "accepted" response
      await vi.waitFor(() => {
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ status: "accepted", id: expect.any(String) }),
          undefined,
        );
      });

      expect(opts.context.broadcast).toHaveBeenCalledWith(
        "plugin.approval.requested",
        expect.objectContaining({ id: expect.any(String) }),
        { dropIfSlow: true },
      );

      // Resolve the approval so the handler can complete
      const acceptedCall = respond.mock.calls.find(
        (c) => (c[1] as Record<string, unknown>)?.status === "accepted",
      );
      const approvalId = (acceptedCall?.[1] as Record<string, unknown>)?.id as string;
      manager.resolve(approvalId, "allow-once");

      await handlerPromise;

      // Final response with decision
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ id: approvalId, decision: "allow-once" }),
        undefined,
      );
    });

    it("expires immediately when no approval route", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const opts = createMockOptions(
        "plugin.approval.request",
        {
          title: "Sensitive action",
          description: "Desc",
        },
        {
          context: {
            broadcast: vi.fn(),
            logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
            hasExecApprovalClients: () => false,
          } as unknown as GatewayRequestHandlerOptions["context"],
        },
      );
      await handlers["plugin.approval.request"](opts);
      expect(opts.respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ decision: null }),
        undefined,
      );
    });

    it("rejects plugin-provided id field", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const opts = createMockOptions("plugin.approval.request", {
        id: "plugin-provided-id",
        title: "T",
        description: "D",
      });
      await handlers["plugin.approval.request"](opts);
      expect(opts.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining("unexpected property") }),
      );
    });
  });

  describe("plugin.approval.waitDecision", () => {
    it("rejects missing id", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const opts = createMockOptions("plugin.approval.waitDecision", {});
      await handlers["plugin.approval.waitDecision"](opts);
      expect(opts.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining("id is required") }),
      );
    });

    it("returns not found for unknown id", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const opts = createMockOptions("plugin.approval.waitDecision", { id: "unknown" });
      await handlers["plugin.approval.waitDecision"](opts);
      expect(opts.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining("expired or not found") }),
      );
    });

    it("returns decision when resolved", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const record = manager.create({ title: "T", description: "D" }, 60_000);
      void manager.register(record, 60_000);

      // Resolve before waiting
      manager.resolve(record.id, "allow-once");

      const opts = createMockOptions("plugin.approval.waitDecision", { id: record.id });
      await handlers["plugin.approval.waitDecision"](opts);
      expect(opts.respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ id: record.id, decision: "allow-once" }),
        undefined,
      );
    });
  });

  describe("plugin.approval.resolve", () => {
    it("rejects invalid params", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const opts = createMockOptions("plugin.approval.resolve", {});
      await handlers["plugin.approval.resolve"](opts);
      expect(opts.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: expect.any(String),
        }),
      );
    });

    it("rejects invalid decision", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const record = manager.create({ title: "T", description: "D" }, 60_000);
      void manager.register(record, 60_000);
      const opts = createMockOptions("plugin.approval.resolve", {
        id: record.id,
        decision: "invalid",
      });
      await handlers["plugin.approval.resolve"](opts);
      expect(opts.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: "invalid decision" }),
      );
    });

    it("resolves a pending approval", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const record = manager.create({ title: "T", description: "D" }, 60_000);
      void manager.register(record, 60_000);

      const opts = createMockOptions("plugin.approval.resolve", {
        id: record.id,
        decision: "deny",
      });
      await handlers["plugin.approval.resolve"](opts);
      expect(opts.respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
      expect(opts.context.broadcast).toHaveBeenCalledWith(
        "plugin.approval.resolved",
        expect.objectContaining({ id: record.id, decision: "deny" }),
        { dropIfSlow: true },
      );
    });

    it("rejects unknown approval id", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const opts = createMockOptions("plugin.approval.resolve", {
        id: "nonexistent",
        decision: "allow-once",
      });
      await handlers["plugin.approval.resolve"](opts);
      expect(opts.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining("unknown or expired") }),
      );
    });

    it("supports prefix matching for id", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const record = manager.create({ title: "T", description: "D" }, 60_000, "abcdef-1234");
      void manager.register(record, 60_000);

      const opts = createMockOptions("plugin.approval.resolve", {
        id: "abcdef",
        decision: "allow-always",
      });
      await handlers["plugin.approval.resolve"](opts);
      expect(opts.respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    });
  });
});
