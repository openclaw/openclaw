import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { authorizeSessionAccess } from "./session-access.js";

vi.mock("./event-logger.js", () => ({
  emitSecurityEvent: vi.fn(),
}));

// Import the mock after vi.mock so we can inspect calls
import { emitSecurityEvent } from "./event-logger.js";

const mockedEmitSecurityEvent = emitSecurityEvent as Mock;

function makeConfig(overrides?: Partial<OpenClawConfig>): OpenClawConfig {
  return {
    session: { mainKey: "main" },
    tools: {},
    ...overrides,
  } as OpenClawConfig;
}

describe("authorizeSessionAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("same session access", () => {
    it("allows same-session access for transcript", () => {
      const result = authorizeSessionAccess({
        callerSessionKey: "agent:main:telegram:direct:alice",
        targetSessionKey: "agent:main:telegram:direct:alice",
        accessType: "transcript",
        config: makeConfig(),
      });
      expect(result).toEqual({ allowed: true });
    });

    it("allows same-session access for memory", () => {
      const result = authorizeSessionAccess({
        callerSessionKey: "agent:main:telegram:direct:alice",
        targetSessionKey: "agent:main:telegram:direct:alice",
        accessType: "memory",
        config: makeConfig(),
      });
      expect(result).toEqual({ allowed: true });
    });

    it("allows same-session access for metadata", () => {
      const result = authorizeSessionAccess({
        callerSessionKey: "agent:main:telegram:direct:alice",
        targetSessionKey: "agent:main:telegram:direct:alice",
        accessType: "metadata",
        config: makeConfig(),
      });
      expect(result).toEqual({ allowed: true });
    });

    it("allows same-session access for list", () => {
      const result = authorizeSessionAccess({
        callerSessionKey: "agent:main:telegram:direct:alice",
        targetSessionKey: "agent:main:telegram:direct:alice",
        accessType: "list",
        config: makeConfig(),
      });
      expect(result).toEqual({ allowed: true });
    });
  });

  describe("main session as caller", () => {
    it("allows main session to access any other session (transcript)", () => {
      const result = authorizeSessionAccess({
        callerSessionKey: "agent:main:main",
        targetSessionKey: "agent:main:telegram:direct:alice",
        accessType: "transcript",
        config: makeConfig(),
      });
      expect(result).toEqual({ allowed: true });
    });

    it("allows main session to access any other session (memory)", () => {
      const result = authorizeSessionAccess({
        callerSessionKey: "agent:main:main",
        targetSessionKey: "agent:main:telegram:direct:bob",
        accessType: "memory",
        config: makeConfig(),
      });
      expect(result).toEqual({ allowed: true });
    });

    it("allows main session with custom mainKey", () => {
      const result = authorizeSessionAccess({
        callerSessionKey: "agent:main:custom-key",
        targetSessionKey: "agent:main:telegram:direct:alice",
        accessType: "transcript",
        config: makeConfig({ session: { mainKey: "custom-key" } }),
      });
      expect(result).toEqual({ allowed: true });
    });
  });

  describe("same agent, cross-session", () => {
    it("allows metadata access across sessions within same agent", () => {
      const result = authorizeSessionAccess({
        callerSessionKey: "agent:main:telegram:direct:alice",
        targetSessionKey: "agent:main:telegram:direct:bob",
        accessType: "metadata",
        config: makeConfig(),
      });
      expect(result).toEqual({ allowed: true });
    });

    it("allows list access across sessions within same agent", () => {
      const result = authorizeSessionAccess({
        callerSessionKey: "agent:main:telegram:direct:alice",
        targetSessionKey: "agent:main:telegram:direct:bob",
        accessType: "list",
        config: makeConfig(),
      });
      expect(result).toEqual({ allowed: true });
    });

    it("denies transcript access across sessions within same agent", () => {
      const result = authorizeSessionAccess({
        callerSessionKey: "agent:main:telegram:direct:alice",
        targetSessionKey: "agent:main:telegram:direct:bob",
        accessType: "transcript",
        config: makeConfig(),
      });
      expect(result).toEqual({
        allowed: false,
        reason: "Cross-session transcript/memory access denied within same agent",
      });
    });

    it("denies memory access across sessions within same agent", () => {
      const result = authorizeSessionAccess({
        callerSessionKey: "agent:main:telegram:direct:alice",
        targetSessionKey: "agent:main:telegram:direct:bob",
        accessType: "memory",
        config: makeConfig(),
      });
      expect(result).toEqual({
        allowed: false,
        reason: "Cross-session transcript/memory access denied within same agent",
      });
    });
  });

  describe("cross-agent access", () => {
    it("allows cross-agent access when A2A enabled with allow=[*]", () => {
      const result = authorizeSessionAccess({
        callerSessionKey: "agent:main:telegram:direct:alice",
        targetSessionKey: "agent:coding:telegram:direct:alice",
        accessType: "transcript",
        config: makeConfig({
          tools: { agentToAgent: { enabled: true, allow: ["*"] } },
        }),
      });
      expect(result).toEqual({ allowed: true });
    });

    it("denies cross-agent access when A2A disabled", () => {
      const result = authorizeSessionAccess({
        callerSessionKey: "agent:main:telegram:direct:alice",
        targetSessionKey: "agent:coding:telegram:direct:alice",
        accessType: "transcript",
        config: makeConfig({
          tools: { agentToAgent: { enabled: false } },
        }),
      });
      expect(result).toEqual({
        allowed: false,
        reason: "Agent-to-agent access denied by tools.agentToAgent policy",
      });
    });

    it("denies cross-agent access when A2A enabled but not in allow list", () => {
      const result = authorizeSessionAccess({
        callerSessionKey: "agent:main:telegram:direct:alice",
        targetSessionKey: "agent:coding:telegram:direct:alice",
        accessType: "transcript",
        config: makeConfig({
          tools: { agentToAgent: { enabled: true, allow: ["other-agent"] } },
        }),
      });
      expect(result).toEqual({
        allowed: false,
        reason: "Agent-to-agent access denied by tools.agentToAgent policy",
      });
    });
  });

  describe("security event emission", () => {
    it("emits security event when same-agent cross-session access is denied", () => {
      authorizeSessionAccess({
        callerSessionKey: "agent:main:telegram:direct:alice",
        targetSessionKey: "agent:main:telegram:direct:bob",
        accessType: "transcript",
        config: makeConfig(),
      });

      expect(mockedEmitSecurityEvent).toHaveBeenCalledOnce();
      expect(mockedEmitSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "policy.violation",
          severity: "warn",
          action: "blocked",
          sessionKey: "agent:main:telegram:direct:alice",
          meta: expect.objectContaining({
            callerSessionKey: "agent:main:telegram:direct:alice",
            targetSessionKey: "agent:main:telegram:direct:bob",
            accessType: "transcript",
          }),
        }),
      );
    });

    it("emits security event when cross-agent access is denied", () => {
      authorizeSessionAccess({
        callerSessionKey: "agent:main:telegram:direct:alice",
        targetSessionKey: "agent:coding:telegram:direct:alice",
        accessType: "transcript",
        config: makeConfig({
          tools: { agentToAgent: { enabled: false } },
        }),
      });

      expect(mockedEmitSecurityEvent).toHaveBeenCalledOnce();
      expect(mockedEmitSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "policy.violation",
          severity: "warn",
          action: "blocked",
        }),
      );
    });

    it("does not emit security event when access is allowed (same session)", () => {
      authorizeSessionAccess({
        callerSessionKey: "agent:main:telegram:direct:alice",
        targetSessionKey: "agent:main:telegram:direct:alice",
        accessType: "transcript",
        config: makeConfig(),
      });

      expect(mockedEmitSecurityEvent).not.toHaveBeenCalled();
    });

    it("does not emit security event when access is allowed (main session)", () => {
      authorizeSessionAccess({
        callerSessionKey: "agent:main:main",
        targetSessionKey: "agent:main:telegram:direct:alice",
        accessType: "transcript",
        config: makeConfig(),
      });

      expect(mockedEmitSecurityEvent).not.toHaveBeenCalled();
    });

    it("does not emit security event when access is allowed (same-agent metadata)", () => {
      authorizeSessionAccess({
        callerSessionKey: "agent:main:telegram:direct:alice",
        targetSessionKey: "agent:main:telegram:direct:bob",
        accessType: "metadata",
        config: makeConfig(),
      });

      expect(mockedEmitSecurityEvent).not.toHaveBeenCalled();
    });

    it("does not emit security event when cross-agent access is allowed", () => {
      authorizeSessionAccess({
        callerSessionKey: "agent:main:telegram:direct:alice",
        targetSessionKey: "agent:coding:telegram:direct:alice",
        accessType: "transcript",
        config: makeConfig({
          tools: { agentToAgent: { enabled: true, allow: ["*"] } },
        }),
      });

      expect(mockedEmitSecurityEvent).not.toHaveBeenCalled();
    });
  });
});
