import type { MsgContext } from "../../../auto-reply/templating.js";
import { buildDispatchInboundCaptureMock } from "./dispatch-inbound-capture.js";

export type InboundContextCapture = {
  ctx: MsgContext | undefined;
};

export function createInboundContextCapture(): InboundContextCapture {
  return { ctx: undefined };
}

export async function buildDispatchInboundContextCapture(
  importOriginal: <T extends Record<string, unknown>>() => Promise<T>,
  capture: InboundContextCapture,
) {
  const actual = await importOriginal<typeof import("../../../auto-reply/dispatch.js")>();
  return buildDispatchInboundCaptureMock(actual, (ctx) => {
    capture.ctx = ctx as MsgContext;
  });
}
