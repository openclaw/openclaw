import { beforeEach, describe, expect, it, vi } from "vitest";
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

const { computeBackoff, sleepWithAbort } = vi.hoisted(() => ({
  computeBackoff: vi.fn(() => 0),
  sleepWithAbort: vi.fn(async () => undefined),
}));
const { startTelegramWebhookSpy } = vi.hoisted(() => ({
  startTelegramWebhookSpy: vi.fn(async () => ({ server: { close: vi.fn() }, stop: vi.fn() })),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig,
  };
});

vi.mock("./bot.js", () => ({
  createTelegramBot: () => {
    const nextError = createTelegramBotErrors.shift();
    if (nextError) {
      throw nextError;
    }
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
      stop: vi.fn(),
      start: vi.fn(),
    };
  },
  createTelegramWebhookCallback: vi.fn(),
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

vi.mock("../auto-reply/reply.js", () => ({
  getReplyFromConfig: async (ctx: { Body?: string }) => ({
    text: `echo:${ctx.Body}`,
  }),
}));

describe("monitorTelegramProvider (grammY)", () => {
  beforeEach(() => {
    loadConfig.mockReturnValue({
      agents: { defaults: { maxConcurrent: 2 } },
      channels: { telegram: {} },
    });
    initSpy.mockClear();
    runSpy.mockClear();
    computeBackoff.mockClear();
    sleepWithAbort.mockClear();
    startTelegramWebhookSpy.mockClear();
    registerUnhandledRejectionHandlerMock.mockClear();
    resetUnhandledRejection();
    createTelegramBotErrors.length = 0;
  });

  it("processes a DM and sends reply", async () => {
    Object.values(api).forEach((fn) => {
      fn?.mockReset?.();
    });
    await monitorTelegramProvider({ token: "tok" });
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

    await monitorTelegramProvider({ token: "tok" });

    expect(runSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sink: { concurrency: 3 },
        runner: expect.objectContaining({
          silent: true,
          maxRetryTime: 5 * 60 * 1000,
          retryInterval: "exponential",
        }),
      }),
    );
  });

  it("requires mention in groups by default", async () => {
    Object.values(api).forEach((fn) => {
      fn?.mockReset?.();
    });
    await monitorTelegramProvider({ token: "tok" });
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
    const networkError = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect timeout"), {
        code: "UND_ERR_CONNECT_TIMEOUT",
      }),
    });
    runSpy
      .mockImplementationOnce(() => ({
        task: () => Promise.reject(networkError),
        stop: vi.fn(),
        isRunning: (): boolean => false,
      }))
      .mockImplementationOnce(() => ({
        task: () => Promise.resolve(),
        stop: vi.fn(),
        isRunning: (): boolean => false,
      }));

    await monitorTelegramProvider({ token: "tok" });

    expect(computeBackoff).toHaveBeenCalled();
    expect(sleepWithAbort).toHaveBeenCalled();
    expect(runSpy).toHaveBeenCalledTimes(2);
  });

  it("deletes webhook before starting polling", async () => {
    const order: string[] = [];
    api.deleteWebhook.mockReset();
    api.deleteWebhook.mockImplementationOnce(async () => {
      order.push("deleteWebhook");
      return true;
    });
    runSpy.mockImplementationOnce(() => {
      order.push("run");
      return {
        task: () => Promise.resolve(),
        stop: vi.fn(),
        isRunning: () => false,
      };
    });

    await monitorTelegramProvider({ token: "tok" });

    expect(api.deleteWebhook).toHaveBeenCalledWith({ drop_pending_updates: false });
    expect(order).toEqual(["deleteWebhook", "run"]);
  });

  it("retries recoverable deleteWebhook failures before polling", async () => {
    const cleanupError = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect timeout"), {
        code: "UND_ERR_CONNECT_TIMEOUT",
      }),
    });
    api.deleteWebhook.mockReset();
    api.deleteWebhook.mockRejectedValueOnce(cleanupError).mockResolvedValueOnce(true);
    runSpy.mockImplementationOnce(() => ({
      task: () => Promise.resolve(),
      stop: vi.fn(),
      isRunning: () => false,
    }));

    await monitorTelegramProvider({ token: "tok" });

    expect(api.deleteWebhook).toHaveBeenCalledTimes(2);
    expect(computeBackoff).toHaveBeenCalled();
    expect(sleepWithAbort).toHaveBeenCalled();
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it("retries setup-time recoverable errors before starting polling", async () => {
    const setupError = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect timeout"), {
        code: "UND_ERR_CONNECT_TIMEOUT",
      }),
    });
    createTelegramBotErrors.push(setupError);

    runSpy.mockImplementationOnce(() => ({
      task: () => Promise.resolve(),
      stop: vi.fn(),
      isRunning: () => false,
    }));

    await monitorTelegramProvider({ token: "tok" });

    expect(computeBackoff).toHaveBeenCalled();
    expect(sleepWithAbort).toHaveBeenCalled();
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it("awaits runner.stop before retrying after recoverable polling error", async () => {
    const recoverableError = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect timeout"), {
        code: "UND_ERR_CONNECT_TIMEOUT",
      }),
    });
    let firstStopped = false;
    const firstStop = vi.fn(async () => {
      await Promise.resolve();
      firstStopped = true;
    });

    runSpy
      .mockImplementationOnce(() => ({
        task: () => Promise.reject(recoverableError),
        stop: firstStop,
        isRunning: () => false,
      }))
      .mockImplementationOnce(() => {
        expect(firstStopped).toBe(true);
        return {
          task: () => Promise.resolve(),
          stop: vi.fn(),
          isRunning: () => false,
        };
      });

    await monitorTelegramProvider({ token: "tok" });

    expect(firstStop).toHaveBeenCalled();
    expect(computeBackoff).toHaveBeenCalled();
    expect(sleepWithAbort).toHaveBeenCalled();
    expect(runSpy).toHaveBeenCalledTimes(2);
  });

  it("surfaces non-recoverable errors", async () => {
    runSpy.mockImplementationOnce(() => ({
      task: () => Promise.reject(new Error("bad token")),
      stop: vi.fn(),
      isRunning: (): boolean => false,
    }));

    await expect(monitorTelegramProvider({ token: "tok" })).rejects.toThrow("bad token");
  });

  it("force-restarts polling when unhandled network rejection stalls runner", async () => {
    let running = true;
    let releaseTask: (() => void) | undefined;
    const stop = vi.fn(async () => {
      running = false;
      releaseTask?.();
    });

    runSpy
      .mockImplementationOnce(() => ({
        task: () =>
          new Promise<void>((resolve) => {
            releaseTask = resolve;
          }),
        stop,
        isRunning: () => running,
      }))
      .mockImplementationOnce(() => ({
        task: () => Promise.resolve(),
        stop: vi.fn(),
        isRunning: () => false,
      }));

    const monitor = monitorTelegramProvider({ token: "tok" });
    await vi.waitFor(() => expect(runSpy).toHaveBeenCalledTimes(1));

    expect(emitUnhandledRejection(new TypeError("fetch failed"))).toBe(true);
    await monitor;

    expect(stop.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(computeBackoff).toHaveBeenCalled();
    expect(sleepWithAbort).toHaveBeenCalled();
    expect(runSpy).toHaveBeenCalledTimes(2);
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
