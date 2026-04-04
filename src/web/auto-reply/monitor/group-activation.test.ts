import { describe, expect, it, vi } from "vitest";

// Mock the internal modules so we can unit-test resolveGroupPolicyFor
// without needing the full runtime.
vi.mock("../../../config/sessions.js", () => ({
  resolveGroupSessionKey: vi.fn(({ From }: { From: string }) => ({ id: From })),
  loadSessionStore: vi.fn(),
  resolveStorePath: vi.fn(),
}));

vi.mock("../../../config/group-policy.js", () => ({
  resolveChannelGroupPolicy: vi.fn(
    (params: { hasGroupAllowFrom?: boolean; groupId?: string }) => params,
  ),
  resolveChannelGroupRequireMention: vi.fn(),
}));

import { resolveChannelGroupPolicy } from "../../../config/group-policy.js";
import { resolveGroupPolicyFor } from "./group-activation.js";

describe("resolveGroupPolicyFor", () => {
  it("does not set hasGroupAllowFrom when only DM allowFrom is configured", () => {
    // Regression: DM allowFrom entries (added by pairing) were incorrectly
    // treated as group-level sender filtering, causing groupPolicy=allowlist
    // with no groups to auto-reply to ALL groups instead of blocking them.
    const cfg = {
      channels: {
        whatsapp: {
          allowFrom: ["+1234567890"],
        },
      },
    } as never;

    resolveGroupPolicyFor(cfg, "group@g.us");

    expect(resolveChannelGroupPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ hasGroupAllowFrom: false }),
    );
  });

  it("sets hasGroupAllowFrom when groupAllowFrom is configured", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groupAllowFrom: ["+1234567890"],
        },
      },
    } as never;

    resolveGroupPolicyFor(cfg, "group@g.us");

    expect(resolveChannelGroupPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ hasGroupAllowFrom: true }),
    );
  });

  it("does not set hasGroupAllowFrom when both allowFrom and empty groupAllowFrom are present", () => {
    const cfg = {
      channels: {
        whatsapp: {
          allowFrom: ["+1234567890"],
          groupAllowFrom: [],
        },
      },
    } as never;

    resolveGroupPolicyFor(cfg, "group@g.us");

    expect(resolveChannelGroupPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ hasGroupAllowFrom: false }),
    );
  });
});
