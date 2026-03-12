import { beforeEach, describe, expect, it, vi } from "vitest";

const { agentCtor } = vi.hoisted(() => ({
  agentCtor: vi.fn(function MockAgent(this: { options: unknown }, options: unknown) {
    this.options = options;
  }),
}));

vi.mock("undici", () => ({
  Agent: agentCtor,
}));

import { createPinnedDispatcher, type PinnedHostname } from "./ssrf.js";

function makePinned(hostname = "api.telegram.org"): PinnedHostname {
  return {
    hostname,
    addresses: ["149.154.167.220"],
    lookup: vi.fn() as unknown as PinnedHostname["lookup"],
  };
}

function lastAgentConnect(): Record<string, unknown> | undefined {
  const lastCall = agentCtor.mock.calls.at(-1)?.[0] as
    | { connect?: Record<string, unknown> }
    | undefined;
  return lastCall?.connect;
}

describe("createPinnedDispatcher", () => {
  beforeEach(() => {
    agentCtor.mockClear();
  });

  it("uses pinned lookup without overriding global family policy by default", () => {
    const pinned = makePinned();

    const dispatcher = createPinnedDispatcher(pinned);

    expect(dispatcher).toBeDefined();
    expect(agentCtor).toHaveBeenCalledWith({
      connect: {
        lookup: pinned.lookup,
      },
    });
    expect(lastAgentConnect()?.autoSelectFamily).toBeUndefined();
  });

  it("forwards autoSelectFamily when connectOptions provided", () => {
    const pinned = makePinned();

    createPinnedDispatcher(pinned, { autoSelectFamily: false });

    expect(lastAgentConnect()?.autoSelectFamily).toBe(false);
  });

  it("forwards autoSelectFamily: true when explicitly requested", () => {
    const pinned = makePinned();

    createPinnedDispatcher(pinned, { autoSelectFamily: true });

    expect(lastAgentConnect()?.autoSelectFamily).toBe(true);
  });

  it("forwards autoSelectFamilyAttemptTimeout via connectOptions", () => {
    const pinned = makePinned();

    createPinnedDispatcher(pinned, {
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 500,
    });

    expect(lastAgentConnect()?.autoSelectFamily).toBe(true);
    expect(lastAgentConnect()?.autoSelectFamilyAttemptTimeout).toBe(500);
  });

  it("does not set autoSelectFamilyAttemptTimeout when not provided", () => {
    const pinned = makePinned();

    createPinnedDispatcher(pinned, { autoSelectFamily: false });

    expect(lastAgentConnect()?.autoSelectFamilyAttemptTimeout).toBeUndefined();
  });

  it("uses pinned lookup function for DNS resolution", () => {
    const pinned = makePinned();

    createPinnedDispatcher(pinned);

    expect(lastAgentConnect()?.lookup).toBe(pinned.lookup);
  });
});
