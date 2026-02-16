import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createExecApprovalForwarder } from "./exec-approval-forwarder.js";

const baseRequest = {
  id: "req-1",
  request: {
    command: "echo hello",
    agentId: "main",
    sessionKey: "agent:main:main",
  },
  createdAtMs: 1000,
  expiresAtMs: 6000,
};

afterEach(() => {
  vi.useRealTimers();
});

function getFirstDeliveryText(deliver: ReturnType<typeof vi.fn>): string {
  const firstCall = deliver.mock.calls[0]?.[0] as
    | { payloads?: Array<{ text?: string }> }
    | undefined;
  return firstCall?.payloads?.[0]?.text ?? "";
}

const TARGETS_CFG = {
  approvals: {
    exec: {
      enabled: true,
      mode: "targets",
      targets: [{ channel: "telegram", to: "123" }],
    },
  },
} as OpenClawConfig;

function createForwarder(params: {
  cfg: OpenClawConfig;
  deliver?: ReturnType<typeof vi.fn>;
  resolveSessionTarget?: () => { channel: string; to: string } | null;
}) {
  const deliver = params.deliver ?? vi.fn().mockResolvedValue([]);
  const forwarder = createExecApprovalForwarder({
    getConfig: () => params.cfg,
    deliver,
    nowMs: () => 1000,
    resolveSessionTarget: params.resolveSessionTarget ?? (() => null),
  });
  return { deliver, forwarder };
}

describe("exec approval forwarder", () => {
  it("forwards to session target and resolves", async () => {
    vi.useFakeTimers();
    const cfg = {
      approvals: { exec: { enabled: true, mode: "session" } },
    } as OpenClawConfig;

    const { deliver, forwarder } = createForwarder({
      cfg,
      resolveSessionTarget: () => ({ channel: "slack", to: "U1" }),
    });

    await forwarder.handleRequested(baseRequest);
    expect(deliver).toHaveBeenCalledTimes(1);

    await forwarder.handleResolved({
      id: baseRequest.id,
      decision: "allow-once",
      resolvedBy: "slack:U1",
      ts: 2000,
    });
    expect(deliver).toHaveBeenCalledTimes(2);

    await vi.runAllTimersAsync();
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("forwards to explicit targets and expires", async () => {
    vi.useFakeTimers();
    const { deliver, forwarder } = createForwarder({ cfg: TARGETS_CFG });

    await forwarder.handleRequested(baseRequest);
    expect(deliver).toHaveBeenCalledTimes(1);

    await vi.runAllTimersAsync();
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("formats single-line commands as inline code", async () => {
    vi.useFakeTimers();
    const { deliver, forwarder } = createForwarder({ cfg: TARGETS_CFG });

    await forwarder.handleRequested(baseRequest);

    expect(getFirstDeliveryText(deliver)).toContain("Command: `echo hello`");
  });

  it("formats complex commands as fenced code blocks", async () => {
    vi.useFakeTimers();
    const { deliver, forwarder } = createForwarder({ cfg: TARGETS_CFG });

    await forwarder.handleRequested({
      ...baseRequest,
      request: {
        ...baseRequest.request,
        command: "echo `uname`\necho done",
      },
    });

    expect(getFirstDeliveryText(deliver)).toContain("Command:\n```\necho `uname`\necho done\n```");
  });

  it("skips discord forwarding when discord exec approvals target channel", async () => {
    vi.useFakeTimers();
    const cfg = {
      approvals: { exec: { enabled: true, mode: "session" } },
      channels: {
        discord: {
          execApprovals: {
            enabled: true,
            target: "channel",
            approvers: ["123"],
          },
        },
      },
    } as OpenClawConfig;

    const { deliver, forwarder } = createForwarder({
      cfg,
      resolveSessionTarget: () => ({ channel: "discord", to: "channel:123" }),
    });

    await forwarder.handleRequested(baseRequest);

    expect(deliver).not.toHaveBeenCalled();
  });

  it("uses a longer fence when command already contains triple backticks", async () => {
    vi.useFakeTimers();
    const { deliver, forwarder } = createForwarder({ cfg: TARGETS_CFG });

    await forwarder.handleRequested({
      ...baseRequest,
      request: {
        ...baseRequest.request,
        command: "echo ```danger```",
      },
    });

    expect(getFirstDeliveryText(deliver)).toContain("Command:\n````\necho ```danger```\n````");
  });
});
