import { describe, expect, it, vi } from "vitest";
import { createConfigWriteSafetyRejectionError } from "../config/io.write-errors.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { commitSetupInferenceActivation } from "./setup-inference-transition.js";

describe("setup inference activation recovery", () => {
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
