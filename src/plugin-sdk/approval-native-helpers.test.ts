import { describe, expect, it } from "vitest";
import {
  createChannelApproverDmTargetResolver,
  createChannelNativeOriginTargetResolver,
} from "./approval-native-helpers.js";
import type { OpenClawConfig } from "./config-runtime.js";

describe("createChannelNativeOriginTargetResolver", () => {
  it("reuses shared turn-source routing and respects shouldHandle gating", () => {
    const resolveOriginTarget = createChannelNativeOriginTargetResolver({
      channel: "matrix",
      shouldHandleRequest: ({ accountId }) => accountId === "ops",
      resolveTurnSourceTarget: (request) => ({
        to: String(request.request.turnSourceTo),
        threadId: request.request.turnSourceThreadId ?? undefined,
      }),
      resolveSessionTarget: (sessionTarget) => ({
        to: sessionTarget.to,
        threadId: sessionTarget.threadId,
      }),
      targetsMatch: (a, b) => a.to === b.to && a.threadId === b.threadId,
    });

    expect(
      resolveOriginTarget({
        cfg: {} as OpenClawConfig,
        accountId: "ops",
        request: {
          id: "plugin:req-1",
          request: {
            title: "Plugin approval",
            description: "Allow access",
            turnSourceChannel: "matrix",
            turnSourceTo: "room:!room:example.org",
            turnSourceThreadId: "t1",
            turnSourceAccountId: "ops",
          },
          createdAtMs: 0,
          expiresAtMs: 1000,
        },
      }),
    ).toEqual({
      to: "room:!room:example.org",
      threadId: "t1",
    });

    expect(
      resolveOriginTarget({
        cfg: {} as OpenClawConfig,
        accountId: "other",
        request: {
          id: "plugin:req-1",
          request: {
            title: "Plugin approval",
            description: "Allow access",
            turnSourceChannel: "matrix",
            turnSourceTo: "room:!room:example.org",
            turnSourceThreadId: "t1",
            turnSourceAccountId: "ops",
          },
          createdAtMs: 0,
          expiresAtMs: 1000,
        },
      }),
    ).toBeNull();
  });
});

describe("createChannelApproverDmTargetResolver", () => {
  it("filters null targets and skips delivery when shouldHandle rejects the request", () => {
    const resolveApproverDmTargets = createChannelApproverDmTargetResolver({
      shouldHandleRequest: ({ approvalKind }) => approvalKind === "exec",
      resolveApprovers: () => ["owner-1", "owner-2", "skip-me"],
      mapApprover: (approver) =>
        approver === "skip-me"
          ? null
          : {
              to: `user:${approver}`,
            },
    });

    expect(
      resolveApproverDmTargets({
        cfg: {},
        accountId: "default",
        approvalKind: "exec",
        request: {
          id: "req-1",
          request: { command: "echo hi" },
          createdAtMs: 0,
          expiresAtMs: 1000,
        },
      }),
    ).toEqual([{ to: "user:owner-1" }, { to: "user:owner-2" }]);

    expect(
      resolveApproverDmTargets({
        cfg: {},
        accountId: "default",
        approvalKind: "plugin",
        request: {
          id: "plugin:req-1",
          request: { title: "Plugin approval", description: "Allow access" },
          createdAtMs: 0,
          expiresAtMs: 1000,
        },
      }),
    ).toEqual([]);
  });
});
