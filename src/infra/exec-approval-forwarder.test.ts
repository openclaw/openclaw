import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

function getFirstDeliveryPayload(deliver: ReturnType<typeof vi.fn>): {
  text?: string;
  channelData?: Record<string, unknown>;
} {
  const firstCall = deliver.mock.calls[0]?.[0] as
    | { payloads?: Array<{ text?: string; channelData?: Record<string, unknown> }> }
    | undefined;
  return firstCall?.payloads?.[0] ?? {};
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

function makeSessionCfg(
  options: {
    discordExecApprovalsEnabled?: boolean;
    discordAllowFrom?: string[];
  } = {},
): OpenClawConfig {
  const discordChannelConfig: Record<string, unknown> = {};
  if (options.discordAllowFrom?.length) {
    discordChannelConfig.allowFrom = options.discordAllowFrom;
  }
  if (options.discordExecApprovalsEnabled) {
    discordChannelConfig.execApprovals = {
      enabled: true,
      approvers: ["123"],
    };
  }
  return {
    ...(Object.keys(discordChannelConfig).length > 0
      ? {
          channels: {
            discord: discordChannelConfig,
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
    expect(deliver).toHaveBeenCalledTimes(1);

    await vi.runAllTimersAsync();
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("formats single-line commands as inline code", async () => {
    vi.useFakeTimers();
    const { deliver, forwarder } = createForwarder({ cfg: TARGETS_CFG });

    await expect(forwarder.handleRequested(baseRequest)).resolves.toBe(true);

    expect(getFirstDeliveryText(deliver)).toContain("Command: `echo hello`");
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

    expect(getFirstDeliveryText(deliver)).toContain("Command:\n```\necho `uname`\necho done\n```");
  });

  it("returns false when forwarding is explicitly disabled", async () => {
    const { deliver, forwarder } = createForwarder({
      cfg: {
        approvals: { exec: { enabled: false } },
      } as OpenClawConfig,
    });
    await expect(forwarder.handleRequested(baseRequest)).resolves.toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("forwards by default when approvals.exec is omitted", async () => {
    const { deliver, forwarder } = createForwarder({
      cfg: {} as OpenClawConfig,
      resolveSessionTarget: () => ({ channel: "slack", to: "U1" }),
    });
    await expect(forwarder.handleRequested(baseRequest)).resolves.toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);
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

  it("skips discord forwarding when discord allowFrom implies inline approval handler", async () => {
    await expectDiscordSessionTargetRequest({
      cfg: makeSessionCfg({ discordAllowFrom: ["123"] }),
      expectedAccepted: false,
      expectedDeliveryCount: 0,
    });
  });

  it("prefers turn-source routing over stale session last route", async () => {
    vi.useFakeTimers();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-exec-approval-forwarder-test-"));
    try {
      const storePath = path.join(tmpDir, "sessions.json");
      fs.writeFileSync(
        storePath,
        JSON.stringify({
          "agent:main:main": {
            updatedAt: 1,
            channel: "slack",
            to: "U1",
            lastChannel: "slack",
            lastTo: "U1",
          },
        }),
        "utf-8",
      );

      const cfg = {
        session: { store: storePath },
        approvals: { exec: { enabled: true, mode: "session" } },
      } as OpenClawConfig;

      const { deliver, forwarder } = createForwarder({ cfg });
      await expect(
        forwarder.handleRequested({
          ...baseRequest,
          request: {
            ...baseRequest.request,
            turnSourceChannel: "whatsapp",
            turnSourceTo: "+15555550123",
            turnSourceAccountId: "work",
            turnSourceThreadId: "1739201675.123",
          },
        }),
      ).resolves.toBe(true);

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(deliver).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "whatsapp",
          to: "+15555550123",
          accountId: "work",
          threadId: "1739201675.123",
        }),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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

    expect(getFirstDeliveryText(deliver)).toContain("Command:\n````\necho ```danger```\n````");
  });

  it("adds Telegram inline approval buttons for forwarded requests", async () => {
    vi.useFakeTimers();
    const { deliver, forwarder } = createForwarder({ cfg: TARGETS_CFG });
    await expect(forwarder.handleRequested(baseRequest)).resolves.toBe(true);

    const payload = getFirstDeliveryPayload(deliver);
    expect(payload.channelData).toEqual({
      telegram: {
        buttons: [
          [
            { text: "✅ Allow", callback_data: "/approve req-1 allow-once" },
            { text: "⚠️ Always", callback_data: "/approve req-1 allow-always" },
            { text: "❌ Deny", callback_data: "/approve req-1 deny" },
          ],
        ],
      },
    });
  });

  it("adds Slack action blocks for forwarded requests", async () => {
    vi.useFakeTimers();
    const cfg = {
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "slack", to: "C1" }],
        },
      },
    } as OpenClawConfig;
    const { deliver, forwarder } = createForwarder({ cfg });
    await expect(forwarder.handleRequested(baseRequest)).resolves.toBe(true);

    const payload = getFirstDeliveryPayload(deliver);
    expect(payload.channelData).toEqual({
      slack: {
        blocks: [
          {
            type: "actions",
            block_id: "openclaw_exec_approval_req-1",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "✅ Allow once", emoji: true },
                style: "primary",
                action_id: "openclaw:exec-approval:allow-once",
                value: "req-1",
              },
              {
                type: "button",
                text: { type: "plain_text", text: "⚠️ Always allow", emoji: true },
                action_id: "openclaw:exec-approval:allow-always",
                value: "req-1",
              },
              {
                type: "button",
                text: { type: "plain_text", text: "❌ Deny", emoji: true },
                style: "danger",
                action_id: "openclaw:exec-approval:deny",
                value: "req-1",
              },
            ],
          },
        ],
      },
    });
  });
});
