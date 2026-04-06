/**
 * Unit tests for the outbound messaging firewall (checkMessageFirewall).
 *
 * The firewall is tested indirectly via runMessageAction so we exercise the
 * real integration point without needing to export the private helper.
 * callGatewayTool is mocked to isolate approval-gateway I/O.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const mocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(),
}));

vi.mock("../../agents/tools/gateway.js", () => ({
  callGatewayTool: mocks.callGatewayTool,
}));

let runMessageAction: typeof import("./message-action-runner.js").runMessageAction;

// Import once — message-action-runner has no module-level mutable state, so a
// single load with a stable vi.mock() hoist is sufficient. vi.resetAllMocks()
// in beforeEach resets call tracking and implementations between tests.
beforeAll(async () => {
  ({ runMessageAction } = await import("./message-action-runner.js"));
});

beforeEach(() => {
  vi.resetAllMocks();
});

function makeFirewallCfg(
  overrides: { enabled?: boolean; selfTargets?: string[] } = {},
): OpenClawConfig {
  return {
    messages: {
      firewall: {
        enabled: overrides.enabled ?? true,
        selfTargets: overrides.selfTargets ?? [],
      },
    },
  } as unknown as OpenClawConfig;
}

/** Minimal runMessageAction input that routes through the send firewall check. */
function makeInput(
  to: string,
  cfg: OpenClawConfig,
  opts: { agentId?: string; cliMode?: boolean } = {},
) {
  return {
    action: "send" as const,
    cfg,
    params: { to, message: "hello", channel: "telegram" },
    toolContext: {},
    sessionKey: "test-session",
    agentId: opts.agentId ?? "test-agent",
    dryRun: false,
    abortSignal: undefined,
    // CLI sends always set gateway.mode = "cli"; tool sends leave gateway undefined.
    ...(opts.cliMode
      ? {
          gateway: {
            mode: "cli" as const,
            url: "",
            token: "",
            timeoutMs: 0,
            clientName: "cli" as const,
            clientDisplayName: "cli",
          },
        }
      : {}),
  };
}

describe("messaging firewall — checkMessageFirewall", () => {
  it("skips approval when firewall is disabled", async () => {
    const cfg = makeFirewallCfg({ enabled: false });
    mocks.callGatewayTool.mockResolvedValue({});
    await runMessageAction(makeInput("@target", cfg)).catch(() => {});
    expect(mocks.callGatewayTool).not.toHaveBeenCalledWith(
      "plugin.approval.request",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("skips approval when target is in selfTargets (bare)", async () => {
    const cfg = makeFirewallCfg({ selfTargets: ["@alice"] });
    mocks.callGatewayTool.mockResolvedValue({});
    await runMessageAction(makeInput("@alice", cfg)).catch(() => {});
    expect(mocks.callGatewayTool).not.toHaveBeenCalledWith(
      "plugin.approval.request",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("skips approval when target is in selfTargets (channel-qualified)", async () => {
    const cfg = makeFirewallCfg({ selfTargets: ["telegram:@alice"] });
    mocks.callGatewayTool.mockResolvedValue({});
    await runMessageAction(makeInput("@alice", cfg)).catch(() => {});
    expect(mocks.callGatewayTool).not.toHaveBeenCalledWith(
      "plugin.approval.request",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("skips approval when `to` is empty (false-positive guard)", async () => {
    const cfg = makeFirewallCfg();
    mocks.callGatewayTool.mockResolvedValue({});
    await runMessageAction(makeInput("", cfg)).catch(() => {});
    expect(mocks.callGatewayTool).not.toHaveBeenCalledWith(
      "plugin.approval.request",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("skips approval for CLI sends (gateway.mode === 'cli')", async () => {
    const cfg = makeFirewallCfg();
    mocks.callGatewayTool.mockResolvedValue({});
    await runMessageAction(makeInput("@stranger", cfg, { cliMode: true })).catch(() => {});
    expect(mocks.callGatewayTool).not.toHaveBeenCalledWith(
      "plugin.approval.request",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("requests approval for non-self target", async () => {
    const cfg = makeFirewallCfg({ selfTargets: ["@alice"] });
    mocks.callGatewayTool
      .mockResolvedValueOnce({ id: "approval-1" })
      .mockResolvedValueOnce({ decision: "allow-once" });
    await runMessageAction(makeInput("@bob", cfg)).catch(() => {});
    expect(mocks.callGatewayTool).toHaveBeenCalledWith(
      "plugin.approval.request",
      expect.anything(),
      expect.objectContaining({ pluginId: "messaging.firewall" }),
      expect.anything(),
    );
  });

  it("resolves when decision is allow-once", async () => {
    const cfg = makeFirewallCfg();
    mocks.callGatewayTool
      .mockResolvedValueOnce({ id: "approval-2" })
      .mockResolvedValueOnce({ decision: "allow-once" });
    // Should resolve without throwing — approval accepted
    await expect(runMessageAction(makeInput("@target", cfg))).resolves.not.toThrow();
  });

  it("resolves when decision is allow-always", async () => {
    const cfg = makeFirewallCfg();
    mocks.callGatewayTool
      .mockResolvedValueOnce({ id: "approval-3" })
      .mockResolvedValueOnce({ decision: "allow-always" });
    // Should resolve without throwing — approval accepted
    await expect(runMessageAction(makeInput("@target", cfg))).resolves.not.toThrow();
  });

  it("throws when decision is deny", async () => {
    const cfg = makeFirewallCfg();
    mocks.callGatewayTool
      .mockResolvedValueOnce({ id: "approval-4" })
      .mockResolvedValueOnce({ decision: "deny" });
    await expect(runMessageAction(makeInput("@stranger", cfg))).rejects.toThrow(/not approved/);
  });

  it("throws when approval infrastructure is unavailable (no id returned)", async () => {
    const cfg = makeFirewallCfg();
    mocks.callGatewayTool.mockResolvedValueOnce({}); // no id
    await expect(runMessageAction(makeInput("@target", cfg))).rejects.toThrow(
      /approval unavailable/,
    );
  });

  it("applies firewall to upload-file action (not only send)", async () => {
    // upload-file is an explicit-target outbound action; it must be subject to the
    // same firewall gate as send, sendWithEffect, sendAttachment, etc.
    // Without this, an agent could bypass human approval by using upload-file
    // instead of send to deliver content to a non-self target.
    const cfg = makeFirewallCfg();
    mocks.callGatewayTool.mockResolvedValueOnce({}); // no id → approval unavailable
    const input = {
      ...makeInput("@stranger", cfg, { agentId: "test-agent" }),
      action: "upload-file" as const,
      params: { to: "@stranger", target: "@stranger", channel: "telegram", filePath: "/tmp/doc.pdf" },
    };
    await expect(runMessageAction(input)).rejects.toThrow(/approval unavailable/);
  });
});
