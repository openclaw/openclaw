import { afterEach, expect, it, vi } from "vitest";
import {
  captureGatewayServiceRebind,
  currentGatewayServiceRebindReceipt,
  fingerprintGatewayServiceDefinition,
  withGatewayServiceRebindCapture,
} from "./service-rebind.js";
import type { GatewayServiceCommandConfig } from "./service-types.js";
afterEach(() => vi.restoreAllMocks());

it.each(["success", "failed-after-write", "mismatch", "revoked"] as const)(
  "captures only admitted original definition rewrite: %s",
  async (scenario) => {
    let command: GatewayServiceCommandConfig = { programArguments: ["/node", "/A/openclaw.mjs"] };
    const before = await fingerprintGatewayServiceDefinition(command);
    const mutate = vi.fn(async () => {
      command = { programArguments: ["/node", "/B/openclaw.mjs"] };
      if (scenario === "failed-after-write") {
        throw new Error("native load failed");
      }
    });
    const assertCurrent = () => {
      if (scenario === "revoked") {
        throw new Error("owner revoked");
      }
    };
    await withGatewayServiceRebindCapture(before, async () => {
      if (scenario === "mismatch") {
        command.programArguments.push("--foreign");
      }
      const work = captureGatewayServiceRebind(async () => command, assertCurrent, mutate);
      if (scenario === "success") {
        await work;
      } else {
        await expect(work).rejects.toThrow();
      }
      const receipt = currentGatewayServiceRebindReceipt();
      if (scenario === "success" || scenario === "failed-after-write") {
        expect(receipt).toEqual({
          before,
          after: await fingerprintGatewayServiceDefinition(command),
        });
        expect(mutate).toHaveBeenCalledOnce();
      } else {
        expect(receipt).toBeUndefined();
        expect(mutate).not.toHaveBeenCalled();
      }
    });
    expect(currentGatewayServiceRebindReceipt()).toBeUndefined();
  },
);
