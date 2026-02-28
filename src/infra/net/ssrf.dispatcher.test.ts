import { describe, expect, it, vi } from "vitest";

const { agentCtor } = vi.hoisted(() => ({
  agentCtor: vi.fn(function MockAgent(this: { options: unknown }, options: unknown) {
    this.options = options;
  }),
}));

vi.mock("undici", () => ({
  Agent: agentCtor,
}));

import { createPinnedDispatcher, type PinnedHostname } from "./ssrf.js";

describe("createPinnedDispatcher", () => {
  it("creates dispatcher with pinned lookup and TCP keepalive options", () => {
    const lookup = vi.fn() as unknown as PinnedHostname["lookup"];
    const pinned: PinnedHostname = {
      hostname: "api.telegram.org",
      addresses: ["149.154.167.220"],
      lookup,
    };

    const dispatcher = createPinnedDispatcher(pinned);

    expect(dispatcher).toBeDefined();
    expect(agentCtor).toHaveBeenCalledWith({
      connect: {
        lookup,
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 300,
        keepAlive: true,
        keepAliveInitialDelay: 15_000,
      },
      keepAliveTimeout: 20_000,
      keepAliveMaxTimeout: 60_000,
    });
  });
});
