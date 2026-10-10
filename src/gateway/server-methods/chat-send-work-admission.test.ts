import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  retainGatewayRootWorkAdmissionContinuation,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import {
  captureGatewayDeviceRevocation,
  retainGatewayDeviceRevocation,
} from "../device-revocation.js";
import * as restartRecovery from "./chat-restart-recovery.js";
import { createChatSendWorkAdmission } from "./chat-send-work-admission.js";

describe("retained chat work admission", () => {
  afterEach(resetGatewayWorkAdmission);
  it.each(["retained", "replaced", "released"] as const)(
    "keeps terminal settlement custody after cancellation cleanup with a %s admission",
    async (change) => {
      const release = vi.fn();
      const resume = createDeferred();
      const sessionBinding = { sessionId: "terminal-session" };
      let registered = sessionBinding;
      let active = true;
      let guard: (() => void) | undefined;
      const terminal = vi
        .spyOn(restartRecovery, "terminalizeRestartSafeChatAdmission")
        .mockImplementation(async (params) => {
          guard = params.assertCurrent;
          await resume.promise;
          params.assertCurrent();
          return true;
        });
      const key = "agent:main:terminal";
      const storePath = "/isolated/terminal.sqlite";
      const work = createChatSendWorkAdmission({
        admission: { release },
        logGateway: { warn: vi.fn() },
        terminal: {
          target: {
            keyFormat: "agent-qualified",
            agentId: "main",
            canonicalKey: key,
            requestedKey: key,
            storeKey: key,
            storeKeys: [key],
            storePath,
            readSource: { agentId: "main", path: storePath, databaseIdentity: "original-source" },
          },
          storePath,
          sessionBinding,
          admittedSessionId: sessionBinding.sessionId,
          runId: "terminal-run",
          lifecycleRevision: "original-lifecycle",
          isActive: () => active,
          currentRegistration: () => registered,
        },
      });
      const settling = work.settleTerminal({ startedAt: 1, status: "killed", retryable: false });
      const observed = settling.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        expect(guard).toBeTypeOf("function");
        work.release();
        guard?.();
        expect(release).not.toHaveBeenCalled();
        if (change === "replaced") {
          registered = { sessionId: sessionBinding.sessionId };
        } else if (change === "released") {
          active = false;
        }
        resume.resolve();
        expect(await observed).toEqual(
          change === "retained"
            ? { value: true }
            : {
                error: expect.objectContaining({
                  message: "Chat terminal settlement no longer owns its admission",
                }),
              },
        );
        expect(release).toHaveBeenCalledOnce();
        expect(guard).toThrow("Chat settlement admission was released");
      } finally {
        resume.resolve();
        await observed;
        work.release();
        terminal.mockRestore();
      }
    },
  );
  it.each([
    { deferred: false, failCleanup: false },
    { deferred: false, failCleanup: true },
    { deferred: true, failCleanup: false },
    { deferred: true, failCleanup: true },
  ])(
    "keeps caller and root custody through collected work (deferred=$deferred, cleanup failure=$failCleanup)",
    async ({ deferred, failCleanup }) => {
      const caller = captureGatewayDeviceRevocation(
        {},
        { deviceId: "device", role: "operator" },
        () => true,
      );
      const released = createDeferred();
      const cleanup = createDeferred();
      const releaseAdmission = vi.fn(() => released.resolve());
      const warn = vi.fn();
      const root = tryBeginGatewayRootWorkAdmission("chat.send");
      if (!root) {
        throw new Error("Expected root admission");
      }
      const work = await root.run(async () =>
        createChatSendWorkAdmission({
          admission: { release: releaseAdmission },
          releaseCallerAuthority: retainGatewayDeviceRevocation(caller.isCurrent),
          releaseGatewayRootContinuation: retainGatewayRootWorkAdmissionContinuation() ?? undefined,
          logGateway: { warn },
        }),
      );
      root.release();
      const finishPendingInput = vi.fn(() => {
        if (deferred) {
          return cleanup.promise;
        }
        if (failCleanup) {
          throw new Error("pending input write failed");
        }
        return undefined;
      });
      work.setPendingInputCleanup(finishPendingInput);
      const releaseCollectedTurn = work.retain();
      caller.release();
      work.release();
      work.release();

      expect(work.isActive()).toBe(true);
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      expect(caller.isCurrent()).toBe(true);
      expect(finishPendingInput).not.toHaveBeenCalled();
      expect(releaseAdmission).not.toHaveBeenCalled();

      releaseCollectedTurn();
      releaseCollectedTurn();
      expect(work.isActive()).toBe(false);
      if (deferred) {
        expect(caller.isCurrent()).toBe(true);
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        expect(releaseAdmission).not.toHaveBeenCalled();
        if (failCleanup) {
          cleanup.reject(new Error("pending input write failed"));
        } else {
          cleanup.resolve();
        }
      }
      await released.promise;
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(caller.isCurrent()).toBe(false);
      expect(finishPendingInput).toHaveBeenCalledOnce();
      expect(releaseAdmission).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledTimes(failCleanup ? 1 : 0);
      expect(() => work.retain()).toThrow("cannot retain a released chat work admission");
    },
  );
});
