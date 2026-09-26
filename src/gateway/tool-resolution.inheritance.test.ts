/**
 * Gateway loopback tool-inheritance tests.
 *
 * Regression coverage for https://github.com/openclaw/openclaw/issues/111631.
 *
 * A harness-backed caller owns the core coding tools natively, so this surface
 * withholds them to avoid materializing a second copy. That is transport
 * deduplication, not an authority denial, and it must not narrow the allowlist
 * a spawned child inherits. Explicit denials must still bind the child.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const hoisted = vi.hoisted(() => {
  function makeTool(name: string) {
    return {
      name,
      description: `${name} tool`,
      parameters: { type: "object", properties: {} },
      execute: vi.fn(async () => ({ content: [], details: {} })),
    };
  }
  return {
    makeTool,
    createOpenClawToolsMock: vi.fn((_options?: { inheritedToolAllowlist?: string[] }) =>
      ["read", "write", "edit", "apply_patch", "process", "web_search", "sessions_spawn"].map(
        makeTool,
      ),
    ),
  };
});

vi.mock("../agents/openclaw-tools.js", () => ({
  createOpenClawTools: (options: Parameters<typeof hoisted.createOpenClawToolsMock>[0]) =>
    hoisted.createOpenClawToolsMock(options),
}));

vi.mock("../agents/agent-tools.js", () => ({
  createOpenClawCodingTools: () => [],
}));

vi.mock("../agents/lazy-exec-tool.js", () => ({
  createLazyExecTool: vi.fn(() => hoisted.makeTool("exec")),
  resolveExecToolConfig: vi.fn(() => ({})),
}));

import { resolveGatewayScopedTools } from "./tool-resolution.js";

const NATIVE_CODING_TOOLS = ["read", "write", "edit", "apply_patch", "process"];

/**
 * The resolver receives this array by reference and fills it after the final
 * policy pass, so it is only meaningful once resolution has returned.
 */
function readInheritedAllowlist(): string[] {
  const args = hoisted.createOpenClawToolsMock.mock.calls[0]?.[0];
  if (!args?.inheritedToolAllowlist) {
    throw new Error("expected createOpenClawTools to receive an inheritedToolAllowlist");
  }
  return args.inheritedToolAllowlist;
}

describe("resolveGatewayScopedTools requester-owned tool inheritance", () => {
  beforeEach(() => {
    hoisted.createOpenClawToolsMock.mockClear();
  });

  it("inherits requester-owned native tools withheld only for transport dedup", () => {
    const result = resolveGatewayScopedTools({
      cfg: {
        tools: { allow: [...NATIVE_CODING_TOOLS, "sessions_spawn"] },
      } as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
      excludeToolNames: NATIVE_CODING_TOOLS,
      requesterOwnedToolNames: NATIVE_CODING_TOOLS,
    });

    // The transport still hands back only what the caller does not already own.
    for (const name of NATIVE_CODING_TOOLS) {
      expect(result.tools.map((tool) => tool.name)).not.toContain(name);
    }
    // ...but the child inherits the parent's real authority, not that catalog.
    expect(readInheritedAllowlist()).toEqual(expect.arrayContaining(NATIVE_CODING_TOOLS));
  });

  it("does not inherit surface exclusions that are not requester-owned", () => {
    resolveGatewayScopedTools({
      cfg: { tools: { allow: ["read", "web_search", "sessions_spawn"] } } as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
      // `web_search` is disabled for this caller; only `read` is harness-owned.
      excludeToolNames: ["read", "web_search"],
      requesterOwnedToolNames: ["read"],
    });

    const inherited = readInheritedAllowlist();
    expect(inherited).toContain("read");
    expect(inherited).not.toContain("web_search");
  });

  it("ignores requester-owned names the surface never withheld", () => {
    resolveGatewayScopedTools({
      cfg: { tools: { allow: ["read", "write", "sessions_spawn"] } } as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
      excludeToolNames: ["read"],
      // `write` was never withheld, so claiming it here must not grant anything.
      requesterOwnedToolNames: ["read", "write"],
    });

    expect(readInheritedAllowlist()).toContain("read");
  });

  it("keeps explicit denies winning over requester-owned native tools", () => {
    resolveGatewayScopedTools({
      cfg: {
        tools: { allow: ["read", "write", "sessions_spawn"], deny: ["write"] },
        gateway: { tools: { deny: ["read"] } },
      } as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
      excludeToolNames: ["read", "write"],
      requesterOwnedToolNames: ["read", "write"],
    });

    const inherited = readInheritedAllowlist();
    expect(inherited).not.toContain("read");
    expect(inherited).not.toContain("write");
  });

  it("never inherits node-only exec as a generic child capability", () => {
    resolveGatewayScopedTools({
      cfg: { tools: { allow: ["read", "exec", "sessions_spawn"] } } as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
      includeNodeExecTool: true,
      nodeExecAvailable: () => true,
      excludeToolNames: ["read", "exec"],
      requesterOwnedToolNames: ["read", "exec"],
    });

    const inherited = readInheritedAllowlist();
    expect(inherited).toContain("read");
    expect(inherited).not.toContain("exec");
  });
});
