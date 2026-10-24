import { expect, it, vi } from "vitest";
import {
  captureGatewayServiceRebind,
  currentGatewayServiceRebindReceipt,
  settleGatewayServiceRebind,
  fingerprintGatewayServiceDefinition,
  withGatewayServiceRebindCapture,
} from "./service-rebind.js";

it("retains both the operation and final rebind observation failures", async () => {
  const command = { programArguments: ["/node", "/openclaw.mjs"] };
  const before = await fingerprintGatewayServiceDefinition(command);
  const operationFailure = new Error("native operation failed");
  const cleanupFailure = new Error("final authority revoked");
  await withGatewayServiceRebindCapture(before, async () => {
    let retired = false;
    const assertCurrent = () => {
      if (retired) {
        throw cleanupFailure;
      }
    };
    const work = settleGatewayServiceRebind(assertCurrent, async () => {
      await captureGatewayServiceRebind(
        async () => command,
        assertCurrent,
        async () => {},
      );
      retired = true;
      throw operationFailure;
    });
    await expect(work).rejects.toMatchObject({
      message: "Service rebind settlement could not be verified.",
      errors: [operationFailure, cleanupFailure],
      cause: cleanupFailure,
    });
    expect(currentGatewayServiceRebindReceipt()).toBeUndefined();
  });
});

it.each<[string, boolean, string?]>([
  ["failed-after-write", false],
  ["mismatch", false, "definition changed"],
  ["revoked", false, "owner revoked"],
  ["success", true],
  ["pin-raced", true, "runtime intent changed"],
  ["pre-write", true],
  ["compensated", true],
])("records admitted rebind evidence: %s (pinned=%s)", async (scenario, pinned, refusal) => {
  const original = { programArguments: ["/nodeA", "/A/openclaw.mjs"] };
  let command = original;
  const before = await fingerprintGatewayServiceDefinition(original);
  const originalPin = "a".repeat(64);
  let pin = scenario === "pin-raced" ? "c".repeat(64) : originalPin;
  const failure = new Error(scenario === "pre-write" ? "pre-write refused" : "native load failed");
  const expectReceipt = async (mutated = true) => {
    expect(currentGatewayServiceRebindReceipt()).toEqual({
      before,
      after: await fingerprintGatewayServiceDefinition(command),
      ...(mutated ? { mutated: true } : {}),
      ...(pinned ? { runtimePinBefore: originalPin, runtimePinAfter: pin } : {}),
    });
  };
  const mutate = vi.fn(async () => {
    if (scenario !== "pre-write") {
      command = { programArguments: ["/nodeB", "/B/openclaw.mjs"] };
      pin = "b".repeat(64);
    }
    if (scenario !== "success") {
      throw failure;
    }
  });
  const assertCurrent = () => {
    if (scenario === "revoked") {
      throw new Error("owner revoked");
    }
  };
  await withGatewayServiceRebindCapture(
    before,
    async () => {
      if (scenario === "mismatch") {
        command.programArguments.push("--foreign");
      }
      const capture = () =>
        captureGatewayServiceRebind(
          async () => command,
          assertCurrent,
          mutate,
          pinned ? () => pin : undefined,
        );
      const operation =
        scenario === "compensated"
          ? settleGatewayServiceRebind(assertCurrent, async () => {
              try {
                await capture();
              } catch (error) {
                await expectReceipt();
                expect(currentGatewayServiceRebindReceipt()?.after).not.toBe(before);
                command = original;
                pin = originalPin;
                throw error;
              }
            })
          : capture();
      if (refusal) {
        await expect(operation).rejects.toThrow(refusal);
        expect(currentGatewayServiceRebindReceipt()).toBeUndefined();
        expect(mutate).not.toHaveBeenCalled();
      } else {
        if (scenario === "success") {
          await operation;
        } else {
          await expect(operation).rejects.toBe(failure);
        }
        await expectReceipt(scenario !== "pre-write");
        expect(mutate).toHaveBeenCalledOnce();
      }
    },
    pinned ? originalPin : undefined,
  );
  expect(currentGatewayServiceRebindReceipt()).toBeUndefined();
});
