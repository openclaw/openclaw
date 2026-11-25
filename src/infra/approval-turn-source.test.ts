// Covers approval turn-source route checks.
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.hoisted(() => vi.fn());
const resolveApprovalInitiatingSurfaceStateMock = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => loadConfigMock(),
}));

// mock-isolation: Turn-source tests supply surface availability without consulting live channel approvals.
vi.mock("./exec-approval-surface.js", () => ({
  resolveApprovalInitiatingSurfaceStateAsync: async (...args: unknown[]) =>
    resolveApprovalInitiatingSurfaceStateMock(...args),
}));

import { hasApprovalTurnSourceRoute } from "./approval-turn-source.js";

describe("hasApprovalTurnSourceRoute", () => {
  beforeEach(() => {
    loadConfigMock.mockReset();
    resolveApprovalInitiatingSurfaceStateMock.mockReset();
    loadConfigMock.mockReturnValue({ loaded: true });
  });

  it("returns true when the initiating surface is enabled", async () => {
    resolveApprovalInitiatingSurfaceStateMock.mockReturnValue({ kind: "enabled" });

    expect(
      await hasApprovalTurnSourceRoute({
        turnSourceChannel: "slack",
        turnSourceAccountId: "work",
      }),
    ).toBe(true);
    expect(resolveApprovalInitiatingSurfaceStateMock).toHaveBeenCalledWith({
      channel: "slack",
      accountId: "work",
      cfg: { loaded: true },
      approvalKind: "exec",
    });
  });

  it("passes plugin approval kind to the initiating surface check", async () => {
    resolveApprovalInitiatingSurfaceStateMock.mockReturnValue({ kind: "disabled" });
    const request = {
      id: "plugin:calendar",
      request: {
        title: "Review",
        description: "Calendar tool",
        policySubject: { pluginKey: "calendar" },
      },
      createdAtMs: 0,
      expiresAtMs: 1,
    };

    expect(
      await hasApprovalTurnSourceRoute({
        turnSourceChannel: "whatsapp",
        turnSourceAccountId: "default",
        approvalKind: "plugin",
        request,
      }),
    ).toBe(false);
    expect(resolveApprovalInitiatingSurfaceStateMock).toHaveBeenCalledWith({
      channel: "whatsapp",
      accountId: "default",
      cfg: { loaded: true },
      approvalKind: "plugin",
      request,
    });
  });

  it("returns false when the initiating surface is disabled or unsupported", async () => {
    resolveApprovalInitiatingSurfaceStateMock.mockReturnValueOnce({ kind: "disabled" });
    expect(await hasApprovalTurnSourceRoute({ turnSourceChannel: "discord" })).toBe(false);

    resolveApprovalInitiatingSurfaceStateMock.mockReturnValueOnce({ kind: "unsupported" });
    expect(await hasApprovalTurnSourceRoute({ turnSourceChannel: "unknown-channel" })).toBe(false);
  });

  it("returns false when there is no turn-source channel", async () => {
    expect(await hasApprovalTurnSourceRoute({ turnSourceChannel: undefined })).toBe(false);
    expect(resolveApprovalInitiatingSurfaceStateMock).not.toHaveBeenCalled();
  });

  it.each(["webchat", "tui"])(
    "requires a live approval client for the %s turn source",
    async (turnSourceChannel) => {
      expect(await hasApprovalTurnSourceRoute({ turnSourceChannel })).toBe(false);
      expect(resolveApprovalInitiatingSurfaceStateMock).not.toHaveBeenCalled();
      expect(loadConfigMock).not.toHaveBeenCalled();
    },
  );
});
