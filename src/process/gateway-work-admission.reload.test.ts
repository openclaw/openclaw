import { afterEach, expect, it, vi } from "vitest";
import * as original from "./gateway-work-admission.js";

afterEach(() => original.resetGatewayWorkAdmission());

it("shares waiting RPC roots across lazy module instances without excluding unrelated work", async () => {
  original.resetGatewayWorkAdmission();
  vi.resetModules();
  const replacement = await import("./gateway-work-admission.js");
  expect(replacement.runWithGatewayReloadWaitingRoot).not.toBe(
    original.runWithGatewayReloadWaitingRoot,
  );
  const writer = original.tryBeginGatewayRootWorkAdmission("config.patch");
  const unrelated = original.tryBeginGatewayRootWorkAdmission("chat.send");
  if (!writer || !unrelated) {
    throw new Error("Expected request admission");
  }
  try {
    await writer.run(async () =>
      original.runWithGatewayReloadWaitingRoot(() =>
        replacement.runWithGatewayIndependentRootWorkAdmission(async () => {
          expect(original.getActiveGatewayRootWorkCount()).toBe(3);
          expect(original.getActiveGatewayRootWorkCount({ excludeCurrent: true })).toBe(1);
          expect(replacement.getActiveGatewayRootWorkCount({ excludeCurrent: true })).toBe(1);
        }, "reload:config"),
      ),
    );
    expect(original.getActiveGatewayRootWorkCount()).toBe(2);
  } finally {
    writer.release();
    unrelated.release();
  }
  expect(replacement.getActiveGatewayRootWorkCount()).toBe(0);
});
