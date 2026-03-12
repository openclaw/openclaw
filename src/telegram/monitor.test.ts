import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { monitorTelegramProvider } from "./monitor.js";

type MockCtx = {
  message: {
    message_id?: number;
    chat: { id: number; type: string; title?: string };
    text?: string;
    caption?: string;
  };
  me?: { username: string };
  getFile: () => Promise<unknown>;
};

// Fake bot to capture handler and API calls
const handlers: Record<string, (ctx: MockCtx) => Promise<void> | void> = {};
const api = {
  sendMessage: vi.fn(),
  sendPhoto: vi.fn(),
  sendVideo: vi.fn(),
  sendAudio: vi.fn(),
  sendDocument: vi.fn(),
  setWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
  getUpdates: vi.fn(async () => []),
  config: {
    use: vi.fn(),
  },
};
const { initSpy, runSpy, loadConfig } = vi.hoisted(() => ({
  initSpy: vi.fn(async () => undefined),
  runSpy: vi.fn(() => ({
    task: () => Promise.resolve(),
    stop: vi.fn(),
    isRunning: (): boolean => false,
  })),
  loadConfig: vi.fn(() => ({
    agents: { defaults: { maxConcurrent: 2 } },
    channels: { telegram: {} },
  })),
}));

const { registerUnhandledRejectionHandlerMock, emitUnhandledRejection, resetUnhandledRejection } =
  vi.hoisted(() => {
    let handler: ((reason: unknown) => boolean) | undefined;
    return {
      registerUnhandledRejectionHandlerMock: vi.fn((next: (reason: unknown) => boolean) => {
        handler = next;
        return () => {
          if (handler === next) {
            handler = undefined;
          }
        };
      }),
      emitUnhandledRejection: (reason: unknown) => handler?.(reason) ?? false,
      resetUnhandledRejection: () => {
        handler = undefined;
      },
    };
  });

const { createTelegramBotErrors } = vi.hoisted(() => ({
  createTelegramBotErrors: [] as unknown[],
}));

const { createTelegramBotCalls } = vi.hoisted(() => ({
  createTelegramBotCalls: [] as Array<Record<string, unknown>>,
}));

const { createdBotStops } = vi.hoisted(() => ({
  createdBotStops: [] as Array<ReturnType<typeof vi.fn<() => void>>>,
}));

const { computeBackoff, sleepWithAbort } = vi.hoisted(() => ({
  computeBackoff: vi.fn(() => 0),
  sleepWithAbort: vi.fn(async () => undefined),
}));
const { readTelegramUpdateOffsetSpy } = vi.hoisted(() => ({
  readTelegramUpdateOffsetSpy: vi.fn(async () => null as number | null),
}));
const { startTelegramWebhookSpy } = vi.hoisted(() => ({
  startTelegramWebhookSpy: vi.fn(async () => ({ server: { close: vi.fn() }, stop: vi.fn() })),
}));

type RunnerStub = {
  task: () => Promise<void>;
  stop: ReturnType<typeof vi.fn<() => void | Promise<void>>>;
  isRunning: () => boolean;
};

const makeRunnerStub = (overrides: Partial<RunnerStub> = {}): RunnerStub => ({
  task: overrides.task ?? (() => Promise.resolve()),
  stop: overrides.stop ?? vi.fn<() => void | Promise<void>>(),
  isRunning: overrides.isRunning ?? (() => false),
});

function makeRecoverableFetchError() {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("connect timeout"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    }),
  });
}

const createAbortTask = (
  abort: AbortController,
  beforeAbort?: () => void,
): (() => Promise<void>) => {
  return async () => {
    beforeAbort?.();
    abort.abort();
  };
};

const makeAbortRunner = (abort: AbortController, beforeAbort?: () => void): RunnerStub =>
  makeRunnerStub({ task: createAbortTask(abort, beforeAbort) });

function mockRunOnceAndAbort(abort: AbortController) {
  runSpy.mockImplementationOnce(() => makeAbortRunner(abort));
}

function expectRecoverableRetryState(expectedRunCalls: number) {
  expect(computeBackoff).toHaveBeenCalled();
  expect(sleepWithAbort).toHaveBeenCalled();
  expect(runSpy).toHaveBeenCalledTimes(expectedRunCalls);
}

async function monitorWithAutoAbort(
  opts: Omit<Parameters<typeof monitorTelegramProvider>[0], "abortSignal"> = {},
) {
  const abort = new AbortController();
  mockRunOnceAndAbort(abort);
  await monitorTelegramProvider({
    token: "tok",
    ...opts,
    abortSignal: abort.signal,
  });
}

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig,
  };
});

vi.mock("./bot.js", () => ({
  createTelegramBot: (opts: Record<string, unknown>) => {
    createTelegramBotCalls.push(opts);
    const nextError = createTelegramBotErrors.shift();
    if (nextError) {
      throw nextError;
    }
    const stop = vi.fn<() => void>();
    createdBotStops.push(stop);
    handlers.message = async (ctx: MockCtx) => {
      const chatId = ctx.message.chat.id;
      const isGroup = ctx.message.chat.type !== "private";
      const text = ctx.message.text ?? ctx.message.caption ?? "";
      if (isGroup && !text.includes("@mybot")) {
        return;
      }
      if (!text.trim()) {
        return;
      }
      await api.sendMessage(chatId, `echo:${text}`, { parse_mode: "HTML" });
    };
    return {
      on: vi.fn(),
      api,
      me: { username: "mybot" },
      init: initSpy,
      stop,
      start: vi.fn(),
    };
  },
}));

// Mock the grammyjs/runner to resolve immediately
vi.mock("@grammyjs/runner", () => ({
  run: runSpy,
}));

vi.mock("../infra/backoff.js", () => ({
  computeBackoff,
  sleepWithAbort,
}));

vi.mock("../infra/unhandled-rejections.js", () => ({
  registerUnhandledRejectionHandler: registerUnhandledRejectionHandlerMock,
}));

vi.mock("./webhook.js", () => ({
  startTelegramWebhook: startTelegramWebhookSpy,
}));

vi.mock("./update-offset-store.js", () => ({
  readTelegramUpdateOffset: readTelegramUpdateOffsetSpy,
  writeTelegramUpdateOffset: vi.fn(async () => undefined),
}));

vi.mock("../auto-reply/reply.js", () => ({
  getReplyFromConfig: async (ctx: { Body?: string }) => ({
    text: `echo:${ctx.Body}`,
  }),
}));

describe("monitorTelegramProvider (grammY)", () => {
  let consoleErrorSpy: { mockRestore: () => void } | undefined;

  beforeEach(() => {
    loadConfig.mockReturnValue({
      agents: { defaults: { maxConcurrent: 2 } },
      channels: { telegram: {} },
    });
    initSpy.mockClear();
    readTelegramUpdateOffsetSpy.mockReset().mockResolvedValue(null);
    api.getUpdates.mockReset().mockResolvedValue([]);
    runSpy.mockReset().mockImplementation(() =>
      makeRunnerStub({
        task: () => Promise.reject(new Error("runSpy called without explicit test stub")),
      }),
    );
    createTelegramBotCalls.length = 0;
    computeBackoff.mockClear();
    sleepWithAbort.mockClear();
    startTelegramWebhookSpy.mockClear();
    registerUnhandledRejectionHandlerMock.mockClear();
    resetUnhandledRejection();
    createTelegramBotErrors.length = 0;
    createdBotStops.length = 0;
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy?.mockRestore();
  });

  it("processes a DM and sends reply", async () => {
    for (const v of Object.values(api)) {
      if (typeof v === "function" && "mockReset" in v) {
        (v as ReturnType<typeof vi.fn>).mockReset();
      }
    }
    await monitorWithAutoAbort();
    expect(handlers.message).toBeDefined();
    await handlers.message?.({
      message: {
        message_id: 1,
        chat: { id: 123, type: "private" },
        text: "hi",
      },
      me: { username: "mybot" },
      getFile: vi.fn(async () => ({})),
    });
    expect(api.sendMessage).toHaveBeenCalledWith(123, "echo:hi", {
      parse_mode: "HTML",
    });
  });

  it("uses agent maxConcurrent for runner concurrency", async () => {
    runSpy.mockClear();
    loadConfig.mockReturnValue({
      agents: { defaults: { maxConcurrent: 3 } },
      channels: { telegram: {} },
    });

    await monitorWithAutoAbort();

    expect(runSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sink: { concurrency: 3 },
        runner: expect.objectContaining({
          silent: true,
          maxRetryTime: 60 * 60 * 1000,
          retryInterval: "exponential",
        }),
      }),
    );
  });

  it("requires mention in groups by default", async () => {
    for (const v of Object.values(api)) {
      if (typeof v === "function" && "mockReset" in v) {
        (v as ReturnType<typeof vi.fn>).mockReset();
      }
    }
    await monitorWithAutoAbort();
    await handlers.message?.({
      message: {
        message_id: 2,
        chat: { id: -99, type: "supergroup", title: "G" },
        text: "hello all",
      },
      me: { username: "mybot" },
      getFile: vi.fn(async () => ({})),
    });
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("retries on recoverable undici fetch errors", async () => {
    const abort = new AbortController();
    const networkError = makeRecoverableFetchError();
    runSpy
      .mockImplementationOnce(() =>
        makeRunnerStub({
          task: () => Promise.reject(networkError),
        }),
      )
      .mockImplementationOnce(() => makeAbortRunner(abort));

    await monitorTelegramProvider({ token: "tok", abortSignal: abort.signal });

    expectRecoverableRetryState(2);
  });

  it("deletes webhook before starting polling", async () => {
    const abort = new AbortController();
    const order: string[] = [];
    api.deleteWebhook.mockReset();
    api.deleteWebhook.mockImplementationOnce(async () => {
      order.push("deleteWebhook");
      return true;
    });
    runSpy.mockImplementationOnce(() => {
      order.push("run");
      return makeAbortRunner(abort);
    });

    await monitorTelegramProvider({ token: "tok", abortSignal: abort.signal });

    expect(api.deleteWebhook).toHaveBeenCalledWith({ drop_pending_updates: false });
    expect(order).toEqual(["deleteWebhook", "run"]);
  });

  it("retries recoverable deleteWebhook failures before polling", async () => {
    const abort = new AbortController();
    const cleanupError = makeRecoverableFetchError();
    api.deleteWebhook.mockReset();
    api.deleteWebhook.mockRejectedValueOnce(cleanupError).mockResolvedValueOnce(true);
    mockRunOnceAndAbort(abort);

    await monitorTelegramProvider({ token: "tok", abortSignal: abort.signal });

    expect(api.deleteWebhook).toHaveBeenCalledTimes(2);
    expectRecoverableRetryState(1);
  });

  it("retries setup-time recoverable errors before starting polling", async () => {
    const abort = new AbortController();
    const setupError = makeRecoverableFetchError();
    createTelegramBotErrors.push(setupError);
    mockRunOnceAndAbort(abort);

    await monitorTelegramProvider({ token: "tok", abortSignal: abort.signal });

    expect(computeBackoff).toHaveBeenCalled();
    expect(sleepWithAbort).toHaveBeenCalled();
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it("awaits runner.stop before retrying after recoverable polling error", async () => {
    const abort = new AbortController();
    const recoverableError = makeRecoverableFetchError();
    let firstStopped = false;
    const firstStop = vi.fn(async () => {
      await Promise.resolve();
      firstStopped = true;
    });

    runSpy
      .mockImplementationOnce(() =>
        makeRunnerStub({
          task: () => Promise.reject(recoverableError),
          stop: firstStop,
        }),
      )
      .mockImplementationOnce(() => {
        expect(firstStopped).toBe(true);
        return makeAbortRunner(abort);
      });

    await monitorTelegramProvider({ token: "tok", abortSignal: abort.signal });

    expect(firstStop).toHaveBeenCalled();
    expectRecoverableRetryState(2);
  });

  it("stops bot instance when polling cycle exits", async () => {
    const abort = new AbortController();
    mockRunOnceAndAbort(abort);

    await monitorTelegramProvider({ token: "tok", abortSignal: abort.signal });

    expect(createdBotStops.length).toBe(1);
    expect(createdBotStops[0]).toHaveBeenCalledTimes(1);
  });

  it("clears bounded cleanup timers after a clean stop", async () => {
    vi.useFakeTimers();
    try {
      const abort = new AbortController();
      mockRunOnceAndAbort(abort);

      await monitorTelegramProvider({ token: "tok", abortSignal: abort.signal });

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces non-recoverable errors", async () => {
    runSpy.mockImplementationOnce(() =>
      makeRunnerStub({
        task: () => Promise.reject(new Error("bad token")),
      }),
    );

    await expect(monitorTelegramProvider({ token: "tok" })).rejects.toThrow("bad token");
  });

  it("force-restarts polling when unhandled network rejection stalls runner", async () => {
    const abort = new AbortController();
    let running = true;
    let releaseTask: (() => void) | undefined;
    const stop = vi.fn(async () => {
      running = false;
      releaseTask?.();
    });

    runSpy
      .mockImplementationOnce(() =>
        makeRunnerStub({
          task: () =>
            new Promise<void>((resolve) => {
              releaseTask = resolve;
            }),
          stop,
          isRunning: () => running,
        }),
      )
      .mockImplementationOnce(() =>
        makeRunnerStub({
          task: async () => {
            abort.abort();
          },
        }),
      );

    const monitor = monitorTelegramProvider({ token: "tok", abortSignal: abort.signal });
    await vi.waitFor(() => expect(runSpy).toHaveBeenCalledTimes(1));

    expect(emitUnhandledRejection(new TypeError("fetch failed"))).toBe(true);
    await monitor;

    expect(stop.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(computeBackoff).toHaveBeenCalled();
    expect(sleepWithAbort).toHaveBeenCalled();
    expect(runSpy).toHaveBeenCalledTimes(2);
  });

  it("aborts the active Telegram fetch when unhandled network rejection forces restart", async () => {
    const abort = new AbortController();
    let running = true;
    let releaseTask: (() => void) | undefined;
    const stop = vi.fn(async () => {
      running = false;
      releaseTask?.();
    });

    runSpy
      .mockImplementationOnce(() =>
        makeRunnerStub({
          task: () =>
            new Promise<void>((resolve) => {
              releaseTask = resolve;
            }),
          stop,
          isRunning: () => running,
        }),
      )
      .mockImplementationOnce(() =>
        makeRunnerStub({
          task: async () => {
            abort.abort();
          },
        }),
      );

    const monitor = monitorTelegramProvider({ token: "tok", abortSignal: abort.signal });
    await vi.waitFor(() => expect(createTelegramBotCalls.length).toBeGreaterThanOrEqual(1));
    const firstSignal = createTelegramBotCalls[0]?.fetchAbortSignal;
    expect(firstSignal).toBeInstanceOf(AbortSignal);
    expect((firstSignal as AbortSignal).aborted).toBe(false);

    expect(emitUnhandledRejection(new TypeError("fetch failed"))).toBe(true);
    await monitor;

    expect((firstSignal as AbortSignal).aborted).toBe(true);
    expect(stop).toHaveBeenCalled();
  });

  it("passes configured webhookHost to webhook listener", async () => {
    await monitorTelegramProvider({
      token: "tok",
      useWebhook: true,
      webhookUrl: "https://example.test/telegram",
      webhookSecret: "secret",
      config: {
        agents: { defaults: { maxConcurrent: 2 } },
        channels: {
          telegram: {
            webhookHost: "0.0.0.0",
          },
        },
      },
    });

    expect(startTelegramWebhookSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "0.0.0.0",
      }),
    );
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("webhook mode waits for abort signal before returning", async () => {
    const abort = new AbortController();
    const settled = vi.fn();
    const monitor = monitorTelegramProvider({
      token: "tok",
      useWebhook: true,
      webhookUrl: "https://example.test/telegram",
      webhookSecret: "secret",
      abortSignal: abort.signal,
    }).then(settled);

    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    abort.abort();
    await monitor;
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("force-restarts polling when getUpdates stalls (watchdog)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const abort = new AbortController();
    let running = true;
    let releaseTask: (() => void) | undefined;
    const stop = vi.fn(async () => {
      running = false;
      releaseTask?.();
    });

    runSpy
      .mockImplementationOnce(() =>
        makeRunnerStub({
          task: () =>
            new Promise<void>((resolve) => {
              releaseTask = resolve;
            }),
          stop,
          isRunning: () => running,
        }),
      )
      .mockImplementationOnce(() =>
        makeRunnerStub({
          task: async () => {
            abort.abort();
          },
        }),
      );

    const monitor = monitorTelegramProvider({ token: "tok", abortSignal: abort.signal });
    await vi.waitFor(() => expect(runSpy).toHaveBeenCalledTimes(1));

    // Advance time past the stall threshold (90s) + watchdog interval (30s)
    vi.advanceTimersByTime(120_000);
    await monitor;

    expect(stop.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(computeBackoff).toHaveBeenCalled();
    expect(runSpy).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("confirms persisted offset with Telegram before starting runner", async () => {
    readTelegramUpdateOffsetSpy.mockResolvedValueOnce(549076203);
    const abort = new AbortController();
    const order: string[] = [];
    api.getUpdates.mockReset();
    api.getUpdates.mockImplementationOnce(async () => {
      order.push("getUpdates");
      return [];
    });
    api.deleteWebhook.mockReset();
    api.deleteWebhook.mockImplementationOnce(async () => {
      order.push("deleteWebhook");
      return true;
    });
    runSpy.mockImplementationOnce(() => {
      order.push("run");
      return makeAbortRunner(abort);
    });

    await monitorTelegramProvider({ token: "tok", abortSignal: abort.signal });

    expect(api.getUpdates).toHaveBeenCalledWith({ offset: 549076204, limit: 1, timeout: 0 });
    expect(order).toEqual(["deleteWebhook", "getUpdates", "run"]);
  });

  it("skips offset confirmation when no persisted offset exists", async () => {
    readTelegramUpdateOffsetSpy.mockResolvedValueOnce(null);
    const abort = new AbortController();
    api.getUpdates.mockReset();
    api.deleteWebhook.mockReset();
    api.deleteWebhook.mockResolvedValueOnce(true);
    mockRunOnceAndAbort(abort);

    await monitorTelegramProvider({ token: "tok", abortSignal: abort.signal });

    expect(api.getUpdates).not.toHaveBeenCalled();
  });

  it("skips offset confirmation when persisted offset is invalid", async () => {
    readTelegramUpdateOffsetSpy.mockResolvedValueOnce(-1 as number);
    const abort = new AbortController();
    api.getUpdates.mockReset();
    api.deleteWebhook.mockReset();
    api.deleteWebhook.mockResolvedValueOnce(true);
    mockRunOnceAndAbort(abort);

    await monitorTelegramProvider({ token: "tok", abortSignal: abort.signal });

    expect(api.getUpdates).not.toHaveBeenCalled();
  });

  it("skips offset confirmation when persisted offset cannot be safely incremented", async () => {
    readTelegramUpdateOffsetSpy.mockResolvedValueOnce(Number.MAX_SAFE_INTEGER);
    const abort = new AbortController();
    api.getUpdates.mockReset();
    api.deleteWebhook.mockReset();
    api.deleteWebhook.mockResolvedValueOnce(true);
    mockRunOnceAndAbort(abort);

    await monitorTelegramProvider({ token: "tok", abortSignal: abort.signal });

    expect(api.getUpdates).not.toHaveBeenCalled();
  });

  it("resets webhookCleared latch on 409 conflict so deleteWebhook re-runs", async () => {
    const abort = new AbortController();
    api.deleteWebhook.mockReset();
    api.deleteWebhook.mockResolvedValue(true);

    const conflictError = Object.assign(
      new Error("Conflict: terminated by other getUpdates request"),
      {
        error_code: 409,
        method: "getUpdates",
      },
    );

    let pollingCycle = 0;
    runSpy
      // First cycle: throw 409 conflict
      .mockImplementationOnce(() =>
        makeRunnerStub({
          task: () => {
            pollingCycle++;
            return Promise.reject(conflictError);
          },
        }),
      )
      // Second cycle: succeed then abort
      .mockImplementationOnce(() => {
        pollingCycle++;
        return makeAbortRunner(abort);
      });

    await monitorTelegramProvider({ token: "tok", abortSignal: abort.signal });

    // deleteWebhook should be called twice: once on initial cleanup, once after 409 reset
    expect(api.deleteWebhook).toHaveBeenCalledTimes(2);
    expect(pollingCycle).toBe(2);
    expect(runSpy).toHaveBeenCalledTimes(2);
  });

  it("falls back to configured webhookSecret when not passed explicitly", async () => {
    await monitorTelegramProvider({
      token: "tok",
      useWebhook: true,
      webhookUrl: "https://example.test/telegram",
      config: {
        agents: { defaults: { maxConcurrent: 2 } },
        channels: {
          telegram: {
            webhookSecret: "secret-from-config",
          },
        },
      },
    });

    expect(startTelegramWebhookSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        secret: "secret-from-config",
      }),
    );
    expect(runSpy).not.toHaveBeenCalled();
  });
});
