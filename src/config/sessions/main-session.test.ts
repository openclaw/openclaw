import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadConfig = vi.fn();

vi.mock("../config.js", () => ({
  loadConfig: () => mockLoadConfig(),
}));

const { resolveMainSessionKey, resolveDefaultAgentIdFromConfig, resolveWakeAgentId } =
  await import("./main-session.js");

describe("resolveMainSessionKey", () => {
  it("returns 'global' when session.scope is global", () => {
    expect(resolveMainSessionKey({ session: { scope: "global" } })).toBe("global");
  });

  it("returns agent:main:main when no agents configured", () => {
    expect(resolveMainSessionKey({})).toBe("agent:main:main");
  });

  it("uses the default agent from config", () => {
    const cfg = { agents: { list: [{ id: "assistant", default: true }] } };
    expect(resolveMainSessionKey(cfg)).toBe("agent:assistant:main");
  });

  it("uses the first agent when none marked default", () => {
    const cfg = { agents: { list: [{ id: "helper" }, { id: "worker" }] } };
    expect(resolveMainSessionKey(cfg)).toBe("agent:helper:main");
  });
});

describe("resolveDefaultAgentIdFromConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 'main' when no agents configured", () => {
    mockLoadConfig.mockReturnValue({});
    expect(resolveDefaultAgentIdFromConfig()).toBe("main");
  });

  it("returns the default agent from config", () => {
    mockLoadConfig.mockReturnValue({
      agents: { list: [{ id: "assistant", default: true }] },
    });
    expect(resolveDefaultAgentIdFromConfig()).toBe("assistant");
  });

  it("returns the first agent when none marked default", () => {
    mockLoadConfig.mockReturnValue({
      agents: { list: [{ id: "helper" }, { id: "worker" }] },
    });
    expect(resolveDefaultAgentIdFromConfig()).toBe("helper");
  });
});

describe("resolveWakeAgentId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("extracts agent ID from agent:*:* keys", () => {
    // agent:*:* keys should be parsed directly, no config lookup needed
    expect(resolveWakeAgentId("agent:assistant:main")).toBe("assistant");
    expect(resolveWakeAgentId("agent:worker:custom")).toBe("worker");
  });

  it("falls back to config default for 'global' key", () => {
    mockLoadConfig.mockReturnValue({
      agents: { list: [{ id: "assistant", default: true }] },
    });
    expect(resolveWakeAgentId("global")).toBe("assistant");
  });

  it("falls back to config default for node-prefixed keys", () => {
    mockLoadConfig.mockReturnValue({
      agents: { list: [{ id: "helper" }] },
    });
    expect(resolveWakeAgentId("node-abc123")).toBe("helper");
  });

  it("falls back to 'main' when no config agents and non-agent key", () => {
    mockLoadConfig.mockReturnValue({});
    expect(resolveWakeAgentId("global")).toBe("main");
  });

  it("falls back to config default for empty/null/undefined", () => {
    mockLoadConfig.mockReturnValue({
      agents: { list: [{ id: "assistant", default: true }] },
    });
    expect(resolveWakeAgentId(null)).toBe("assistant");
    expect(resolveWakeAgentId(undefined)).toBe("assistant");
    expect(resolveWakeAgentId("")).toBe("assistant");
  });
});
