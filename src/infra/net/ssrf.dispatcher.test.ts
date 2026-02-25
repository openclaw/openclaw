import { describe, expect, it, vi } from "vitest";

const { agentCtor } = vi.hoisted(() => ({
  agentCtor: vi.fn(function MockAgent(this: { options: unknown }, options: unknown) {
    this.options = options;
  }),
}));

vi.mock("undici", () => ({
  Agent: agentCtor,
}));

import {
  createPinnedDispatcher,
  PINNED_AUTO_SELECT_FAMILY_FALLBACK_TIMEOUT_MS,
  PINNED_AUTO_SELECT_FAMILY_PRIMARY_TIMEOUT_MS,
  type PinnedHostname,
} from "./ssrf.js";

describe("createPinnedDispatcher", () => {
  it("uses the default family attempt timeout for pinned lookups", () => {
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
        autoSelectFamilyAttemptTimeout: PINNED_AUTO_SELECT_FAMILY_PRIMARY_TIMEOUT_MS,
      },
    });
  });

  it("accepts an override timeout for fallback retry paths", () => {
    const lookup = vi.fn() as unknown as PinnedHostname["lookup"];
    const pinned: PinnedHostname = {
      hostname: "api.telegram.org",
      addresses: ["149.154.167.220", "2001:67c:4e8:f004::9"],
      lookup,
    };

    const dispatcher = createPinnedDispatcher(pinned, {
      autoSelectFamilyAttemptTimeoutMs: PINNED_AUTO_SELECT_FAMILY_FALLBACK_TIMEOUT_MS,
    });

    expect(dispatcher).toBeDefined();
    expect(agentCtor).toHaveBeenCalledWith({
      connect: {
        lookup,
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: PINNED_AUTO_SELECT_FAMILY_FALLBACK_TIMEOUT_MS,
      },
    });
    const firstCallArg = agentCtor.mock.calls[0]?.[0] as
      | { connect?: Record<string, unknown> }
      | undefined;
    expect(firstCallArg?.connect?.autoSelectFamily).toBeUndefined();
  });
});
