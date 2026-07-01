/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import type { ExecApprovalRequest } from "./controllers/exec-approval.ts";

type RequestFn = (method: string, params?: unknown) => Promise<unknown>;

function createExecApproval(overrides: Partial<ExecApprovalRequest> = {}): ExecApprovalRequest {
  return {
    id: "approval-1",
    kind: "exec",
    request: { command: "echo hello" },
    createdAtMs: 1000,
    expiresAtMs: Date.now() + 60_000,
    ...overrides,
  };
}

function createGatewayError(message: string, details?: unknown): Error {
  const err = new Error(message);
  Object.defineProperty(err, "gatewayCode", {
    value: "INVALID_REQUEST",
    enumerable: true,
  });
  Object.defineProperty(err, "details", {
    value: details,
    enumerable: true,
  });
  return err;
}

async function createApp(
  request: RequestFn,
  queue: ExecApprovalRequest[] = [createExecApproval()],
) {
  const { OpenClawApp } = await import("./app.ts");
  const app = Object.create(OpenClawApp.prototype) as InstanceType<typeof OpenClawApp>;
  Object.defineProperties(app, {
    client: { value: { request }, writable: true },
    execApprovalBusy: { value: false, writable: true },
    execApprovalError: { value: null, writable: true },
    execApprovalQueue: { value: queue, writable: true },
  });
  return app;
}

describe("OpenClawApp exec approval decisions", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("dismisses the active approval after same-decision idempotent success", async () => {
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "exec.approval.list" || method === "plugin.approval.list") {
        return [];
      }
      return { ok: true };
    });
    const app = await createApp(request);

    await app.handleExecApprovalDecision("allow-once");

    expect(request).toHaveBeenCalledWith("exec.approval.resolve", {
      id: "approval-1",
      decision: "allow-once",
    });
    expect(app.execApprovalQueue).toEqual([]);
    expect(app.execApprovalError).toBeNull();
    expect(app.execApprovalBusy).toBe(false);
  });

  it("keeps the approval window backed by the remaining queue after approving the active item", async () => {
    const request = vi.fn<RequestFn>(async () => ({ ok: true }));
    const active = createExecApproval({ id: "approval-active", createdAtMs: 2000 });
    const queued = createExecApproval({ id: "approval-queued", createdAtMs: 1000 });
    const app = await createApp(request, [active, queued]);

    await app.handleExecApprovalDecision("allow-once", "approval-active");

    expect(request).toHaveBeenCalledWith("exec.approval.resolve", {
      id: "approval-active",
      decision: "allow-once",
    });
    expect(app.execApprovalQueue).toEqual([queued]);
    expect(app.execApprovalError).toBeNull();
    expect(app.execApprovalBusy).toBe(false);
  });

  it("resolves the requested approval id instead of assuming the queue head", async () => {
    const request = vi.fn<RequestFn>(async () => ({ ok: true }));
    const active = createExecApproval({ id: "approval-active", createdAtMs: 2000 });
    const queued = createExecApproval({ id: "approval-queued", createdAtMs: 1000 });
    const app = await createApp(request, [active, queued]);

    await app.handleExecApprovalDecision("deny", "approval-queued");

    expect(request).toHaveBeenCalledWith("exec.approval.resolve", {
      id: "approval-queued",
      decision: "deny",
    });
    expect(app.execApprovalQueue).toEqual([active]);
    expect(app.execApprovalBusy).toBe(false);
  });

  it("refreshes pending approvals after the last local approval is dismissed", async () => {
    const active = createExecApproval({ id: "approval-active", createdAtMs: 3000 });
    const queued = createExecApproval({ id: "approval-queued", createdAtMs: 2000 });
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "exec.approval.resolve") {
        return { ok: true };
      }
      if (method === "exec.approval.list") {
        return [active, queued];
      }
      if (method === "plugin.approval.list") {
        return [];
      }
      return {};
    });
    const app = await createApp(request, [active]);

    await app.handleExecApprovalDecision("allow-once", "approval-active");

    expect(app.execApprovalQueue.map((entry) => entry.id)).toEqual(["approval-queued"]);
    expect(app.execApprovalBusy).toBe(false);
    expect(request).toHaveBeenCalledWith("exec.approval.list", {});
    expect(request).toHaveBeenCalledWith("plugin.approval.list", {});
  });

  it("dismisses and refreshes when the backend reports an already resolved approval", async () => {
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "exec.approval.resolve") {
        throw createGatewayError("approval already resolved", {
          reason: "APPROVAL_ALREADY_RESOLVED",
        });
      }
      if (method === "exec.approval.list") {
        return [];
      }
      if (method === "plugin.approval.list") {
        return [];
      }
      return {};
    });
    const app = await createApp(request);

    await app.handleExecApprovalDecision("deny");

    expect(app.execApprovalQueue).toEqual([]);
    expect(app.execApprovalError).toBeNull();
    expect(app.execApprovalBusy).toBe(false);
    expect(request).toHaveBeenCalledWith("exec.approval.list", {});
    expect(request).toHaveBeenCalledWith("plugin.approval.list", {});
  });

  it("keeps the active approval open for unrelated errors", async () => {
    const request = vi.fn<RequestFn>(async () => {
      throw createGatewayError("gateway unavailable");
    });
    const active = createExecApproval();
    const app = await createApp(request, [active]);

    await app.handleExecApprovalDecision("deny");

    expect(app.execApprovalQueue).toEqual([active]);
    expect(app.execApprovalError).toBe("Approval failed: Error: gateway unavailable");
    expect(app.execApprovalBusy).toBe(false);
  });
});
