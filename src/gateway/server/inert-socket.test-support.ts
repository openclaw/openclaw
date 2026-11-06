import { vi } from "vitest";
import type { GatewayConnectionTransport } from "./connection-transport.js";

export function createInertGatewayTestSocket<Send extends GatewayConnectionTransport["send"]>(
  send: Send,
) {
  return {
    readyState: 1,
    bufferedAmount: 0,
    send,
    close: vi.fn(),
    terminate: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
  };
}
