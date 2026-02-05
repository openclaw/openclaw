/**
 * Parity tests for RuntimeResolver.
 *
 * These tests verify that the new RuntimeResolver produces the same results
 * as the original resolveSessionRuntimeKind() function for all scenarios.
 */

import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ExecutionRequest } from "./types.js";
import {
  resolveSessionRuntimeKind,
  resolveAgentRuntimeKind,
  resolveMainAgentRuntimeKind,
} from "../agents/main-agent-runtime-factory.js";
import { DefaultRuntimeResolver } from "./resolver.js";

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

function createConfig(overrides: Partial<OpenClawConfig> = {}): OpenClawConfig {
  return {
    ...overrides,
  } as OpenClawConfig;
}

function createRequest(
  config: OpenClawConfig | undefined,
  agentId: string,
  sessionKey?: string,
): ExecutionRequest {
  return {
    agentId,
    sessionId: "test-session",
    workspaceDir: "/workspace",
    prompt: "test",
    sessionKey,
    config,
  };
}

// ---------------------------------------------------------------------------
// Parity Tests
// ---------------------------------------------------------------------------

describe("RuntimeResolver parity with resolveSessionRuntimeKind", () => {
  const resolver = new DefaultRuntimeResolver();

  describe("no config (defaults)", () => {
    it("should return pi for main agent with no config", async () => {
      const oldResult = resolveSessionRuntimeKind(undefined, "main", undefined);
      const newResult = await resolver.resolve(createRequest(undefined, "main"));

      expect(newResult.kind).toBe(oldResult);
      expect(newResult.kind).toBe("pi");
    });

    it("should return pi for named agent with no config", async () => {
      const oldResult = resolveSessionRuntimeKind(undefined, "custom-agent", undefined);
      const newResult = await resolver.resolve(createRequest(undefined, "custom-agent"));

      expect(newResult.kind).toBe(oldResult);
      expect(newResult.kind).toBe("pi");
    });
  });

  describe("global runtime defaults", () => {
    it("should return claude when agents.defaults.runtime is claude", async () => {
      const config = createConfig({
        agents: {
          defaults: {
            runtime: "claude",
          },
        },
      });

      const oldResult = resolveSessionRuntimeKind(config, "main", undefined);
      const newResult = await resolver.resolve(createRequest(config, "main"));

      expect(newResult.kind).toBe(oldResult);
      expect(newResult.kind).toBe("claude");
    });

    it("should return pi when agents.defaults.runtime is pi", async () => {
      const config = createConfig({
        agents: {
          defaults: {
            runtime: "pi",
          },
        },
      });

      const oldResult = resolveSessionRuntimeKind(config, "main", undefined);
      const newResult = await resolver.resolve(createRequest(config, "main"));

      expect(newResult.kind).toBe(oldResult);
      expect(newResult.kind).toBe("pi");
    });
  });

  describe("mainRuntime special handling", () => {
    it("should use mainRuntime for main agent over global default", async () => {
      const config = createConfig({
        agents: {
          defaults: {
            runtime: "pi",
            mainRuntime: "claude",
          },
        },
      });

      const oldResult = resolveSessionRuntimeKind(config, "main", undefined);
      const newResult = await resolver.resolve(createRequest(config, "main"));

      expect(newResult.kind).toBe(oldResult);
      expect(newResult.kind).toBe("claude");
    });

    it("should use agents.main.runtime for main agent", async () => {
      const config = createConfig({
        agents: {
          defaults: {
            runtime: "pi",
          },
          main: {
            runtime: "claude",
          },
        },
      });

      const oldResult = resolveSessionRuntimeKind(config, "main", undefined);
      const newResult = await resolver.resolve(createRequest(config, "main"));

      expect(newResult.kind).toBe(oldResult);
      expect(newResult.kind).toBe("claude");
    });

    it("mainRuntime should NOT apply to non-main agents", async () => {
      const config = createConfig({
        agents: {
          defaults: {
            runtime: "pi",
            mainRuntime: "claude",
          },
        },
      });

      const oldResult = resolveSessionRuntimeKind(config, "custom-agent", undefined);
      const newResult = await resolver.resolve(createRequest(config, "custom-agent"));

      expect(newResult.kind).toBe(oldResult);
      expect(newResult.kind).toBe("pi");
    });
  });

  describe("per-agent runtime override", () => {
    it("should use per-agent runtime from agents.list", async () => {
      const config = createConfig({
        agents: {
          defaults: {
            runtime: "pi",
          },
          list: [
            {
              id: "claude-agent",
              runtime: "claude",
            },
          ],
        },
      });

      const oldResult = resolveSessionRuntimeKind(config, "claude-agent", undefined);
      const newResult = await resolver.resolve(createRequest(config, "claude-agent"));

      expect(newResult.kind).toBe(oldResult);
      expect(newResult.kind).toBe("claude");
    });

    it("should fallback to global default for agents not in list", async () => {
      const config = createConfig({
        agents: {
          defaults: {
            runtime: "claude",
          },
          list: [
            {
              id: "specific-agent",
              runtime: "pi",
            },
          ],
        },
      });

      const oldResult = resolveSessionRuntimeKind(config, "other-agent", undefined);
      const newResult = await resolver.resolve(createRequest(config, "other-agent"));

      expect(newResult.kind).toBe(oldResult);
      expect(newResult.kind).toBe("claude");
    });
  });

  describe("subagent runtime inheritance", () => {
    it("should inherit parent runtime for subagent sessions", async () => {
      const config = createConfig({
        agents: {
          defaults: {
            runtime: "claude",
          },
        },
      });
      const subagentSessionKey = "agent:main:subagent:abc123";

      const oldResult = resolveSessionRuntimeKind(config, "main", subagentSessionKey);
      const newResult = await resolver.resolve(createRequest(config, "main", subagentSessionKey));

      expect(newResult.kind).toBe(oldResult);
      expect(newResult.kind).toBe("claude");
    });

    it("should use explicit subagent runtime config", async () => {
      const config = createConfig({
        agents: {
          defaults: {
            runtime: "pi",
            subagents: {
              runtime: "claude",
            },
          },
        },
      });
      const subagentSessionKey = "agent:main:subagent:abc123";

      const oldResult = resolveSessionRuntimeKind(config, "main", subagentSessionKey);
      const newResult = await resolver.resolve(createRequest(config, "main", subagentSessionKey));

      expect(newResult.kind).toBe(oldResult);
      expect(newResult.kind).toBe("claude");
    });

    it("should use per-agent subagent runtime config", async () => {
      const config = createConfig({
        agents: {
          defaults: {
            runtime: "pi",
          },
          list: [
            {
              id: "main",
              subagents: {
                runtime: "claude",
              },
            },
          ],
        },
      });
      const subagentSessionKey = "agent:main:subagent:abc123";

      const oldResult = resolveSessionRuntimeKind(config, "main", subagentSessionKey);
      const newResult = await resolver.resolve(createRequest(config, "main", subagentSessionKey));

      expect(newResult.kind).toBe(oldResult);
      expect(newResult.kind).toBe("claude");
    });

    it("should inherit when subagent runtime is 'inherit'", async () => {
      const config = createConfig({
        agents: {
          defaults: {
            runtime: "claude",
            subagents: {
              runtime: "inherit",
            },
          },
        },
      });
      const subagentSessionKey = "agent:main:subagent:abc123";

      const oldResult = resolveSessionRuntimeKind(config, "main", subagentSessionKey);
      const newResult = await resolver.resolve(createRequest(config, "main", subagentSessionKey));

      expect(newResult.kind).toBe(oldResult);
      expect(newResult.kind).toBe("claude");
    });

    it("should not apply subagent config to non-subagent sessions", async () => {
      const config = createConfig({
        agents: {
          defaults: {
            runtime: "pi",
            subagents: {
              runtime: "claude",
            },
          },
        },
      });
      const regularSessionKey = "agent:main:sess:abc123";

      const oldResult = resolveSessionRuntimeKind(config, "main", regularSessionKey);
      const newResult = await resolver.resolve(createRequest(config, "main", regularSessionKey));

      expect(newResult.kind).toBe(oldResult);
      expect(newResult.kind).toBe("pi");
    });
  });

  describe("agent ID normalization", () => {
    it("should normalize agent:main to agent-main (matches upstream)", async () => {
      // Note: normalizeAgentId converts "agent:main" to "agent-main" (colon → dash).
      // This matches upstream/main behavior. The "agent:" prefix is NOT stripped.
      const config = createConfig({
        agents: {
          defaults: {
            mainRuntime: "claude",
          },
        },
      });

      const oldResult = resolveSessionRuntimeKind(config, "agent:main", undefined);
      const newResult = await resolver.resolve(createRequest(config, "agent:main"));

      // Both old and new return "pi" because "agent-main" !== "main"
      expect(newResult.kind).toBe(oldResult);
      expect(newResult.kind).toBe("pi");
    });
  });
});

describe("RuntimeResolver parity with resolveAgentRuntimeKind", () => {
  const resolver = new DefaultRuntimeResolver();

  it("should match resolveAgentRuntimeKind for regular agents", async () => {
    const config = createConfig({
      agents: {
        defaults: {
          runtime: "claude",
        },
      },
    });

    const oldResult = resolveAgentRuntimeKind(config, "test-agent");
    const newResult = await resolver.resolve(createRequest(config, "test-agent"));

    expect(newResult.kind).toBe(oldResult);
  });
});

describe("RuntimeResolver parity with resolveMainAgentRuntimeKind", () => {
  const resolver = new DefaultRuntimeResolver();

  it("should match resolveMainAgentRuntimeKind for main agent", async () => {
    const config = createConfig({
      agents: {
        defaults: {
          mainRuntime: "claude",
        },
      },
    });

    const oldResult = resolveMainAgentRuntimeKind(config);
    const newResult = await resolver.resolve(createRequest(config, "main"));

    expect(newResult.kind).toBe(oldResult);
  });
});
