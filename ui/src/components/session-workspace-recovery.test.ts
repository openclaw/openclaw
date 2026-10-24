// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayBrowserClient, GatewayRequestError } from "../api/gateway.ts";
import { createGatewayHarness } from "../app/overlays-access.test-support.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
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
  const move = createDeferred();
  let current = true;
  const abort = new AbortController();
  const snapshot = {
    ...createGatewayHarness(client).gateway.snapshot,
    sessionKey: session.key,
    hello: gatewayHelloForMethods(["sessions.move"], ["operator.write", "operator.admin"]),
  };
  const remove = vi
    .fn<() => Promise<unknown>>()
    .mockRejectedValueOnce(recoveryError())
    .mockResolvedValue(true);
  const request = vi.spyOn(client, "request").mockImplementation(async () => await move.promise);
  const operations: Promise<unknown>[] = [];
  const retire = () => {
    current = false;
    abort.abort();
  };
  return {
    recoveryError,
    remove,
    move,
    request,
    snapshot,
    retire,
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
      retire();
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
    h.snapshot.hello = gatewayHelloForMethods(["sessions.move"], ["operator.read"]);
    answerConfirmDialog(actions, "confirm");
    await expect(operation).rejects.toThrow();
    expect(h.remove).toHaveBeenCalledOnce();
    expect(h.request).not.toHaveBeenCalledWith("sessions.move", expect.anything());
  });

  it.each(["move", "removal"] as const)(
    "reports a %s failure without another recovery",
    async (stage) => {
      const error = stage === "move" ? new Error("Device ownership changed") : h.recoveryError();
      if (stage === "removal") {
        h.remove.mockRejectedValueOnce(error);
      }
      const operation = h.run();
      answerConfirmDialog(await waitForConfirmDialogActions(), "confirm");
      if (stage === "move") {
        await vi.waitFor(() =>
          expect(h.request).toHaveBeenCalledWith("sessions.move", expect.anything()),
        );
        h.move.reject(error);
      } else {
        h.move.resolve();
      }
      await expect(operation).rejects.toBe(error);
      expect(h.remove).toHaveBeenCalledTimes(stage === "move" ? 1 : 2);
      expect(h.request.mock.calls.filter(([method]) => method === "sessions.move")).toHaveLength(1);
      expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
    },
  );
});
