import { vi } from "vitest";
import type { createStorageMock } from "../test-helpers/storage.ts";

export const wsInstances: MockWebSocket[] = [];

type HandlerMap = {
  close: MockWebSocketHandler[];
  error: MockWebSocketHandler[];
  message: MockWebSocketHandler[];
  open: MockWebSocketHandler[];
};

type MockWebSocketHandler = (ev?: { code?: number; data?: string; reason?: string }) => void;

export class MockWebSocket {
  static OPEN = 1;

  readonly handlers: HandlerMap = {
    close: [],
    error: [],
    message: [],
    open: [],
  };

  readonly sent: string[] = [];
  lastClose: { code?: number; reason?: string } | null = null;
  readyState = MockWebSocket.OPEN;

  constructor(_url: string) {
    wsInstances.push(this);
  }

  addEventListener(type: keyof HandlerMap, handler: MockWebSocketHandler) {
    this.handlers[type].push(handler);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.lastClose = { code, reason };
    this.readyState = 3;
  }

  emitClose(code = 1000, reason = "") {
    for (const handler of this.handlers.close) {
      handler({ code, reason });
    }
  }

  emitOpen() {
    for (const handler of this.handlers.open) {
      handler();
    }
  }

  emitMessage(data: unknown) {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    for (const handler of this.handlers.message) {
      handler({ data: payload });
    }
  }
}

export function stubWindowGlobals(storage?: ReturnType<typeof createStorageMock>) {
  vi.stubGlobal("window", {
    location: { href: "http://127.0.0.1:18789/" },
    localStorage: storage,
    setTimeout: (handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => {
      // Keep connect debounce behavior testable without paying real 750ms waits per handshake.
      const effectiveTimeout = timeout === 750 ? 0 : timeout;
      return globalThis.setTimeout(() => handler(...args), effectiveTimeout);
    },
    clearTimeout: (timeoutId: number | undefined) => globalThis.clearTimeout(timeoutId),
  });
}

export function getLatestWebSocket(): MockWebSocket {
  const ws = wsInstances.at(-1);
  if (!ws) {
    throw new Error("missing websocket instance");
  }
  return ws;
}

export function useNodeFakeTimers() {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
}
