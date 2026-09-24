// Manual approval routes complement connected approval clients and delivered native cards.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelApprovalCapability } from "../channels/plugins/types.adapters.js";

const capability = vi.hoisted(() => ({
  value: undefined as ChannelApprovalCapability | undefined,
}));
vi.mock("../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../channels/plugins/index.js", () => ({
  getChannelPlugin: () => ({}),
  resolveChannelApprovalCapability: () => capability.value,
}));

import { hasApprovalTurnSourceRoute } from "./approval-turn-source.js";

describe("hasApprovalTurnSourceRoute", () => {
  beforeEach(() => {
    capability.value = undefined;
  });

  it.each([undefined, "webchat", "tui", "unknown-channel"])(
    "does not invent an offline approval route for %s",
    (turnSourceChannel) => {
      expect(hasApprovalTurnSourceRoute({ turnSourceChannel })).toBe(false);
    },
  );

  it("preserves manual replies on a deliverable channel without native policy", () => {
    expect(hasApprovalTurnSourceRoute({ turnSourceChannel: "slack" })).toBe(true);
  });

  it("keeps exec disabled independently of a plugin approval route", () => {
    capability.value = {
      getExecInitiatingSurfaceState: () => ({ kind: "disabled" }),
      getActionAvailabilityState: ({ approvalKind }) => ({
        kind: approvalKind === "plugin" ? "enabled" : "disabled",
      }),
    };
    expect(hasApprovalTurnSourceRoute({ turnSourceChannel: "discord", approvalKind: "exec" })).toBe(
      false,
    );
    expect(
      hasApprovalTurnSourceRoute({ turnSourceChannel: "discord", approvalKind: "plugin" }),
    ).toBe(true);
  });
});
