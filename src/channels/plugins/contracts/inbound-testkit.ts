import { vi } from "vitest";
import type { MsgContext } from "../../../auto-reply/templating.js";

export type InboundContextCapture = {
  ctx: MsgContext | undefined;
};

export function createInboundContextCapture(): InboundContextCapture {
  return { ctx: undefined };
}

export function buildDispatchInboundCaptureMock<T extends Record<string, unknown>>(
  actual: T,
  setCtx: (ctx: unknown) => void,
) {
  const dispatchInboundMessage = vi.fn(async (params: { ctx: unknown }) => {
    setCtx(params.ctx);
    return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
  });

  return {
    ...actual,
    dispatchInboundMessage,
    dispatchInboundMessageWithDispatcher: dispatchInboundMessage,
    dispatchInboundMessageWithBufferedDispatcher: dispatchInboundMessage,
  };
}

export async function buildDispatchInboundContextCapture(
  loadActual: <T extends Record<string, unknown>>() => Promise<T>,
  capture: InboundContextCapture,
) {
  const actual = await loadActual<typeof import("../../../auto-reply/dispatch.js")>();
  return buildDispatchInboundCaptureMock(actual, (ctx) => {
    capture.ctx = ctx as MsgContext;
  });
}

export const inboundCtxCapture = createInboundContextCapture();
