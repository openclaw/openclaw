/**
 * Gateway tool-resolution tests.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

describe("resolveGatewayScopedTools", () => {
  beforeAll(() => {
    resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      messageProvider: "telegram",
      inboundEventKind: "room_event",
      surface: "loopback",
    });
  });

  it("force-allows the message tool for room-event loopback turns", () => {
    const result = resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      messageProvider: "telegram",
      inboundEventKind: "room_event",
      surface: "loopback",
    });

    const messageTool = result.tools.find((tool) => tool.name === "message");
    expect(messageTool?.description).toContain(
      "visible replies to the current source conversation",
    );
  });

  it("keeps webchat room-event turns on automatic source delivery", () => {
    const result = resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:webchat:forge-main",
      messageProvider: "webchat",
      inboundEventKind: "room_event",
      surface: "loopback",
    });

    expect(result.tools.some((tool) => tool.name === "message")).toBe(false);
  });

  it("force-allows the message tool for routed webchat room-event turns", () => {
    const result = resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      messageProvider: "webchat",
      inboundEventKind: "room_event",
      sourceReplyDeliveryMode: "message_tool_only",
      surface: "loopback",
    });

    const messageTool = result.tools.find((tool) => tool.name === "message");
    expect(messageTool?.description).toContain(
      "visible replies to the current source conversation",
    );
  });

  it("keeps ordinary loopback turns under the configured profile", () => {
    const result = resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      messageProvider: "telegram",
      inboundEventKind: "user_request",
      surface: "loopback",
    });

    expect(result.tools.some((tool) => tool.name === "message")).toBe(false);
  });

  // karmaterminal/openclaw#923 — the raw gateway catalog must reflect the FULL
  // continuation surface, not just continue_delegate, so /status, doctor, policy
  // and child-inheritance see all three. Before the fix, continue_work +
  // request_compaction were absent here (registration was gated on runner closures
  // this path never supplies); now the path registers them via stub callbacks so
  // the catalog is honest. (The MCP loopback further EXCLUDES continue_work +
  // request_compaction as internal/non-CLI-invocable — see mcp-http.runtime.test.ts;
  // that filtering is downstream of this raw resolution.)
  it("registers the full continuation surface in the raw gateway catalog when continuation is enabled (karmaterminal/openclaw#923)", () => {
    const result = resolveGatewayScopedTools({
      cfg: {
        agents: { defaults: { continuation: { enabled: true } } },
      } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      messageProvider: "telegram",
      inboundEventKind: "user_request",
      surface: "loopback",
    });

    const names = result.tools.map((tool) => tool.name);
    expect(names).toContain("continue_delegate");
    expect(names).toContain("continue_work");
    expect(names).toContain("request_compaction");
  });

  // karmaterminal/openclaw#923 (figs Q2) — registration honors per-tool bans:
  // the continuation trio gates on continuation.enabled, then a banned tool drops
  // out through the policy denylist → 2 register instead of 3.
  it("honors a per-tool ban — continuation registers the trio minus the banned tool", () => {
    const result = resolveGatewayScopedTools({
      cfg: {
        agents: { defaults: { continuation: { enabled: true } } },
        gateway: { tools: { deny: ["continue_work"] } },
      } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      messageProvider: "telegram",
      inboundEventKind: "user_request",
      surface: "loopback",
    });

    const names = result.tools.map((tool) => tool.name);
    expect(names).not.toContain("continue_work");
    expect(names).toContain("continue_delegate");
    expect(names).toContain("request_compaction");
  });
});
