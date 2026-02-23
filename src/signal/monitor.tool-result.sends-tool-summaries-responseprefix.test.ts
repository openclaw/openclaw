import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { peekSystemEvents } from "../infra/system-events.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { normalizeE164 } from "../utils.js";
import type { SignalDaemonExitEvent } from "./daemon.js";
import {
  createMockSignalDaemonHandle,
  config,
  flush,
  getSignalToolResultTestMocks,
  installSignalToolResultTestHooks,
  setSignalToolResultTestConfig,
} from "./monitor.tool-result.test-harness.js";

installSignalToolResultTestHooks();

// Import after the harness registers `vi.mock(...)` for Signal internals.
const { monitorSignalProvider } = await import("./monitor.js");

const {
  replyMock,
  sendMock,
  streamMock,
  updateLastRouteMock,
  upsertPairingRequestMock,
  waitForTransportReadyMock,
  spawnSignalDaemonMock,
} = getSignalToolResultTestMocks();

const SIGNAL_BASE_URL = "http://127.0.0.1:8080";
type MonitorSignalProviderOptions = Parameters<typeof monitorSignalProvider>[0];

function createMonitorRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: ((code: number): never => {
      throw new Error(`exit ${code}`);
    }) as (code: number) => never,
  };
}

function setSignalAutoStartConfig(overrides: Record<string, unknown> = {}) {
  setSignalToolResultTestConfig(createSignalConfig(overrides));
}

function createSignalConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = config as OpenClawConfig;
  const channels = (base.channels ?? {}) as Record<string, unknown>;
  const signal = (channels.signal ?? {}) as Record<string, unknown>;
  return {
    ...base,
    channels: {
      ...channels,
      signal: {
        ...signal,
        autoStart: true,
        dmPolicy: "open",
        allowFrom: ["*"],
        ...overrides,
      },
    },
  };
}

function createAutoAbortController() {
  const abortController = new AbortController();
  streamMock.mockImplementation(async () => {
    abortController.abort();
    return;
  });
  return abortController;
}

async function runMonitorWithMocks(opts: MonitorSignalProviderOptions) {
  return monitorSignalProvider(opts);
}

async function receiveSignalPayloads(params: {
  payloads: unknown[];
  opts?: Partial<MonitorSignalProviderOptions>;
}) {
  const abortController = new AbortController();
  streamMock.mockImplementation(async ({ onEvent }) => {
    for (const payload of params.payloads) {
      await onEvent({
        event: "receive",
        data: JSON.stringify(payload),
      });
    }
    abortController.abort();
  });

  await runMonitorWithMocks({
    autoStart: false,
    baseUrl: SIGNAL_BASE_URL,
    abortSignal: abortController.signal,
    ...params.opts,
  });

  await flush();
}

function getDirectSignalEventsFor(sender: string) {
  const route = resolveAgentRoute({
    cfg: config as OpenClawConfig,
    channel: "signal",
    accountId: "default",
    peer: { kind: "direct", id: normalizeE164(sender) },
  });
  return peekSystemEvents(route.sessionKey);
}

function makeBaseEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    sourceNumber: "+15550001111",
    sourceName: "Ada",
    timestamp: 1,
    ...overrides,
  };
}

async function receiveSingleEnvelope(
  envelope: Record<string, unknown>,
  opts?: Partial<MonitorSignalProviderOptions>,
) {
  await receiveSignalPayloads({
    payloads: [{ envelope }],
    opts,
  });
}

function expectNoReplyDeliveryOrRouteUpdate() {
  expect(replyMock).not.toHaveBeenCalled();
  expect(sendMock).not.toHaveBeenCalled();
  expect(updateLastRouteMock).not.toHaveBeenCalled();
}

function setReactionNotificationConfig(mode: "all" | "own", extra: Record<string, unknown> = {}) {
  setSignalToolResultTestConfig(
    createSignalConfig({
      autoStart: false,
      dmPolicy: "open",
      allowFrom: ["*"],
      reactionNotifications: mode,
      ...extra,
    }),
  );
}

function expectWaitForTransportReadyTimeout(timeoutMs: number) {
  expect(waitForTransportReadyMock).toHaveBeenCalledTimes(1);
  expect(waitForTransportReadyMock).toHaveBeenCalledWith(
    expect.objectContaining({
      timeoutMs,
    }),
  );
}

describe("monitorSignalProvider tool results", () => {
  it("uses bounded readiness checks when auto-starting the daemon", async () => {
    const runtime = createMonitorRuntime();
    setSignalAutoStartConfig();
    const abortController = createAutoAbortController();
    await runMonitorWithMocks({
      autoStart: true,
      baseUrl: SIGNAL_BASE_URL,
      abortSignal: abortController.signal,
      runtime,
    });

    expect(waitForTransportReadyMock).toHaveBeenCalledTimes(1);
    expect(waitForTransportReadyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "signal daemon",
        timeoutMs: 30_000,
        logAfterMs: 10_000,
        logIntervalMs: 10_000,
        pollIntervalMs: 150,
        runtime,
        abortSignal: expect.any(AbortSignal),
      }),
    );
  });

  it("uses startupTimeoutMs override when provided", async () => {
    const runtime = createMonitorRuntime();
    setSignalAutoStartConfig({ startupTimeoutMs: 60_000 });
    const abortController = createAutoAbortController();

    await runMonitorWithMocks({
      autoStart: true,
      baseUrl: SIGNAL_BASE_URL,
      abortSignal: abortController.signal,
      runtime,
      startupTimeoutMs: 90_000,
    });

    expectWaitForTransportReadyTimeout(90_000);
  });

  it("caps startupTimeoutMs at 2 minutes", async () => {
    const runtime = createMonitorRuntime();
    setSignalAutoStartConfig({ startupTimeoutMs: 180_000 });
    const abortController = createAutoAbortController();

    await runMonitorWithMocks({
      autoStart: true,
      baseUrl: SIGNAL_BASE_URL,
      abortSignal: abortController.signal,
      runtime,
    });

    expectWaitForTransportReadyTimeout(120_000);
  });

  it("fails fast when auto-started signal daemon exits during startup", async () => {
    const runtime = createMonitorRuntime();
    setSignalAutoStartConfig();
    spawnSignalDaemonMock.mockReturnValueOnce(
      createMockSignalDaemonHandle({
        exited: Promise.resolve({ source: "process", code: 1, signal: null }),
        isExited: () => true,
      }),
    );
    waitForTransportReadyMock.mockImplementationOnce(
      async (params: { abortSignal?: AbortSignal | null }) => {
        await new Promise<void>((_resolve, reject) => {
          if (params.abortSignal?.aborted) {
            reject(params.abortSignal.reason);
            return;
          }
          params.abortSignal?.addEventListener(
            "abort",
            () => reject(params.abortSignal?.reason ?? new Error("aborted")),
            { once: true },
          );
        });
      },
    );

    await expect(
      runMonitorWithMocks({
        autoStart: true,
        baseUrl: SIGNAL_BASE_URL,
        runtime,
      }),
    ).rejects.toThrow(/signal daemon exited/i);
  });

  it("treats daemon exit after user abort as clean shutdown", async () => {
    const runtime = createMonitorRuntime();
    setSignalAutoStartConfig();
    const abortController = new AbortController();
    let exited = false;
    let resolveExit!: (value: SignalDaemonExitEvent) => void;
    const exitedPromise = new Promise<SignalDaemonExitEvent>((resolve) => {
      resolveExit = resolve;
    });
    const stop = vi.fn(() => {
      if (exited) {
        return;
      }
      exited = true;
      resolveExit({ source: "process", code: null, signal: "SIGTERM" });
    });
    spawnSignalDaemonMock.mockReturnValueOnce(
      createMockSignalDaemonHandle({
        stop,
        exited: exitedPromise,
        isExited: () => exited,
      }),
    );
    streamMock.mockImplementationOnce(async () => {
      abortController.abort(new Error("stop"));
    });

    await expect(
      runMonitorWithMocks({
        autoStart: true,
        baseUrl: SIGNAL_BASE_URL,
        runtime,
        abortSignal: abortController.signal,
      }),
    ).resolves.toBeUndefined();
  });

  it("skips tool summaries with responsePrefix", async () => {
    replyMock.mockResolvedValue({ text: "final reply" });

    await receiveSignalPayloads({
      payloads: [
        {
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Ada",
            timestamp: 1,
            dataMessage: {
              message: "hello",
            },
          },
        },
      ],
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][1]).toBe("PFX final reply");
  });

  it("replies with pairing code when dmPolicy is pairing and no allowFrom is set", async () => {
    setSignalToolResultTestConfig(
      createSignalConfig({ autoStart: false, dmPolicy: "pairing", allowFrom: [] }),
    );
    await receiveSignalPayloads({
      payloads: [
        {
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Ada",
            timestamp: 1,
            dataMessage: {
              message: "hello",
            },
          },
        },
      ],
    });

    expect(replyMock).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(String(sendMock.mock.calls[0]?.[1] ?? "")).toContain("Your Signal number: +15550001111");
    expect(String(sendMock.mock.calls[0]?.[1] ?? "")).toContain("Pairing code: PAIRCODE");
  });

  it("ignores reaction-only messages", async () => {
    await receiveSingleEnvelope({
      ...makeBaseEnvelope(),
      reactionMessage: {
        emoji: "👍",
        targetAuthor: "+15550002222",
        targetSentTimestamp: 2,
      },
    });

    expectNoReplyDeliveryOrRouteUpdate();
  });

  it("ignores reaction-only dataMessage.reaction events (don’t treat as broken attachments)", async () => {
    await receiveSingleEnvelope({
      ...makeBaseEnvelope(),
      dataMessage: {
        reaction: {
          emoji: "👍",
          targetAuthor: "+15550002222",
          targetSentTimestamp: 2,
        },
        attachments: [{}],
      },
    });

    expectNoReplyDeliveryOrRouteUpdate();
  });

  it("enqueues system events for reaction notifications", async () => {
    setReactionNotificationConfig("all");
    await receiveSingleEnvelope({
      ...makeBaseEnvelope(),
      reactionMessage: {
        emoji: "✅",
        targetAuthor: "+15550002222",
        targetSentTimestamp: 2,
      },
    });

    const events = getDirectSignalEventsFor("+15550001111");
    expect(events.some((text) => text.includes("Signal reaction added"))).toBe(true);
  });

  it("notifies on own reactions when target includes uuid + phone", async () => {
    setReactionNotificationConfig("own", { account: "+15550002222" });
    await receiveSingleEnvelope({
      ...makeBaseEnvelope(),
      reactionMessage: {
        emoji: "✅",
        targetAuthor: "+15550002222",
        targetAuthorUuid: "123e4567-e89b-12d3-a456-426614174000",
        targetSentTimestamp: 2,
      },
    });

    const events = getDirectSignalEventsFor("+15550001111");
    expect(events.some((text) => text.includes("Signal reaction added"))).toBe(true);
  });

  it("processes messages when reaction metadata is present", async () => {
    replyMock.mockResolvedValue({ text: "pong" });

    await receiveSignalPayloads({
      payloads: [
        {
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Ada",
            timestamp: 1,
            reactionMessage: {
              emoji: "👍",
              targetAuthor: "+15550002222",
              targetSentTimestamp: 2,
            },
            dataMessage: {
              message: "ping",
            },
          },
        },
      ],
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(updateLastRouteMock).toHaveBeenCalled();
  });

  it("does not resend pairing code when a request is already pending", async () => {
    setSignalToolResultTestConfig(
      createSignalConfig({ autoStart: false, dmPolicy: "pairing", allowFrom: [] }),
    );
    upsertPairingRequestMock
      .mockResolvedValueOnce({ code: "PAIRCODE", created: true })
      .mockResolvedValueOnce({ code: "PAIRCODE", created: false });

    const payload = {
      envelope: {
        sourceNumber: "+15550001111",
        sourceName: "Ada",
        timestamp: 1,
        dataMessage: {
          message: "hello",
        },
      },
    };
    await receiveSignalPayloads({
      payloads: [
        payload,
        {
          ...payload,
          envelope: { ...payload.envelope, timestamp: 2 },
        },
      ],
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
