import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn<() => Partial<OpenClawConfig>>(() => ({})),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
  CONFIG_PATH: "/tmp/test-config.yaml",
}));

const { canonicalizeWakeSessionKey } = await import("./session-utils.js");

describe("canonicalizeWakeSessionKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prefixes a bare key with agent:{defaultAgentId}:", () => {
    mocks.loadConfig.mockReturnValue({});
    const result = canonicalizeWakeSessionKey("discord:channel:123");
    expect(result).toBe("agent:main:discord:channel:123");
  });

  it("resolves 'main' alias to agent:{agentId}:main", () => {
    mocks.loadConfig.mockReturnValue({});
    const result = canonicalizeWakeSessionKey("main");
    expect(result).toBe("agent:main:main");
  });

  it("resolves 'main' alias to configured mainKey", () => {
    mocks.loadConfig.mockReturnValue({ session: { mainKey: "work" } });
    const result = canonicalizeWakeSessionKey("main");
    expect(result).toBe("agent:main:work");
  });

  it("canonicalizes agent:main:main alias to configured mainKey", () => {
    mocks.loadConfig.mockReturnValue({ session: { mainKey: "work" } });
    const result = canonicalizeWakeSessionKey("agent:main:main");
    expect(result).toBe("agent:main:work");
  });

  it("preserves already-canonicalized key with matching agent", () => {
    mocks.loadConfig.mockReturnValue({});
    const result = canonicalizeWakeSessionKey("agent:main:hook:my-session");
    expect(result).toBe("agent:main:hook:my-session");
  });

  it("throws when agent ID does not match", () => {
    mocks.loadConfig.mockReturnValue({});
    // Key with a different agent prefix than the default (main)
    expect(() => canonicalizeWakeSessionKey("agent:other:discord:channel:1")).toThrow(
      /cross-agent wake is not supported/i,
    );
  });

  it("returns 'global' for global scope with main alias", () => {
    mocks.loadConfig.mockReturnValue({ session: { scope: "global" } });
    const result = canonicalizeWakeSessionKey("main");
    expect(result).toBe("global");
  });

  it("uses configured default agent ID", () => {
    mocks.loadConfig.mockReturnValue({
      agents: { list: [{ id: "ops", default: true }] },
    });
    const result = canonicalizeWakeSessionKey("hook:test");
    expect(result).toBe("agent:ops:hook:test");
  });

  it("throws when key targets different configured agent", () => {
    mocks.loadConfig.mockReturnValue({
      agents: { list: [{ id: "ops", default: true }] },
    });
    expect(() => canonicalizeWakeSessionKey("agent:other:hook:test")).toThrow(
      /cross-agent wake is not supported/i,
    );
  });
});
