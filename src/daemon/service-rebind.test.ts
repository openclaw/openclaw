import { afterEach, expect, it, vi } from "vitest";
import {
  captureGatewayServiceRebind,
  currentGatewayServiceRebindReceipt,
  settleGatewayServiceRebind,
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
          mutated: true,
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

it.each(["success", "failed-after-write", "pin-raced"] as const)(
  "binds update-owned runtime intent changes: %s",
  async (scenario) => {
    let command: GatewayServiceCommandConfig = { programArguments: ["/nodeA", "/A/openclaw.mjs"] };
    const before = await fingerprintGatewayServiceDefinition(command);
    const originalPin = "a".repeat(64);
    let revision = scenario === "pin-raced" ? "c".repeat(64) : originalPin;
    const mutate = vi.fn(async () => {
      command = { programArguments: ["/nodeB", "/B/openclaw.mjs"] };
      revision = "b".repeat(64);
      if (scenario === "failed-after-write") {
        throw new Error("native load failed");
      }
    });
    await withGatewayServiceRebindCapture(
      before,
      async () => {
        const operation = captureGatewayServiceRebind(
          async () => command,
          () => {},
          mutate,
          () => revision,
        );
        if (scenario === "success") {
          await operation;
        } else {
          await expect(operation).rejects.toThrow(
            scenario === "pin-raced" ? "runtime intent changed" : "native load failed",
          );
        }
        if (scenario === "pin-raced") {
          expect(mutate).not.toHaveBeenCalled();
          expect(currentGatewayServiceRebindReceipt()).toBeUndefined();
        } else {
          expect(currentGatewayServiceRebindReceipt()).toEqual({
            before,
            after: await fingerprintGatewayServiceDefinition(command),
            mutated: true,
            runtimePinBefore: originalPin,
            runtimePinAfter: "b".repeat(64),
          });
        }
      },
      originalPin,
    );
  },
);

it("records an unchanged definition and pin after a pre-write refusal", async () => {
  const command = { programArguments: ["/node", "/A/openclaw.mjs"] };
  const before = await fingerprintGatewayServiceDefinition(command);
  const revision = "a".repeat(64);
  await withGatewayServiceRebindCapture(
    before,
    async () => {
      await expect(
        captureGatewayServiceRebind(
          async () => command,
          () => {},
          async () => {
            throw new Error("pre-write refused");
          },
          () => revision,
        ),
      ).rejects.toThrow("pre-write refused");
      expect(currentGatewayServiceRebindReceipt()).toEqual({
        before,
        after: before,
        runtimePinBefore: revision,
        runtimePinAfter: revision,
      });
    },
    revision,
  );
});

it("refreshes native rewrite evidence after surrounding installer compensation", async () => {
  const original = { programArguments: ["/nodeA", "/A/openclaw.mjs"] };
  let command = original;
  const before = await fingerprintGatewayServiceDefinition(original);
  const pinBefore = "a".repeat(64);
  let pin = pinBefore;
  const failure = new Error("activation failed");
  await withGatewayServiceRebindCapture(
    before,
    async () => {
      await expect(
        settleGatewayServiceRebind(
          () => {},
          async () => {
            try {
              await captureGatewayServiceRebind(
                async () => command,
                () => {},
                async () => {
                  command = { programArguments: ["/nodeB", "/B/openclaw.mjs"] };
                  pin = "b".repeat(64);
                  throw failure;
                },
                () => pin,
              );
            } catch (error) {
              expect(currentGatewayServiceRebindReceipt()?.after).not.toBe(before);
              command = original;
              pin = pinBefore;
              throw error;
            }
          },
        ),
      ).rejects.toBe(failure);
      expect(currentGatewayServiceRebindReceipt()).toEqual({
        before,
        after: before,
        mutated: true,
        runtimePinBefore: pinBefore,
        runtimePinAfter: pinBefore,
      });
    },
    pinBefore,
  );
});
