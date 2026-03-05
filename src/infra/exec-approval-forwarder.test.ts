import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telegramOutbound } from "../channels/plugins/outbound/telegram.js";
import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import * as telegramSend from "../telegram/send.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createExecApprovalForwarder } from "./exec-approval-forwarder.js";
import { deliverOutboundPayloads } from "./outbound/deliver.js";

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
    expect(deliver).toHaveBeenCalledTimes(1);

    await vi.runAllTimersAsync();
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("forwards telegram approvals to approver dms when telegram exec approvals are enabled", async () => {
    vi.useFakeTimers();
    const cfg = {
      channels: {
        telegram: {
          execApprovals: {
            enabled: true,
            approvers: ["123", "456"],
            target: "dm",
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
        },
      }),
    ).resolves.toBe(true);

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls.map((call) => call[0]?.to)).toEqual(["123", "456"]);
  });

  it("attaches Telegram approval buttons and uses the full approval id in Telegram prompts", async () => {
    vi.useFakeTimers();
    const request = {
      ...baseRequest,
      id: "9f1c7d5d-b1fb-46ef-ac45-662723b65bb7",
      request: {
        ...baseRequest.request,
        turnSourceChannel: "telegram",
        turnSourceTo: "123",
      },
    };
    const cfg = {
      channels: {
        telegram: {
          execApprovals: {
            enabled: true,
            approvers: ["123"],
            target: "dm",
          },
        },
      },
    } as OpenClawConfig;

    const { deliver, forwarder } = createForwarder({
      cfg,
      resolveSessionTarget: () => ({ channel: "telegram", to: "123" }),
    });

    await expect(forwarder.handleRequested(request)).resolves.toBe(true);

    const firstCall = deliver.mock.calls[0]?.[0] as
      | { payloads?: Array<{ text?: string; channelData?: Record<string, unknown> }> }
      | undefined;
    const payload = firstCall?.payloads?.[0];
    expect(payload?.text).toContain(
      "```txt\n/approve 9f1c7d5d-b1fb-46ef-ac45-662723b65bb7 allow-once\n```",
    );
    expect(payload?.channelData).toMatchObject({
      execApproval: {
        approvalId: "9f1c7d5d-b1fb-46ef-ac45-662723b65bb7",
        approvalSlug: "9f1c7d5d",
      },
      telegram: {
        buttons: [
          [
            {
              text: "Allow Once",
              callback_data: "/approve 9f1c7d5d-b1fb-46ef-ac45-662723b65bb7 allow-once",
            },
            {
              text: "Allow Always",
              callback_data: "/approve 9f1c7d5d-b1fb-46ef-ac45-662723b65bb7 allow-always",
            },
          ],
          [
            {
              text: "Deny",
              callback_data: "/approve 9f1c7d5d-b1fb-46ef-ac45-662723b65bb7 deny",
            },
          ],
        ],
      },
    });
  });

  it("delivers forwarded Telegram approval prompts with inline buttons", async () => {
    vi.useFakeTimers();
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "123" });
    const cfg = {
      channels: {
        telegram: {
          botToken: "tok-1",
          execApprovals: {
            enabled: true,
            approvers: ["123"],
            target: "dm",
          },
        },
      },
    } as OpenClawConfig;

    const { forwarder } = createForwarder({
      cfg,
      deliver: ((params) =>
        deliverOutboundPayloads({
          ...params,
          deps: { sendTelegram },
          skipQueue: true,
        })) as ReturnType<typeof vi.fn>,
      resolveSessionTarget: () => ({ channel: "telegram", to: "123" }),
    });

    await expect(
      forwarder.handleRequested({
        ...baseRequest,
        id: "9f1c7d5d-b1fb-46ef-ac45-662723b65bb7",
        request: {
          ...baseRequest.request,
          command: "npm view diver name version description",
          turnSourceChannel: "telegram",
          turnSourceTo: "123",
        },
      }),
    ).resolves.toBe(true);
    await vi.runAllTimersAsync();

    expect(sendTelegram).toHaveBeenCalledWith(
      "123",
      expect.stringContaining("/approve 9f1c7d5d-b1fb-46ef-ac45-662723b65bb7 allow-once"),
      expect.objectContaining({
        buttons: [
          [
            {
              text: "Allow Once",
              callback_data: "/approve 9f1c7d5d-b1fb-46ef-ac45-662723b65bb7 allow-once",
            },
            {
              text: "Allow Always",
              callback_data: "/approve 9f1c7d5d-b1fb-46ef-ac45-662723b65bb7 allow-always",
            },
          ],
          [
            {
              text: "Deny",
              callback_data: "/approve 9f1c7d5d-b1fb-46ef-ac45-662723b65bb7 deny",
            },
          ],
        ],
      }),
    );
  });

  it("sends a Telegram typing cue before a forwarded approval prompt", async () => {
    vi.useFakeTimers();
    const sendTypingSpy = vi
      .spyOn(telegramSend, "sendTypingTelegram")
      .mockResolvedValue({ ok: true });
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "123" });
    const cfg = {
      channels: {
        telegram: {
          botToken: "tok-1",
          execApprovals: {
            enabled: true,
            approvers: ["123"],
            target: "channel",
          },
        },
      },
    } as OpenClawConfig;

    const { forwarder } = createForwarder({
      cfg,
      deliver: ((params) =>
        deliverOutboundPayloads({
          ...params,
          deps: { sendTelegram },
          skipQueue: true,
        })) as ReturnType<typeof vi.fn>,
      resolveSessionTarget: () => ({ channel: "telegram", to: "-100999", threadId: 77 }),
    });

    await expect(
      forwarder.handleRequested({
        ...baseRequest,
        id: "typing-req-1",
        request: {
          ...baseRequest.request,
          command: "npm view diver name version description",
          turnSourceChannel: "telegram",
          turnSourceTo: "-100999",
          turnSourceThreadId: "77",
        },
      }),
    ).resolves.toBe(true);

    expect(sendTypingSpy).toHaveBeenCalledWith(
      "-100999",
      expect.objectContaining({
        cfg,
        messageThreadId: 77,
      }),
    );
  });

  it("forwards telegram approvals to the originating topic when target=channel", async () => {
    vi.useFakeTimers();
    const cfg = {
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
        },
      }),
    ).resolves.toBe(true);

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "-100999",
        threadId: 77,
      }),
    );
  });

  it("formats single-line commands as inline code", async () => {
    vi.useFakeTimers();
    const { deliver, forwarder } = createForwarder({ cfg: TARGETS_CFG });

    await expect(forwarder.handleRequested(baseRequest)).resolves.toBe(true);

    const text = getFirstDeliveryText(deliver);
    expect(text).toContain("Approval required.");
    expect(text).toContain("```txt\n/approve req-1 allow-once\n```");
    expect(text).toContain("```sh\necho hello\n```");
    expect(text).toContain("Expires in: 5s");
    expect(text).toContain("Full id: `req-1`");
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

    expect(getFirstDeliveryText(deliver)).toContain("```sh\necho `uname`\necho done\n```");
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

    expect(getFirstDeliveryText(deliver)).toContain("````sh\necho ```danger```\n````");
  });
});
