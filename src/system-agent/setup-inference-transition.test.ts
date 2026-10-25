import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import type { ConfigWriteOptions } from "../config/io.js";
import { createConfigWriteSafetyRejectionError } from "../config/io.write-errors.js";
import { getRuntimeConfigWriteApplication } from "../config/runtime-write-application.js";
import type { RuntimeConfigWriteApplicationStatus as ApplicationStatus } from "../config/runtime-write-application.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { commitSetupInferenceActivation } from "./setup-inference-transition.js";

it.each([
  { status: "applied", requireApplied: true, outcome: "applied" },
  { status: "restart-pending", requireApplied: true, outcome: "restored" },
  { status: "applied-restart-required", requireApplied: true, outcome: "restored" },
  { status: "restart-pending", requireApplied: undefined, outcome: "restart" },
] as const)(
  "settles $status (requireApplied=$requireApplied) as $outcome",
  async ({ status, requireApplied, outcome }) => {
    const before: OpenClawConfig = {};
    const candidate: OpenClawConfig = { agents: { defaults: { model: "openai/fixture" } } };
    let current = before;
    const completion: { run?: () => Promise<boolean> } = {};
    const settle = async (options: ConfigWriteOptions, result: ApplicationStatus) => {
      const claim = getRuntimeConfigWriteApplication(options)?.claim();
      assert(claim, "Missing config application receipt");
      await claim.prepare?.(() => {});
      claim.settle(result);
    };
    await commitSetupInferenceActivation({
      config: candidate,
      requireApplied,
      configTarget: {
        read: async () => ({ config: current, write: async () => current }),
        write: async (next, { writeOptions, captureUndo }) => {
          captureUndo(async (options) => {
            current = before;
            await settle(options, "applied");
            return { config: current, written: true };
          });
          current = next;
          await settle(writeOptions, status);
          return next;
        },
      },
      assertCurrent: () => {},
      activate: async () => undefined,
      deferCompletion: (run) => {
        completion.run = run;
      },
    });
    assert(completion.run, "Missing activation completion");
    if (outcome === "restored") {
      await expect(completion.run()).rejects.toThrow(`did not complete activation (${status})`);
      expect(current).toEqual(before);
    } else {
      expect(await completion.run()).toBe(outcome === "restart");
      expect(current).toEqual(candidate);
    }
  },
);

it("keeps config safety diagnostics out of the recovery error shown to users", async () => {
  const config: OpenClawConfig = {};
  const recoveryError = createConfigWriteSafetyRejectionError({
    reasons: ["size-drop:3855->984"],
    rejectedPath: "/private/fixture/openclaw.json.rejected.fixture",
  });

  const activation = commitSetupInferenceActivation({
    config,
    configTarget: {
      read: async () => ({ config, write: async () => config }),
      write: async (_candidate, { captureUndo }) => {
        captureUndo(async () => {
          throw recoveryError;
        });
        return config;
      },
    },
    assertCurrent: vi.fn(),
    activate: async () => ({
      rollback: vi.fn(),
      assertCurrent: () => {
        throw new Error("fixture activation failed");
      },
    }),
  });

  const error = await activation.catch((caught: unknown) => caught);
  assert(error instanceof AggregateError);
  expect(error).toMatchObject({
    message: `Activation failed and recovery could not complete. ${recoveryError.message}`,
  });
  expect(error.message).not.toMatch(/\/private\/fixture\/openclaw\.json|size-drop:/);
});
