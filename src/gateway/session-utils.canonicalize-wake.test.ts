import { describe, expect, test, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

let mockConfig: OpenClawConfig = {};

const mockedLogger = vi.hoisted(() => ({
  info: vi.fn<(msg: string) => void>(),
  warn: vi.fn<(msg: string) => void>(),
  error: vi.fn<(msg: string) => void>(),
  debug: vi.fn<(msg: string, meta?: Record<string, unknown>) => void>(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => mockedLogger,
}));

vi.mock("../config/config.js", () => ({
  loadConfig: () => mockConfig,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: (cfg: OpenClawConfig) => {
    const agents = cfg?.agents?.list ?? [];
    const defaultAgent = agents.find((a) => a?.default) ?? agents[0];
    return defaultAgent?.id ?? "main";
  },
  resolveAgentWorkspaceDir: () => "/tmp/workspace",
}));

const { canonicalizeWakeSessionKey } = await import("./session-utils.js");

describe("canonicalizeWakeSessionKey", () => {
  test("bare session key gets agent prefix", () => {
    mockConfig = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;
    expect(canonicalizeWakeSessionKey("hook:my-session")).toBe("agent:main:hook:my-session");
  });

  test("channel key gets agent prefix", () => {
    mockConfig = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;
    expect(canonicalizeWakeSessionKey("discord:channel:123")).toBe(
      "agent:main:discord:channel:123",
    );
  });

  test("'main' resolves to agent main session key", () => {
    mockConfig = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;
    expect(canonicalizeWakeSessionKey("main")).toBe("agent:main:main");
  });

  test("scope=global resolves 'main' to 'global'", () => {
    mockConfig = {
      session: { scope: "global", mainKey: "main" },
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;
    expect(canonicalizeWakeSessionKey("main")).toBe("global");
  });

  test("custom mainKey alias resolves correctly", () => {
    mockConfig = {
      session: { mainKey: "default" },
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;
    // "main" is an alias for the configured mainKey
    expect(canonicalizeWakeSessionKey("main")).toBe("agent:main:default");
  });

  test("already fully qualified key passes through", () => {
    mockConfig = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;
    expect(canonicalizeWakeSessionKey("agent:main:hook:x")).toBe("agent:main:hook:x");
  });

  test("key for different agent throws error", () => {
    mockConfig = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;
    // Key references a different agent "ops" but default is "main"
    expect(() => canonicalizeWakeSessionKey("agent:ops:hook:x")).toThrow(
      /cross-agent wake is not supported/i,
    );
  });

  test("non-default agent as default resolves correctly", () => {
    mockConfig = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    expect(canonicalizeWakeSessionKey("hook:my-session")).toBe("agent:ops:hook:my-session");
  });

  test("scope=global with non-main key still returns global", () => {
    mockConfig = {
      session: { scope: "global", mainKey: "work" },
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;
    // "main" is always a main alias, scope=global → "global"
    expect(canonicalizeWakeSessionKey("main")).toBe("global");
  });

  test("malformed agent:ops (2 segments) throws", () => {
    mockConfig = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;
    expect(() => canonicalizeWakeSessionKey("agent:ops")).toThrow(/malformed/i);
  });

  test("malformed agent:main (2 segments) throws", () => {
    mockConfig = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;
    expect(() => canonicalizeWakeSessionKey("agent:main")).toThrow(/malformed/i);
  });

  test("malformed two-segment agent keys include malformed in error message", () => {
    mockConfig = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;

    for (const key of ["agent:ops", "agent:main"]) {
      try {
        canonicalizeWakeSessionKey(key);
        throw new Error(`Expected canonicalizeWakeSessionKey("${key}") to throw`);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/malformed/i);
      }
    }
  });

  test("agent:ops:discord:channel:123 throws cross-agent error", () => {
    mockConfig = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;
    expect(() => canonicalizeWakeSessionKey("agent:ops:discord:channel:123")).toThrow(
      /cross-agent wake is not supported/i,
    );
  });

  test("agent:main:discord:channel:123 succeeds", () => {
    mockConfig = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;
    expect(canonicalizeWakeSessionKey("agent:main:discord:channel:123")).toBe(
      "agent:main:discord:channel:123",
    );
  });

  test("scope=global with arbitrary channel key returns global (not agent-prefixed)", () => {
    mockConfig = {
      session: { scope: "global", mainKey: "main" },
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;
    // Bug regression: without early-out, this returned "agent:main:discord:channel:123"
    // but heartbeat runner returns "global" — causing silently lost events
    expect(canonicalizeWakeSessionKey("discord:channel:123")).toBe("global");
  });
});
