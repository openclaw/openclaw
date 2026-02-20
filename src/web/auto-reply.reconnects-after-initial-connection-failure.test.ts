import "./test-helpers.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: vi.fn(),
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
}));

import { resetInboundDedupe } from "../auto-reply/reply/inbound-dedupe.js";
import { resetLogger, setLoggerOverride } from "../logging.js";
import { monitorWebChannel } from "./auto-reply.js";
import { resetBaileysMocks, resetLoadConfigMock } from "./test-helpers.js";

let previousHome: string | undefined;
let tempHome: string | undefined;

const rmDirWithRetries = async (dir: string): Promise<void> => {
  // Some tests can leave async session-store writes in-flight; recursive deletion can race and throw ENOTEMPTY.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: unknown }).code)
          : null;
      if (code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM") {
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      throw err;
    }
  }

  await fs.rm(dir, { recursive: true, force: true });
};

beforeEach(async () => {
  resetInboundDedupe();
  previousHome = process.env.HOME;
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-web-home-"));
  process.env.HOME = tempHome;
});

afterEach(async () => {
  process.env.HOME = previousHome;
  if (tempHome) {
    await rmDirWithRetries(tempHome);
    tempHome = undefined;
  }
});

describe("web auto-reply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBaileysMocks();
    resetLoadConfigMock();
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    vi.useRealTimers();
  });

  it("retries after initial connection failure", async () => {
    const sleep = vi.fn(async () => {});
    let attempts = 0;
    const closeResolvers: Array<(reason?: unknown) => void> = [];
    const listenerFactory = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("ENOTFOUND web.whatsapp.com");
      }
      let resolveClose: (reason?: unknown) => void = () => {};
      const onClose = new Promise<unknown>((res) => {
        resolveClose = res;
        closeResolvers.push(res);
      });
      return {
        close: vi.fn(),
        onClose,
        signalClose: (reason?: unknown) => resolveClose(reason),
      };
    });
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const controller = new AbortController();
    let runError: unknown = null;
    const run = monitorWebChannel(
      false,
      listenerFactory,
      true,
      async () => ({ text: "ok" }),
      runtime as never,
      controller.signal,
      {
        heartbeatSeconds: 1,
        reconnect: { initialMs: 10, maxMs: 10, maxAttempts: 3, factor: 1.1, jitter: 0 },
        sleep,
      },
    ).catch((err) => {
      runError = err;
    });

    await vi.waitFor(() => expect(listenerFactory).toHaveBeenCalledTimes(2), {
      timeout: 1000,
    });
    expect(sleep).toHaveBeenCalled();
    expect(listenerFactory).toHaveBeenCalledTimes(2);
    expect(runError).toBeNull();

    controller.abort();
    closeResolvers[0]?.({ status: 499, isLoggedOut: false });
    await run;
  });
});
