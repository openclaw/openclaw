import { expect, it, vi } from "vitest";
import {
  captureGatewayServiceRebind,
  currentGatewayServiceRebindReceipt,
  settleGatewayServiceRebind,
  fingerprintGatewayServiceDefinition,
  withGatewayServiceRebindCapture,
} from "./service-rebind.js";
import type { GatewayServiceCommandConfig } from "./service-types.js";

it.each([
  { scenario: "failed-after-write", pinned: false },
  { scenario: "mismatch", pinned: false },
  { scenario: "revoked", pinned: false },
  { scenario: "success", pinned: true },
  { scenario: "pin-raced", pinned: true },
  { scenario: "pre-write", pinned: true },
  { scenario: "compensated", pinned: true },
])(
  "records only admitted rebind evidence: $scenario (pinned=$pinned)",
  async ({ scenario, pinned }) => {
    const original: GatewayServiceCommandConfig = {
      programArguments: ["/nodeA", "/A/openclaw.mjs"],
    };
    let command = original;
    const before = await fingerprintGatewayServiceDefinition(original);
    const originalPin = "a".repeat(64);
    let pin = scenario === "pin-raced" ? "c".repeat(64) : originalPin;
    const failure = new Error(
      scenario === "pre-write" ? "pre-write refused" : "native load failed",
    );
    const mutate = vi.fn(async () => {
      if (scenario === "pre-write") {
        throw failure;
      }
      command = { programArguments: ["/nodeB", "/B/openclaw.mjs"] };
      pin = "b".repeat(64);
      if (scenario === "failed-after-write" || scenario === "compensated") {
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
                  expect(currentGatewayServiceRebindReceipt()).toEqual({
                    before,
                    after: await fingerprintGatewayServiceDefinition(command),
                    mutated: true,
                    runtimePinBefore: originalPin,
                    runtimePinAfter: "b".repeat(64),
                  });
                  expect(currentGatewayServiceRebindReceipt()?.after).not.toBe(before);
                  command = original;
                  pin = originalPin;
                  throw error;
                }
              })
            : capture();
        if (scenario === "success") {
          await operation;
        } else if (["failed-after-write", "pre-write", "compensated"].includes(scenario)) {
          await expect(operation).rejects.toBe(failure);
        } else {
          await expect(operation).rejects.toThrow(
            scenario === "revoked"
              ? "owner revoked"
              : scenario === "pin-raced"
                ? "runtime intent changed"
                : "definition changed",
          );
        }
        if (["mismatch", "revoked", "pin-raced"].includes(scenario)) {
          expect(currentGatewayServiceRebindReceipt()).toBeUndefined();
          expect(mutate).not.toHaveBeenCalled();
        } else {
          expect(currentGatewayServiceRebindReceipt()).toEqual({
            before,
            after: await fingerprintGatewayServiceDefinition(command),
            ...(scenario === "pre-write" ? {} : { mutated: true }),
            ...(pinned ? { runtimePinBefore: originalPin, runtimePinAfter: pin } : {}),
          });
          expect(mutate).toHaveBeenCalledOnce();
        }
      },
      pinned ? originalPin : undefined,
    );
    expect(currentGatewayServiceRebindReceipt()).toBeUndefined();
  },
);
