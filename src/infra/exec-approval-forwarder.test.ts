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
  editTelegramMessage?: ReturnType<typeof vi.fn>;
  resolveSessionTarget?: () => { channel: string; to: string } | null;
  stateFilePath?: string | null;
}) {
  const deliver = params.deliver ?? vi.fn().mockResolvedValue([]);
  const editTelegramMessage =
    params.editTelegramMessage ??
    vi.fn().mockResolvedValue({ ok: true, messageId: "m1", chatId: "123" });
  const deps: NonNullable<Parameters<typeof createExecApprovalForwarder>[0]> = {
    getConfig: () => params.cfg,
    deliver: deliver as unknown as NonNullable<
      NonNullable<Parameters<typeof createExecApprovalForwarder>[0]>["deliver"]
    >,
    editTelegramMessage: editTelegramMessage as unknown as NonNullable<
      NonNullable<Parameters<typeof createExecApprovalForwarder>[0]>["editTelegramMessage"]
    >,
    nowMs: () => 1000,
  };
  if (params.resolveSessionTarget !== undefined) {
    deps.resolveSessionTarget = params.resolveSessionTarget;
  }
  deps.stateFilePath = params.stateFilePath ?? null;
  const forwarder = createExecApprovalForwarder(deps);
  return { deliver, editTelegramMessage, forwarder };
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

function getFirstDeliveryPayload(deliver: ReturnType<typeof vi.fn>) {
  const firstCall = deliver.mock.calls[0]?.[0] as
    | { payloads?: Array<Record<string, unknown>> }
    | undefined;
  return firstCall?.payloads?.[0] ?? {};
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
    const deliver = vi.fn().mockResolvedValue([
      {
        channel: "telegram",
        messageId: "tg-req-1",
        chatId: "123",
      },
    ]);
    const { editTelegramMessage, forwarder } = createForwarder({ cfg: TARGETS_CFG, deliver });

    await expect(forwarder.handleRequested(baseRequest)).resolves.toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);

    await vi.runAllTimersAsync();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(editTelegramMessage).toHaveBeenCalledWith(
      "123",
      "tg-req-1",
      expect.stringContaining("⏱️ Exec approval expired. ID: req-1"),
      expect.objectContaining({ buttons: [] }),
    );
  });

  it("adds Telegram approval buttons on request forwards", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue([]);
    const cfg = {
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "telegram", to: "123" }],
        },
      },
    } as OpenClawConfig;

    const forwarder = createExecApprovalForwarder({
      getConfig: () => cfg,
      deliver,
      nowMs: () => 1000,
      resolveSessionTarget: () => null,
      stateFilePath: null,
    });

    await forwarder.handleRequested(baseRequest);

    const payload = getFirstDeliveryPayload(deliver);
    const channelData = payload.channelData as
      | {
          telegram?: { buttons?: Array<Array<{ text?: string; callback_data?: string }>> };
        }
      | undefined;
    const buttons = channelData?.telegram?.buttons ?? [];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.[0]?.text).toBe("Allow once");
    expect(buttons[0]?.[0]?.callback_data).toBe(`/approve ${baseRequest.id} allow-once`);
    expect(buttons[1]?.[0]?.text).toBe("Deny");
    expect(buttons[1]?.[0]?.callback_data).toBe(`/approve ${baseRequest.id} deny`);
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

  it("returns false when forwarding is disabled", async () => {
    const { deliver, forwarder } = createForwarder({
      cfg: {} as OpenClawConfig,
    });
    await expect(forwarder.handleRequested(baseRequest)).resolves.toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("rejects unsafe nested-repetition regex in sessionFilter", async () => {
    const cfg = {
      approvals: {
        exec: {
          enabled: true,
          mode: "session",
          sessionFilter: ["(a+)+$"],
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
        sessionKey: `${"a".repeat(28)}!`,
      },
    };

    await expect(forwarder.handleRequested(request)).resolves.toBe(false);
    expect(deliver).not.toHaveBeenCalled();
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

  it("edits old telegram approval message on resolve and clears buttons", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue([
      {
        channel: "telegram",
        messageId: "tg-req-2",
        chatId: "123",
      },
    ]);
    const { editTelegramMessage, forwarder } = createForwarder({ cfg: TARGETS_CFG, deliver });

    await expect(forwarder.handleRequested(baseRequest)).resolves.toBe(true);
    await Promise.resolve();
    await forwarder.handleResolved({
      id: baseRequest.id,
      decision: "allow-once",
      resolvedBy: "telegram:123",
      ts: 2000,
    });

    expect(editTelegramMessage).toHaveBeenCalledWith(
      "123",
      "tg-req-2",
      expect.stringContaining("✅ Exec approval allowed once."),
      expect.objectContaining({ buttons: [] }),
    );
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("finalizes late telegram request deliveries when resolve wins the race", async () => {
    vi.useFakeTimers();
    let resolveFirstDelivery!: (value: unknown[]) => void;
    const firstDelivery = new Promise<unknown[]>((resolve) => {
      resolveFirstDelivery = resolve;
    });
    const deliver = vi
      .fn()
      .mockImplementationOnce(async () => await firstDelivery)
      .mockResolvedValueOnce([]);
    const { editTelegramMessage, forwarder } = createForwarder({ cfg: TARGETS_CFG, deliver });

    await expect(forwarder.handleRequested(baseRequest)).resolves.toBe(true);

    await forwarder.handleResolved({
      id: baseRequest.id,
      decision: "allow-once",
      resolvedBy: "telegram:123",
      ts: 2000,
    });

    expect(editTelegramMessage).not.toHaveBeenCalled();

    resolveFirstDelivery([
      {
        channel: "telegram",
        messageId: "tg-race-1",
        chatId: "123",
      },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(editTelegramMessage).toHaveBeenCalledWith(
      "123",
      "tg-race-1",
      expect.stringContaining("✅ Exec approval allowed once."),
      expect.objectContaining({ buttons: [] }),
    );
  });

  it("sends resolved follow-up when telegram request edit fails", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue([
      {
        channel: "telegram",
        messageId: "tg-req-3",
        chatId: "123",
      },
    ]);
    const editTelegramMessage = vi.fn().mockRejectedValue(new Error("edit failed"));
    const { forwarder } = createForwarder({
      cfg: TARGETS_CFG,
      deliver,
      editTelegramMessage,
    });

    await expect(forwarder.handleRequested(baseRequest)).resolves.toBe(true);
    await Promise.resolve();
    await forwarder.handleResolved({
      id: baseRequest.id,
      decision: "allow-once",
      resolvedBy: "telegram:123",
      ts: 2000,
    });

    expect(deliver).toHaveBeenCalledTimes(2);
    const resolvedPayload = (deliver.mock.calls[1]?.[0] as { payloads?: Array<{ text?: string }> })
      ?.payloads?.[0];
    expect(resolvedPayload?.text).toContain("✅ Exec approval allowed once.");
  });

  it("recovers stale pending approvals after restart and clears old telegram buttons", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-exec-approval-recover-"));
    try {
      const stateFilePath = path.join(tmpDir, "exec-approval-forwarder.json");
      fs.writeFileSync(
        stateFilePath,
        JSON.stringify(
          {
            version: 1,
            updatedAtMs: 1234,
            pending: [
              {
                request: baseRequest,
                targets: [{ channel: "telegram", to: "123", source: "target" }],
                telegramMessages: [
                  {
                    targetKey: "telegram:123::",
                    chatId: "123",
                    messageId: "tg-stale-1",
                  },
                ],
              },
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const editTelegramMessage = vi.fn().mockResolvedValue({
        ok: true,
        messageId: "tg-stale-1",
        chatId: "123",
      });
      const deliver = vi.fn().mockResolvedValue([]);
      const { forwarder } = createForwarder({
        cfg: TARGETS_CFG,
        deliver,
        editTelegramMessage,
        stateFilePath,
      });

      await forwarder.recoverPendingFromState?.();

      expect(editTelegramMessage).toHaveBeenCalledWith(
        "123",
        "tg-stale-1",
        expect.stringContaining("expired after gateway restart"),
        expect.objectContaining({ buttons: [] }),
      );
      expect(deliver).not.toHaveBeenCalled();
      const persisted = JSON.parse(fs.readFileSync(stateFilePath, "utf-8")) as {
        pending?: unknown[];
      };
      expect(Array.isArray(persisted.pending) ? persisted.pending.length : -1).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("sends restart-expired follow-up when stale telegram message cannot be edited", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-exec-approval-recover-"));
    try {
      const stateFilePath = path.join(tmpDir, "exec-approval-forwarder.json");
      fs.writeFileSync(
        stateFilePath,
        JSON.stringify(
          {
            version: 1,
            updatedAtMs: 1234,
            pending: [
              {
                request: baseRequest,
                targets: [{ channel: "telegram", to: "123", source: "target" }],
                telegramMessages: [
                  {
                    targetKey: "telegram:123::",
                    chatId: "123",
                    messageId: "tg-stale-2",
                  },
                ],
              },
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const editTelegramMessage = vi.fn().mockRejectedValue(new Error("edit failed"));
      const deliver = vi.fn().mockResolvedValue([]);
      const { forwarder } = createForwarder({
        cfg: TARGETS_CFG,
        deliver,
        editTelegramMessage,
        stateFilePath,
      });

      await forwarder.recoverPendingFromState?.();

      expect(deliver).toHaveBeenCalledTimes(1);
      const payload = (deliver.mock.calls[0]?.[0] as { payloads?: Array<{ text?: string }> })
        ?.payloads?.[0];
      expect(payload?.text).toContain("expired after gateway restart");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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
});
