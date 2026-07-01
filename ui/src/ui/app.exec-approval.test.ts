/* @vitest-environment jsdom */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import type { ExecApprovalRequest } from "./controllers/exec-approval.ts";

type RequestFn = (method: string, params?: unknown) => Promise<unknown>;
let OpenClawApp: typeof import("./app.ts").OpenClawApp;

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
  const app = Object.create(OpenClawApp.prototype) as InstanceType<typeof OpenClawApp>;
  Object.defineProperties(app, {
    client: { value: { request }, writable: true },
    execApprovalBusy: { value: false, writable: true },
    execApprovalError: { value: null, writable: true },
    execApprovalQueue: { value: queue, writable: true },
  });
  return app;
}

function deferred<T = unknown>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("OpenClawApp exec approval decisions", () => {
  beforeAll(async () => {
    ({ OpenClawApp } = await import("./app.ts"));
  }, 60_000);

  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("dismisses the active approval after same-decision idempotent success", async () => {
    const request = vi.fn<RequestFn>(async () => ({ ok: true }));
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

  it("does not show a stale resolve error on a newly active approval", async () => {
    const resolveAttempt = deferred();
    const request = vi.fn<RequestFn>(async () => {
      await resolveAttempt.promise;
      throw createGatewayError("gateway unavailable");
    });
    const active = createExecApproval({ id: "approval-active", createdAtMs: 1000 });
    const newer = createExecApproval({
      id: "approval-newer",
      request: { command: "npm publish" },
      createdAtMs: 2000,
    });
    const app = await createApp(request, [active]);

    const decision = app.handleExecApprovalDecision("allow-once");
    expect(app.execApprovalBusy).toBe(true);

    app.execApprovalQueue = [newer, active];
    resolveAttempt.resolve(undefined);
    await decision;

    expect(app.execApprovalQueue).toEqual([newer, active]);
    expect(app.execApprovalError).toBeNull();
    expect(app.execApprovalBusy).toBe(false);
  });

  it("does not show a stopped-client resolve error after reconnect swaps clients", async () => {
    const resolveAttempt = deferred();
    const request = vi.fn<RequestFn>(async () => {
      await resolveAttempt.promise;
      throw new Error("gateway client stopped");
    });
    const app = await createApp(request);

    const decision = app.handleExecApprovalDecision("deny");
    expect(app.execApprovalBusy).toBe(true);

    app.client = { request: vi.fn<RequestFn>(async () => ({})) };
    resolveAttempt.resolve(undefined);
    await decision;

    expect(app.execApprovalQueue).toHaveLength(1);
    expect(app.execApprovalQueue[0]?.id).toBe("approval-1");
    expect(app.execApprovalError).toBeNull();
    expect(app.execApprovalBusy).toBe(false);
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
