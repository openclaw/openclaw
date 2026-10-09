// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayBrowserClient, GatewayRequestError } from "../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import {
  answerConfirmDialog,
  installDialogPolyfill,
  waitForConfirmDialogActions,
} from "../test-helpers/modal-dialog.ts";
import { withSessionWorkspaceRecovery } from "./session-workspace-recovery.runtime.ts";

function createRecoveryHarness() {
  const client = new GatewayBrowserClient({ url: "ws://gateway.example.test" });
  const session = {
    key: "agent:main:offline",
    sessionId: "offline-session",
    agentId: "main",
    label: "Offline session",
  };
  const recoveryError = (sessionId = session.sessionId) =>
    new GatewayRequestError({
      code: "UNAVAILABLE",
      message: "Reconnect the device to preserve its workspace.",
      details: {
        code: "SESSION_WORKSPACE_RECOVERY_REQUIRED",
        cause: "device_offline",
        recoveryAction: "continue_on_gateway",
        sessionId,
        source: { generation: 5, environmentId: "device-environment", ownerEpoch: 70 },
      },
    });
  const error = recoveryError();
  const move = createDeferred();
  let current = true;
  const abort = new AbortController();
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    hello: {
      type: "hello-ok",
      protocol: 4,
      features: { methods: ["sessions.move"] },
      auth: { role: "operator", scopes: ["operator.write", "operator.admin"] },
      snapshot: {},
    },
    canvasPluginSurfaceUrl: null,
    assistantAgentId: "main",
    sessionKey: session.key,
    lastError: null,
    lastErrorCode: null,
  };
  const remove = vi
    .fn<() => Promise<unknown>>()
    .mockRejectedValueOnce(error)
    .mockResolvedValue(true);
  const request = vi.spyOn(client, "request").mockImplementation(async () => await move.promise);
  const operations: Promise<unknown>[] = [];
  return {
    recoveryError,
    remove,
    move,
    request,
    snapshot,
    retire() {
      current = false;
      abort.abort();
    },
    run() {
      const operation = withSessionWorkspaceRecovery({
        action: "delete",
        session,
        scope: { client, gateway: { snapshot }, signal: abort.signal },
        isCurrent: () => current,
        request: remove,
      });
      operations.push(operation);
      void operation.catch(() => undefined);
      return operation;
    },
    async dispose() {
      current = false;
      abort.abort();
      move.resolve();
      await Promise.allSettled(operations);
      request.mockRestore();
    },
  };
}

describe("session workspace recovery controls", () => {
  let restoreDialog: () => void;
  let h: ReturnType<typeof createRecoveryHarness>;

  beforeEach(() => {
    restoreDialog = installDialogPolyfill();
    h = createRecoveryHarness();
  });

  afterEach(async () => {
    await h.dispose();
    document.body.replaceChildren();
    restoreDialog();
  });

  it("does not recover another session identity", async () => {
    const error = h.recoveryError("replacement-session");
    h.remove.mockReset().mockRejectedValue(error);
    await expect(h.run()).rejects.toBe(error);
    expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(h.request).not.toHaveBeenCalledWith("sessions.move", expect.anything());
  });

  it.each(["dialog", "move"] as const)("retires intent during the %s", async (stage) => {
    const operation = h.run();
    const actions = await waitForConfirmDialogActions();
    if (stage === "move") {
      answerConfirmDialog(actions, "confirm");
      await vi.waitFor(() =>
        expect(h.request).toHaveBeenCalledWith("sessions.move", expect.anything()),
      );
    }
    h.retire();
    h.move.resolve();
    await expect(operation).resolves.toBeUndefined();
    expect(h.remove).toHaveBeenCalledOnce();
    expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
    if (stage === "dialog") {
      expect(h.request).not.toHaveBeenCalledWith("sessions.move", expect.anything());
    }
  });

  it("rechecks access after confirmation", async () => {
    const operation = h.run();
    const actions = await waitForConfirmDialogActions();
    h.snapshot.hello = {
      type: "hello-ok",
      protocol: 4,
      features: { methods: ["sessions.move"] },
      auth: { role: "operator", scopes: ["operator.read"] },
      snapshot: {},
    };
    answerConfirmDialog(actions, "confirm");
    await expect(operation).rejects.toThrow();
    expect(h.remove).toHaveBeenCalledOnce();
    expect(h.request).not.toHaveBeenCalledWith("sessions.move", expect.anything());
  });

  it("reports a move failure without retrying removal", async () => {
    const error = new Error("Device ownership changed");
    const operation = h.run();
    answerConfirmDialog(await waitForConfirmDialogActions(), "confirm");
    await vi.waitFor(() =>
      expect(h.request).toHaveBeenCalledWith("sessions.move", expect.anything()),
    );
    h.move.reject(error);
    await expect(operation).rejects.toBe(error);
    expect(h.remove).toHaveBeenCalledOnce();
  });

  it("reports a second removal rejection without another recovery prompt", async () => {
    const secondError = h.recoveryError();
    h.remove.mockRejectedValueOnce(secondError);
    const operation = h.run();
    answerConfirmDialog(await waitForConfirmDialogActions(), "confirm");
    h.move.resolve();
    await expect(operation).rejects.toBe(secondError);
    expect(h.remove).toHaveBeenCalledTimes(2);
    expect(h.request.mock.calls.filter(([method]) => method === "sessions.move")).toHaveLength(1);
    expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
  });
});
