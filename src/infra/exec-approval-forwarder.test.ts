import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telegramOutbound } from "../channels/plugins/outbound/telegram.js";
import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
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
  vi.restoreAllMocks();
});

const emptyRegistry = createTestRegistry([]);
const defaultRegistry = createTestRegistry([
  {
    pluginId: "telegram",
    plugin: createOutboundTestPlugin({ id: "telegram", outbound: telegramOutbound }),
    source: "test",
  },
]);

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
      targets: [{ channel: "slack", to: "U123" }],
    },
  },
} as OpenClawConfig;

function createForwarder(params: {
  cfg: OpenClawConfig;
  deliver?: ReturnType<typeof vi.fn>;
  resolveSessionTarget?: () => { channel: string; to: string } | null;
}) {
  const deliver = params.deliver ?? vi.fn().mockResolvedValue([]);
  const deps: NonNullable<Parameters<typeof createExecApprovalForwarder>[0]> = {
    getConfig: () => params.cfg,
    deliver: deliver as unknown as NonNullable<
      NonNullable<Parameters<typeof createExecApprovalForwarder>[0]>["deliver"]
    >,
    nowMs: () => 1000,
  };
  if (params.resolveSessionTarget !== undefined) {
    deps.resolveSessionTarget = params.resolveSessionTarget;
  }
  const forwarder = createExecApprovalForwarder(deps);
  return { deliver, forwarder };
}

function makeSessionCfg(options: { discordExecApprovalsEnabled?: boolean } = {}): OpenClawConfig {
  return {
    ...(options.discordExecApprovalsEnabled
      ? {
          channels: {
            discord: {
              execApprovals: {
                enabled: true,
                approvers: ["123"],
              },
            },
          },
        }
      : {}),
    approvals: { exec: { enabled: true, mode: "session" } },
  } as OpenClawConfig;
}

async function expectDiscordSessionTargetRequest(params: {
  cfg: OpenClawConfig;
  expectedAccepted: boolean;
  expectedDeliveryCount: number;
}) {
  vi.useFakeTimers();
  const { deliver, forwarder } = createForwarder({
    cfg: params.cfg,
    resolveSessionTarget: () => ({ channel: "discord", to: "channel:123" }),
  });

  await expect(forwarder.handleRequested(baseRequest)).resolves.toBe(params.expectedAccepted);
  if (params.expectedDeliveryCount === 0) {
    expect(deliver).not.toHaveBeenCalled();
    return;
  }
  expect(deliver).toHaveBeenCalledTimes(params.expectedDeliveryCount);
}

async function expectSessionFilterRequestResult(params: {
  sessionFilter: string[];
  sessionKey: string;
  expectedAccepted: boolean;
  expectedDeliveryCount: number;
}) {
  const cfg = {
    approvals: {
      exec: {
        enabled: true,
        mode: "session",
        sessionFilter: params.sessionFilter,
      },
    },
  } as OpenClawConfig;

  const { deliver, forwarder } = createForwarder({
    cfg,
    resolveSessionTarget: () => ({ channel: "slack", to: "U1" }),
  });

  const request = {
    ...baseRequest,
    request: {
      ...baseRequest.request,
      sessionKey: params.sessionKey,
    },
  };

  await expect(forwarder.handleRequested(request)).resolves.toBe(params.expectedAccepted);
  expect(deliver).toHaveBeenCalledTimes(params.expectedDeliveryCount);
}

describe("exec approval forwarder", () => {
  beforeEach(() => {
    setActivePluginRegistry(defaultRegistry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("forwards to session target and resolves", async () => {
    vi.useFakeTimers();
    const cfg = {
      approvals: { exec: { enabled: true, mode: "session" } },
    } as OpenClawConfig;

    const { deliver, forwarder } = createForwarder({
      cfg,
      resolveSessionTarget: () => ({ channel: "slack", to: "U1" }),
    });

    await expect(forwarder.handleRequested(baseRequest)).resolves.toBe(true);
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

    await expect(forwarder.handleRequested(baseRequest)).resolves.toBe(true);
    await Promise.resolve();
    expect(deliver).toHaveBeenCalledTimes(1);

    await vi.runAllTimersAsync();
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("skips telegram forwarding when telegram exec approvals handler is enabled", async () => {
    vi.useFakeTimers();
    const cfg = {
      approvals: {
        exec: {
          enabled: true,
          mode: "session",
        },
      },
      channels: {
        telegram: {
          execApprovals: {
            enabled: true,
            approvers: ["123"],
            target: "channel",
          },
        },
      },
    } as OpenClawConfig;

    const { deliver, forwarder } = createForwarder({
      cfg,
      resolveSessionTarget: () => ({ channel: "telegram", to: "-100999", threadId: 77 }),
    });

    await expect(
      forwarder.handleRequested({
        ...baseRequest,
        request: {
          ...baseRequest.request,
          turnSourceChannel: "telegram",
          turnSourceTo: "-100999",
          turnSourceThreadId: "77",
          turnSourceAccountId: "default",
        },
      }),
    ).resolves.toBe(false);

    expect(deliver).not.toHaveBeenCalled();
  });

  it("attaches explicit telegram buttons in forwarded telegram fallback payloads", async () => {
    vi.useFakeTimers();
    const cfg = {
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "telegram", to: "123" }],
        },
      },
    } as OpenClawConfig;

    const { deliver, forwarder } = createForwarder({ cfg });

    await expect(
      forwarder.handleRequested({
        ...baseRequest,
        request: {
          ...baseRequest.request,
          turnSourceChannel: "discord",
          turnSourceTo: "channel:123",
        },
      }),
    ).resolves.toBe(true);

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "123",
        payloads: [
          expect.objectContaining({
            channelData: {
              execApproval: expect.objectContaining({
                approvalId: "req-1",
              }),
              telegram: {
                buttons: [
                  [
                    { text: "Allow Once", callback_data: "/approve req-1 allow-once" },
                    { text: "Allow Always", callback_data: "/approve req-1 allow-always" },
                  ],
                  [{ text: "Deny", callback_data: "/approve req-1 deny" }],
                ],
              },
            },
          }),
        ],
      }),
    );
  });

  it("formats single-line commands as inline code", async () => {
    vi.useFakeTimers();
    const { deliver, forwarder } = createForwarder({ cfg: TARGETS_CFG });

    await expect(forwarder.handleRequested(baseRequest)).resolves.toBe(true);
    await Promise.resolve();

    const text = getFirstDeliveryText(deliver);
    expect(text).toContain("🔒 Exec approval required");
    expect(text).toContain("Command: `echo hello`");
    expect(text).toContain("Expires in: 5s");
    expect(text).toContain("Reply with: /approve <id> allow-once|allow-always|deny");
  });

  it("renders invisible Unicode format chars as visible escapes", async () => {
    vi.useFakeTimers();
    const { deliver, forwarder } = createForwarder({ cfg: TARGETS_CFG });

    await expect(
      forwarder.handleRequested({
        ...baseRequest,
        request: {
          ...baseRequest.request,
          command: "bash safe\u200B.sh",
        },
      }),
    ).resolves.toBe(true);
    await Promise.resolve();

    expect(getFirstDeliveryText(deliver)).toContain("Command: `bash safe\\u{200B}.sh`");
  });

  it("formats complex commands as fenced code blocks", async () => {
    vi.useFakeTimers();
    const { deliver, forwarder } = createForwarder({ cfg: TARGETS_CFG });

    await expect(
      forwarder.handleRequested({
        ...baseRequest,
        request: {
          ...baseRequest.request,
          command: "echo `uname`\necho done",
        },
      }),
    ).resolves.toBe(true);
    await Promise.resolve();

    expect(getFirstDeliveryText(deliver)).toContain("```\necho `uname`\necho done\n```");
  });

  it("returns false when forwarding is disabled", async () => {
    const { deliver, forwarder } = createForwarder({
      cfg: {} as OpenClawConfig,
    });
    await expect(forwarder.handleRequested(baseRequest)).resolves.toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("rejects unsafe nested-repetition regex in sessionFilter", async () => {
    await expectSessionFilterRequestResult({
      sessionFilter: ["(a+)+$"],
      sessionKey: `${"a".repeat(28)}!`,
      expectedAccepted: false,
      expectedDeliveryCount: 0,
    });
  });

  it("matches long session keys with tail-bounded regex checks", async () => {
    await expectSessionFilterRequestResult({
      sessionFilter: ["discord:tail$"],
      sessionKey: `${"x".repeat(5000)}discord:tail`,
      expectedAccepted: true,
      expectedDeliveryCount: 1,
    });
  });

  it("returns false when all targets are skipped", async () => {
    await expectDiscordSessionTargetRequest({
      cfg: makeSessionCfg({ discordExecApprovalsEnabled: true }),
      expectedAccepted: false,
      expectedDeliveryCount: 0,
    });
  });

  it("forwards to discord when discord exec approvals handler is disabled", async () => {
    await expectDiscordSessionTargetRequest({
      cfg: makeSessionCfg(),
      expectedAccepted: true,
      expectedDeliveryCount: 1,
    });
  });

  it("skips discord forwarding when discord exec approvals handler is enabled", async () => {
    await expectDiscordSessionTargetRequest({
      cfg: makeSessionCfg({ discordExecApprovalsEnabled: true }),
      expectedAccepted: false,
      expectedDeliveryCount: 0,
    });
  });

  it("can forward resolved notices without pending cache when request payload is present", async () => {
    vi.useFakeTimers();
    const cfg = {
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "telegram", to: "123" }],
        },
      },
    } as OpenClawConfig;
    const { deliver, forwarder } = createForwarder({ cfg });

    await forwarder.handleResolved({
      id: "req-missing",
      decision: "allow-once",
      resolvedBy: "telegram:123",
      ts: 2000,
      request: {
        command: "echo ok",
        agentId: "main",
        sessionKey: "agent:main:main",
      },
    });

    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("uses a longer fence when command already contains triple backticks", async () => {
    vi.useFakeTimers();
    const { deliver, forwarder } = createForwarder({ cfg: TARGETS_CFG });

    await expect(
      forwarder.handleRequested({
        ...baseRequest,
        request: {
          ...baseRequest.request,
          command: "echo ```danger```",
        },
      }),
    ).resolves.toBe(true);
    await Promise.resolve();

    expect(getFirstDeliveryText(deliver)).toContain("````\necho ```danger```\n````");
  });
});
