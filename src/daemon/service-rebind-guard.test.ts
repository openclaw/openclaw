import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { resolveNodeService } from "./node-service.js";
import {
  captureGatewayServiceRebind as captureRebind,
  currentGatewayServiceRebindReceipt as receipt,
  settleGatewayServiceRebind as settleRebind,
  fingerprintGatewayServiceDefinition as fingerprint,
  withGatewayServiceRebindCapture as withRebind,
} from "./service-rebind.js";
import type { GatewayServiceCommandConfig, GatewayServiceInstallArgs } from "./service-types.js";
import { resolveGatewayService } from "./service.js";
import { mockSystemAccountHome } from "./service.test-helpers.js";
import { seedCompletedRuntimePinMigration } from "./test-helpers/service-audit-runtime-pin.js";
const leaves = vi.hoisted(() => ({ install: vi.fn(), read: vi.fn(), config: vi.fn() }));
vi.mock("./launchd.js", async (original) => ({
  ...(await original<typeof import("./launchd.js")>()),
  installLaunchAgent: leaves.install,
  readLaunchAgentProgramArguments: leaves.read,
}));
vi.mock("./future-config-guard.js", () => ({ assertFutureConfigActionAllowed: leaves.config }));
afterEach(() => vi.restoreAllMocks());
const defaultIdentity = {
  OPENCLAW_HOME: undefined,
  OPENCLAW_PROFILE: undefined,
  OPENCLAW_LAUNCHD_LABEL: undefined,
  OPENCLAW_SYSTEMD_UNIT: undefined,
  OPENCLAW_WINDOWS_TASK_NAME: undefined,
};
it.each(
  (["gateway", "node"] as const).flatMap((kind) =>
    (["success", "config-revoked", "definition-raced"] as const).map((scenario) => ({
      kind,
      scenario,
    })),
  ),
)("guards the admitted $kind native rebind: $scenario", async ({ kind, scenario }) => {
  await withOpenClawTestState({ layout: kind === "node" ? "split" : "home" }, async (state) => {
    await seedCompletedRuntimePinMigration(state.env);
    mockProcessPlatform("darwin");
    Object.assign(state.envVars, defaultIdentity);
    state.applyEnv();
    mockSystemAccountHome();
    const env = { ...state.env, ...defaultIdentity };
    let current = true;
    let command: GatewayServiceCommandConfig = { programArguments: ["/node", "/A/openclaw.mjs"] };
    leaves.read.mockImplementation(async () => command);
    leaves.config.mockImplementation(async () => {
      current = scenario !== "config-revoked";
    });
    leaves.install.mockReset().mockImplementation(async (args: GatewayServiceInstallArgs) => {
      args.assertCurrent?.();
      expect(args.preserveAutoStart).toBe(true);
      command = { programArguments: args.programArguments };
    });
    const before = await fingerprint(command);
    await withRebind(before, async () => {
      const service = kind === "node" ? resolveNodeService() : resolveGatewayService();
      const work = service.install({
        env,
        stdout: new PassThrough(),
        programArguments: ["/node", "/B/openclaw.mjs"],
        assertCurrent: () => {
          if (!current) {
            throw new Error("revoked");
          }
        },
        beforeMutation: async () => {
          if (scenario === "definition-raced") {
            command.programArguments.push("--foreign");
          }
        },
      });
      if (scenario === "success") {
        await work;
        expect(receipt()).toEqual({
          before,
          after: await fingerprint(command),
          mutated: true,
          runtimePinBefore: expect.stringMatching(/^[a-f0-9]{64}$/),
          runtimePinAfter: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
      } else {
        await expect(work).rejects.toThrow(
          scenario === "config-revoked" ? "revoked" : "definition changed before rebind",
        );
        expect(leaves.install).not.toHaveBeenCalled();
        expect(receipt()).toBeUndefined();
      }
    });
  });
});
it("ordinary native installation retains its default enable behavior", async () => {
  await captureRebind(
    async () => null,
    () => {},
    async (preserveAutoStart) => {
      expect(preserveAutoStart).toBe(false);
    },
  );
});

it.each<[string, boolean, string?]>([
  ["failed-after-write", false],
  ["revoked", false, "owner revoked"],
  ["pin-raced", true, "runtime intent changed"],
  ["pre-write", true],
  ["compensated", true],
  ["final-revoked", false],
])("records admitted rebind evidence: %s (pinned=%s)", async (scenario, pinned, refusal) => {
  const original = { programArguments: ["/nodeA", "/A/openclaw.mjs"] };
  let command = original;
  const before = await fingerprint(original);
  const originalPin = "a".repeat(64);
  let pin = scenario === "pin-raced" ? "c".repeat(64) : originalPin;
  const failure = new Error(scenario === "pre-write" ? "pre-write refused" : "native load failed");
  const cleanupFailure = new Error("final authority revoked");
  let retired = false;
  const expectReceipt = async (mutated = true) => {
    expect(receipt()).toEqual({
      before,
      after: await fingerprint(command),
      ...(mutated ? { mutated: true } : {}),
      ...(pinned ? { runtimePinBefore: originalPin, runtimePinAfter: pin } : {}),
    });
  };
  const mutate = vi.fn(async () => {
    if (scenario !== "final-revoked") {
      if (scenario !== "pre-write") {
        command = { programArguments: ["/nodeB", "/B/openclaw.mjs"] };
        pin = "b".repeat(64);
      }
      throw failure;
    }
  });
  const assertCurrent = () => {
    if (retired || scenario === "revoked") {
      throw retired ? cleanupFailure : new Error("owner revoked");
    }
  };
  await withRebind(
    before,
    async () => {
      const capture = () =>
        captureRebind(async () => command, assertCurrent, mutate, pinned ? () => pin : undefined);
      const operation =
        scenario === "compensated" || scenario === "final-revoked"
          ? settleRebind(assertCurrent, async () => {
              await capture().catch(async (error: unknown) => {
                await expectReceipt();
                command = original;
                pin = originalPin;
                throw error;
              });
              retired = true;
              throw failure;
            })
          : capture();
      if (scenario === "final-revoked") {
        await expect(operation).rejects.toMatchObject({
          errors: [failure, cleanupFailure],
          cause: cleanupFailure,
        });
        expect(receipt()).toBeUndefined();
      } else if (refusal) {
        await expect(operation).rejects.toThrow(refusal);
        expect(receipt()).toBeUndefined();
        expect(mutate).not.toHaveBeenCalled();
      } else {
        await expect(operation).rejects.toBe(failure);
        await expectReceipt(scenario !== "pre-write");
      }
    },
    pinned ? originalPin : undefined,
  );
  expect(receipt()).toBeUndefined();
});
