import { describe, expect, it } from "vitest";
import {
  createChannelExecApprovalProfile,
  createChannelExecApprovalProfileAsync,
  isChannelExecApprovalClientEnabledFromConfig,
  isChannelExecApprovalTargetRecipient,
} from "./approval-client-helpers.js";
import type { OpenClawConfig } from "./config-contracts.js";

describe("isChannelExecApprovalTargetRecipient", () => {
  function matches(
    targets: NonNullable<NonNullable<OpenClawConfig["approvals"]>["exec"]>["targets"],
    accountId?: string,
    channel = "matrix",
  ) {
    return isChannelExecApprovalTargetRecipient({
      cfg: { approvals: { exec: { enabled: true, mode: "targets", targets } } },
      senderId: "@owner:example.org",
      accountId,
      channel,
      matchTarget: ({ target, normalizedSenderId }) => target.to === `user:${normalizedSenderId}`,
    });
  }
  it("matches targets by channel and account", () => {
    const targets = [
      { channel: "matrix", to: "user:@owner:example.org", accountId: "ops" },
      { channel: "matrix", to: "user:@other:example.org", accountId: "other" },
    ];
    expect(matches(targets, "ops")).toBe(true);
    expect(matches(targets, "other")).toBe(false);
  });

  it("normalizes the requested channel id before matching targets", () => {
    expect(
      matches([{ channel: "matrix", to: "user:@owner:example.org" }], undefined, " Matrix "),
    ).toBe(true);
  });
});

describe("createChannelExecApprovalProfile", () => {
  const profile = createChannelExecApprovalProfile({
    resolveConfig: () => ({
      enabled: true,
      target: "channel",
      agentFilter: ["ops"],
      sessionFilter: ["tail$"],
    }),
    resolveApprovers: () => ["owner"],
    isTargetRecipient: ({ senderId }) => senderId === "target",
    matchesRequestAccount: ({ accountId }) => accountId !== "other",
  });

  it("requires explicit enablement when approvers exist", () => {
    const enabled = isChannelExecApprovalClientEnabledFromConfig;
    expect(enabled({ approverCount: 1 })).toBe(false);
    expect(enabled({ enabled: "auto", approverCount: 1 })).toBe(true);
    expect(enabled({ enabled: true, approverCount: 1 })).toBe(true);
    expect(enabled({ enabled: false, approverCount: 1 })).toBe(false);
    expect(enabled({ approverCount: 0 })).toBe(false);
  });

  it("reuses shared client, auth, and request-filter logic", () => {
    expect(profile.isClientEnabled({ cfg: {} })).toBe(true);
    expect(profile.isApprover({ cfg: {}, senderId: "owner" })).toBe(true);
    expect(profile.isAuthorizedSender({ cfg: {}, senderId: "target" })).toBe(true);
    expect(profile.resolveTarget({ cfg: {} })).toBe("channel");

    const request = {
      id: "req-1",
      request: {
        command: "echo hi",
        agentId: "ops",
        sessionKey: "agent:ops:telegram:direct:owner:tail",
      },
      createdAtMs: 0,
      expiresAtMs: 1000,
    };
    expect(profile.shouldHandleRequest({ cfg: {}, accountId: "ops", request })).toBe(true);
    expect(profile.shouldHandleRequest({ cfg: {}, accountId: "other", request })).toBe(false);
  });

  it("supports local prompt suppression without requiring the client to be enabled", () => {
    const promptProfile = createChannelExecApprovalProfile({
      resolveConfig: () => undefined,
      resolveApprovers: () => [],
      requireClientEnabledForLocalPromptSuppression: false,
    });

    expect(
      promptProfile.shouldSuppressLocalPrompt({
        cfg: {},
        payload: {
          channelData: {
            execApproval: {
              approvalId: "req-1",
              approvalSlug: "req-1",
            },
          },
        },
      }),
    ).toBe(true);
  });
});

describe("createChannelExecApprovalProfileAsync", () => {
  it("awaits account eligibility while preserving synchronous configured sender authorization", async () => {
    const profile = createChannelExecApprovalProfileAsync({
      resolveConfig: () => ({ enabled: true }),
      resolveApprovers: () => ["owner"],
      isTargetRecipient: ({ senderId }) => senderId === "target",
      matchesRequestAccount: async ({ accountId }) => accountId === "work",
    });
    const request = { id: "req-1", request: { command: "pwd" }, createdAtMs: 0, expiresAtMs: 1000 };
    expect(profile.isAuthorizedSender({ cfg: {}, senderId: "target" })).toBe(true);
    expect(await profile.shouldHandleRequest({ cfg: {}, accountId: "other", request })).toBe(false);
    expect(await profile.shouldHandleRequest({ cfg: {}, accountId: "work", request })).toBe(true);
  });
});
