import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as followupQueue from "../../auto-reply/reply/queue/state.js";
import { replyRunRegistry } from "../../auto-reply/reply/reply-run-registry.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  retainGatewayRootWorkAdmissionContinuation,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import * as sessionAdmission from "../../sessions/session-lifecycle-admission.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "../../talk/agent-consult-tool.js";
import {
  captureGatewayDeviceRevocation,
  retainGatewayDeviceRevocation,
} from "../device-revocation.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import {
  assertChatSendExclusiveAdmission,
  createChatSendWorkAdmission,
} from "./chat-send-work-admission.js";

afterEach(() => vi.restoreAllMocks());

describe("voice consult admission", () => {
  const session = {
    storePath: "/tmp/voice-consult-store",
    sessionKey: "agent:main:voice-test",
    backingSessionId: "session-test",
    activeRunScopeKey: "scope-test",
  } as PreparedChatSendSession;
  const request = {
    systemInputProvenance: {
      kind: "internal_system",
      sourceTool: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
    },
  } as NormalizedChatSendRequest;

  function mockWork(busy: "admission" | "queue" | "run" | undefined) {
    vi.spyOn(sessionAdmission, "isCompetingSessionWorkAdmissionActive").mockReturnValue(
      busy === "admission",
    );
    vi.spyOn(followupQueue, "hasPendingFollowupQueueWork").mockReturnValue(busy === "queue");
    vi.spyOn(replyRunRegistry, "isActive").mockReturnValue(busy === "run");
  }

  it.each(["admission", "queue", "run"] as const)(
    "refuses a consult before it can queue behind existing %s work",
    (busy) => {
      mockWork(busy);
      expect(() => assertChatSendExclusiveAdmission(request, session)).toThrow(
        "Still working on the previous request. Please try again when it is finished.",
      );
    },
  );

  it("allows an idle consult through admission", () => {
    mockWork(undefined);
    expect(() => assertChatSendExclusiveAdmission(request, session)).not.toThrow();
    expect(sessionAdmission.isCompetingSessionWorkAdmissionActive).toHaveBeenCalledWith(
      session.storePath,
      [session.sessionKey, session.backingSessionId],
    );
  });

  it("keeps ordinary messages queueable", () => {
    mockWork("run");
    expect(() =>
      assertChatSendExclusiveAdmission({} as NormalizedChatSendRequest, session),
    ).not.toThrow();
  });
});

describe("retained chat work admission", () => {
  afterEach(resetGatewayWorkAdmission);
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
