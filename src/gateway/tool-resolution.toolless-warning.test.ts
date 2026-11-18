import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const { createTools, logWarn } = vi.hoisted(() => ({
  createTools: vi.fn(() =>
    ["sessions_spawn", "automations"].map((name) => ({
      name,
      description: `${name} tool`,
      parameters: { type: "object", properties: {} },
      execute: vi.fn(),
    })),
  ),
  logWarn: vi.fn(),
}));

// mock-isolation: Scope fixture Gateway tools without constructing plugin or channel integrations.
vi.mock("../agents/openclaw-tools.js", () => ({
  createOpenClawToolsAsync: async () => createTools(),
}));

// mock-isolation: Observe policy warnings without writing to the shared log sink.
vi.mock("../logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logger.js")>()),
  logWarn,
}));

import { resolveGatewayScopedTools } from "./tool-resolution.js";

const NATIVE_CLI_TOOLS = ["read", "write", "edit", "apply_patch", "exec", "process"];

function configWithAgentAllow(allow: string[]): OpenClawConfig {
  return { agents: { entries: { greeter: { tools: { allow } } } } };
}

function unknownAllowlistWarnings(): string[] {
  return logWarn.mock.calls
    .map(([message]) => String(message))
    .filter((message) => message.includes("allowlist contains unknown entries"));
}

describe("resolveGatewayScopedTools allowlist warnings", () => {
  beforeEach(() => {
    logWarn.mockClear();
  });

  it("does not report configured allowlist entries as unavailable when the turn grants no tools", async () => {
    const result = await resolveGatewayScopedTools({
      cfg: configWithAgentAllow(["write", "exec"]),
      sessionKey: "agent:greeter:main",
      surface: "loopback",
      toolsAllow: [],
      excludeToolNames: NATIVE_CLI_TOOLS,
    });

    expect(result.agentId).toBe("greeter");
    expect(unknownAllowlistWarnings()).toEqual([]);
  });

  it("still reports the same entries on a later turn without a tool restriction", async () => {
    await resolveGatewayScopedTools({
      cfg: configWithAgentAllow(["write", "exec"]),
      sessionKey: "agent:greeter:main",
      surface: "loopback",
      excludeToolNames: NATIVE_CLI_TOOLS,
    });

    expect(unknownAllowlistWarnings()).toEqual([
      expect.stringContaining("agents.greeter.tools.allow allowlist contains unknown entries"),
    ]);
  });
});
