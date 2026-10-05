import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { buildForwardedExecResolvedPayload } from "./exec-approval-forwarder.messages.js";
import type { ExecApprovalResolved } from "./exec-approvals.js";

const cfg = {} as OpenClawConfig;
const target = { channel: "telegram", to: "123" } as const;

function buildResolvedText(resolved: ExecApprovalResolved): string | undefined {
  return buildForwardedExecResolvedPayload({ cfg, resolved, target }).text;
}

describe("buildForwardedExecResolvedPayload", () => {
  beforeEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("includes the approved command when the resolution carries the request", () => {
    const text = buildResolvedText({
      id: "req-1",
      decision: "allow-once",
      resolvedBy: "agent",
      ts: 2000,
      request: {
        command: "echo hello",
        agentId: "main",
        sessionKey: "agent:main:main",
      },
    });

    expect(text).toBe(
      "✅ Exec approval allowed once. Resolved by agent. ID: req-1\nCommand: `echo hello`",
    );
  });

  it("keeps the existing message when the request payload is absent", () => {
    const text = buildResolvedText({
      id: "req-2",
      decision: "deny",
      resolvedBy: "slack:U1",
      ts: 2000,
    });

    expect(text).toBe("✅ Exec approval denied. Resolved by slack:U1. ID: req-2");
  });

  it("keeps the existing message when the request has no command text", () => {
    const text = buildResolvedText({
      id: "req-3",
      decision: "allow-once",
      ts: 2000,
      request: {
        command: "",
        agentId: "main",
        sessionKey: "agent:main:main",
      },
    });

    expect(text).toBe("✅ Exec approval allowed once. ID: req-3");
  });

  it("truncates long commands", () => {
    const command = `echo ${"a".repeat(500)}`;
    const text = buildResolvedText({
      id: "req-4",
      decision: "allow-once",
      resolvedBy: "agent",
      ts: 2000,
      request: {
        command,
        agentId: "main",
        sessionKey: "agent:main:main",
      },
    });

    const commandLine = text?.split("\n")[1] ?? "";
    expect(commandLine.startsWith("Command: `echo aaaa")).toBe(true);
    expect(commandLine.endsWith("…`")).toBe(true);
    expect(commandLine.length).toBeLessThan(command.length);
    expect(commandLine).not.toContain("a".repeat(500));
  });

  it("redacts secrets in the approved command like the pending prompt", () => {
    const text = buildResolvedText({
      id: "req-5",
      decision: "allow-once",
      resolvedBy: "agent",
      ts: 2000,
      request: {
        command:
          "curl -H 'Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789' https://example.com",
        agentId: "main",
        sessionKey: "agent:main:main",
      },
    });

    expect(text).toContain("Command:");
    expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });
});
