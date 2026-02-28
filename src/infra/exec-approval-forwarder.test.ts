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

type DeliveryPayload = { text?: string; channelData?: Record<string, unknown> };

function getFirstDelivery(deliver: ReturnType<typeof vi.fn>): {
  params: { payloads?: DeliveryPayload[] } | undefined;
  payload: DeliveryPayload | undefined;
} {
  const params = deliver.mock.calls[0]?.[0] as { payloads?: DeliveryPayload[] } | undefined;
  return { params, payload: params?.payloads?.[0] };
}

function getFirstDeliveryText(deliver: ReturnType<typeof vi.fn>): string {
  return getFirstDelivery(deliver).payload?.text ?? "";
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

    expect(getFirstDeliveryText(deliver)).toContain("Command:\n````\necho ```danger```\n````");
  });

  it("attaches three inline approval buttons to the request message", async () => {
    vi.useFakeTimers();
    const { deliver, forwarder } = createForwarder({ cfg: TARGETS_CFG });

    await expect(forwarder.handleRequested(baseRequest)).resolves.toBe(true);

    const { payload } = getFirstDelivery(deliver);
    const buttons = (payload?.channelData?.telegram as { buttons?: unknown[] } | undefined)
      ?.buttons;
    expect(Array.isArray(buttons)).toBe(true);
    const row = buttons?.[0] as Array<{ text: string; callback_data: string }> | undefined;
    expect(row).toHaveLength(3);
    expect(row?.[0]).toMatchObject({
      text: "Allow once",
      callback_data: `/approve ${baseRequest.id} allow-once`,
    });
    expect(row?.[1]).toMatchObject({
      text: "Always allow",
      callback_data: `/approve ${baseRequest.id} allow-always`,
    });
    expect(row?.[2]).toMatchObject({
      text: "Deny",
      callback_data: `/approve ${baseRequest.id} deny`,
    });
  });

  it("keeps all callback_data values within the 64-byte Telegram limit", async () => {
    vi.useFakeTimers();
    const longId = "a".repeat(36); // typical UUID length
    const request = { ...baseRequest, id: longId };
    const { deliver, forwarder } = createForwarder({ cfg: TARGETS_CFG });

    await expect(forwarder.handleRequested(request)).resolves.toBe(true);

    const { payload } = getFirstDelivery(deliver);
    const row = (payload?.channelData?.telegram as { buttons?: unknown[] } | undefined)
      ?.buttons?.[0] as Array<{ callback_data: string }> | undefined;
    expect(row).toBeDefined();
    for (const btn of row ?? []) {
      const bytes = Buffer.byteLength(btn.callback_data, "utf8");
      expect(bytes).toBeLessThanOrEqual(64);
    }
  });

  it("still attaches buttons when ID produces exactly 64-byte callback_data", async () => {
    vi.useFakeTimers();
    // "/approve " (9) + 42 chars + " allow-always" (13) = 64 bytes exactly
    const exactId = "a".repeat(42);
    const request = { ...baseRequest, id: exactId };
    const { deliver, forwarder } = createForwarder({ cfg: TARGETS_CFG });

    await expect(forwarder.handleRequested(request)).resolves.toBe(true);

    const { payload } = getFirstDelivery(deliver);
    const buttons = (payload?.channelData?.telegram as { buttons?: unknown[] } | undefined)
      ?.buttons;
    expect(buttons).toBeDefined();
    expect(Array.isArray(buttons)).toBe(true);
    expect(buttons).toHaveLength(1);
  });

  it("does not attach buttons to resolved messages", async () => {
    vi.useFakeTimers();
    const { deliver, forwarder } = createForwarder({ cfg: TARGETS_CFG });

    await forwarder.handleRequested(baseRequest);
    deliver.mockClear();

    await forwarder.handleResolved({
      id: baseRequest.id,
      decision: "allow-once",
      resolvedBy: "telegram:123",
      ts: 2000,
    });

    const { payload } = getFirstDelivery(deliver);
    expect(payload?.channelData).toBeUndefined();
  });

  it("does not attach buttons to expired messages", async () => {
    vi.useFakeTimers();
    const { deliver, forwarder } = createForwarder({ cfg: TARGETS_CFG });

    await forwarder.handleRequested(baseRequest);
    deliver.mockClear();

    await vi.runAllTimersAsync();

    const { payload } = getFirstDelivery(deliver);
    expect(payload?.channelData).toBeUndefined();
  });

  it("does not attach channelData to non-Telegram targets", async () => {
    vi.useFakeTimers();
    const cfg = {
      approvals: {
        exec: { enabled: true, mode: "targets", targets: [{ channel: "slack", to: "U1" }] },
      },
    } as OpenClawConfig;
    const { deliver, forwarder } = createForwarder({ cfg });

    await expect(forwarder.handleRequested(baseRequest)).resolves.toBe(true);

    const { payload } = getFirstDelivery(deliver);
    expect(payload?.channelData).toBeUndefined();
  });

  it("includes all optional request fields in message text", async () => {
    vi.useFakeTimers();
    const { deliver, forwarder } = createForwarder({ cfg: TARGETS_CFG });

    await expect(
      forwarder.handleRequested({
        ...baseRequest,
        request: {
          ...baseRequest.request,
          cwd: "/workspace",
          nodeId: "node-42",
          envKeys: ["FOO", "BAR"],
          host: "myhost",
          agentId: "agent-x",
          security: "high",
          ask: "Are you sure?",
        },
      }),
    ).resolves.toBe(true);

    const text = getFirstDeliveryText(deliver);
    expect(text).toContain("CWD: /workspace");
    expect(text).toContain("Node: node-42");
    expect(text).toContain("Env overrides: FOO, BAR");
    expect(text).toContain("Host: myhost");
    expect(text).toContain("Agent: agent-x");
    expect(text).toContain("Security: high");
    expect(text).toContain("Ask: Are you sure?");
  });

  it("falls back to no buttons when approval ID exceeds 64-byte callback_data limit", async () => {
    vi.useFakeTimers();
    // /approve <id> allow-always = 9 + id.length + 13 bytes; id > 42 chars pushes it over 64
    const oversizedId = "x".repeat(43);
    const request = { ...baseRequest, id: oversizedId };
    const { deliver, forwarder } = createForwarder({ cfg: TARGETS_CFG });

    await expect(forwarder.handleRequested(request)).resolves.toBe(true);

    const { payload } = getFirstDelivery(deliver);
    // Text fallback still present; buttons absent
    expect(payload?.text).toContain("Reply with: /approve");
    expect(payload?.channelData).toBeUndefined();
  });
});
