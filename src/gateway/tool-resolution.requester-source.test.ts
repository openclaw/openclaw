/**
 * Gateway tool-resolution requester source tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const createOpenClawToolsMock = vi.hoisted(() => vi.fn(() => []));

vi.mock("../agents/openclaw-tools.js", () => ({
  createOpenClawTools: createOpenClawToolsMock,
}));

import { resolveGatewayScopedTools } from "./tool-resolution.js";

describe("resolveGatewayScopedTools requester source", () => {
  beforeEach(() => {
    createOpenClawToolsMock.mockClear();
  });

  it("passes requester source separately from the routeable message provider", () => {
    resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:discord:group:g1",
      messageProvider: "discord",
      requesterSourceProvider: "telegram",
      surface: "loopback",
    });

    expect(createOpenClawToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentChannel: "discord",
        agentSourceProvider: "telegram",
      }),
    );
  });

  it("falls requester source back to the routeable provider for same-source calls", () => {
    resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:discord:group:g1",
      messageProvider: "discord",
      surface: "loopback",
    });

    expect(createOpenClawToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentChannel: "discord",
        agentSourceProvider: "discord",
      }),
    );
  });
});
