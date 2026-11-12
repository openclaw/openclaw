import { describe, expect, it, vi } from "vitest";
import type { ConfigWriteOptions } from "../config/io.js";
import { createConfigWriteSafetyRejectionError } from "../config/io.write-errors.js";
import { getRuntimeConfigWriteApplication } from "../config/runtime-write-application.js";
import type { RuntimeConfigWriteApplicationStatus } from "../config/runtime-write-application.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { commitSetupInferenceActivation } from "./setup-inference-transition.js";

describe("setup inference activation recovery", () => {
  it.each([
    { status: "applied", requireApplied: true, outcome: "applied" },
    { status: "restart-pending", requireApplied: true, outcome: "restored" },
    { status: "applied-restart-required", requireApplied: true, outcome: "restored" },
    { status: "restart-pending", requireApplied: undefined, outcome: "restart" },
    {
      status: {
        status: "deferred",
        reason: "Plugin fixture is busy.",
        appliesWhen: "Wait for retained work.",
      },
      requireApplied: true,
      outcome: "restored",
    },
  ] as const)(
    "settles $status with requireApplied=$requireApplied as $outcome",
    async ({ status, requireApplied, outcome }) => {
      const before: OpenClawConfig = {};
      const candidate: OpenClawConfig = { agents: { defaults: { model: "openai/fixture" } } };
      let current = before;
      const completion: { run?: () => Promise<boolean> } = {};
      const settle = async (
        options: ConfigWriteOptions,
        result: RuntimeConfigWriteApplicationStatus,
      ) => {
        const claim = getRuntimeConfigWriteApplication(options)?.claim();
        if (!claim) {
          throw new Error("Missing config application receipt");
        }
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
      if (!completion.run) {
        throw new Error("Missing activation completion");
      }
      if (outcome === "restored") {
        await expect(completion.run()).rejects.toThrow(
          typeof status === "object" ? status.reason : `did not complete activation (${status})`,
        );
        expect(current).toEqual(before);
      } else {
        expect(await completion.run()).toBe(outcome === "restart");
        expect(current).toEqual(candidate);
      }
    },
  );

  it("never activates deferred credentials and reports a deferred recovery reason", async () => {
    const activate = vi.fn();
    let complete!: () => Promise<boolean>;
    const deferred = {
      status: "deferred" as const,
      reason: "Plugin fixture still has work.",
      appliesWhen: "Applies when retained work settles.",
    };
    await commitSetupInferenceActivation({
      config: {},
      requireApplied: true,
      assertCurrent: () => {},
      activate,
      deferCompletion: (run) => {
        complete = run;
      },
      configTarget: {
        read: async () => ({ config: {}, write: async () => ({}) }),
        write: async (config, { writeOptions, captureUndo }) => {
          captureUndo(async (options) => {
            getRuntimeConfigWriteApplication(options)?.claim()?.settle(deferred);
            return { config: {}, written: true };
          });
          getRuntimeConfigWriteApplication(writeOptions)?.claim()?.settle(deferred);
          return config;
        },
      },
    });
    await expect(complete()).rejects.toThrow(deferred.reason);
    expect(activate).not.toHaveBeenCalled();
  });

  it("keeps config safety diagnostics out of the recovery error shown to users", async () => {
    const config = { gateway: { mode: "local" } } satisfies OpenClawConfig;
    const diagnosticPath = "/private/fixture/openclaw.json";
    const rejectedPath = `${diagnosticPath}.rejected.fixture`;
    const recoveryError = createConfigWriteSafetyRejectionError({
      reasons: ["size-drop:3855->984"],
      rejectedPath,
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
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({
      message: `Activation failed and recovery could not complete. ${recoveryError.message}`,
    });
    expect((error as Error).message).not.toContain(diagnosticPath);
    expect((error as Error).message).not.toContain(rejectedPath);
    expect((error as Error).message).not.toContain("size-drop:");
  });
});
