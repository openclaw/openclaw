import { vi } from "vitest";
import {
  buildDispatchInboundContextCapture,
  createInboundContextCapture,
} from "./inbound-contract-capture.js";

export const inboundCtxCapture = createInboundContextCapture();

vi.mock("../../src/auto-reply/dispatch.js", async (importOriginal) => {
  return buildDispatchInboundContextCapture(importOriginal, inboundCtxCapture);
});
